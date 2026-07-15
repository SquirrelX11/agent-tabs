'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

/** Default folder holding Claude Code sessions. */
function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Pull readable text out of a message's content (a string, or an array of blocks). */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text);
        break;
      case 'image':
        parts.push('🖼 [image]');
        break;
      case 'tool_use':
        parts.push(`🛠 ${block.name || 'tool'}`);
        break;
      case 'tool_result': {
        const c = block.content;
        let t = '';
        if (typeof c === 'string') t = c;
        else if (Array.isArray(c)) t = c.map((p) => (p && p.type === 'text' ? p.text : '')).join('');
        parts.push('↩︎ ' + t.slice(0, 600));
        break;
      }
      case 'thinking':
        // thinking blocks stay out of the transcript
        break;
      default:
        break;
    }
  }
  return parts.join('\n').trim();
}

/**
 * Whether this is something the human actually typed.
 * In the JSONL, the user role also carries tool_results and attachments — that's agent
 * plumbing, not conversation. A turn counts as real only if it has a non-empty text
 * block that isn't one of the wrapper tags.
 */
function hasRealUserText(content) {
  if (typeof content === 'string') return content.trim().length > 0 && !isNoiseText(content);
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() && !isNoiseText(b.text)
  );
}

/** Take only what the user actually wrote out of their turn. */
function extractUserText(content) {
  if (typeof content === 'string') return isNoiseText(content) ? '' : content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && !isNoiseText(b.text))
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Wrapper tags that shouldn't surface as user messages. */
function isNoiseText(text) {
  if (!text) return true;
  const t = text.trimStart();
  return (
    t.startsWith('<ide_') ||
    t.startsWith('<system-reminder') ||
    t.startsWith('<command-name') ||
    t.startsWith('<command-message') ||
    t.startsWith('<local-command') ||
    t.startsWith('Caveat:')
  );
}

/**
 * Read one session's metadata quickly, without loading the whole file.
 * Streams lines under a byte budget and stops as soon as it has what it needs.
 */
function readSessionMeta(filePath) {
  return new Promise((resolve) => {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return resolve(null);
    }

    const meta = {
      id: path.basename(filePath, '.jsonl'),
      file: filePath,
      title: '',
      aiTitle: '',
      firstPrompt: '',
      lastPrompt: '',
      cwd: '',
      gitBranch: '',
      mtime: stat.mtimeMs,
      size: stat.size,
      messageCount: 0,
    };

    const BYTE_BUDGET = 512 * 1024; // the first 512 KB is plenty for metadata
    let bytesRead = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const finish = () => {
      try { rl.close(); } catch {}
      try { stream.destroy(); } catch {}
      meta.title = meta.aiTitle || meta.firstPrompt || 'Untitled';
      resolve(meta);
    };

    rl.on('line', (line) => {
      bytesRead += line.length + 1;
      let o;
      try { o = JSON.parse(line); } catch { return; }

      if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
      if (o.gitBranch && o.gitBranch !== 'HEAD' && !meta.gitBranch) meta.gitBranch = o.gitBranch;

      if (o.type === 'ai-title' && o.aiTitle) {
        meta.aiTitle = o.aiTitle;
      } else if (o.type === 'last-prompt' && o.lastPrompt) {
        meta.lastPrompt = String(o.lastPrompt).slice(0, 200);
      } else if (o.type === 'user' && o.message && !o.isSidechain) {
        if (!meta.firstPrompt && hasRealUserText(o.message.content)) {
          meta.firstPrompt = extractUserText(o.message.content).slice(0, 200);
        }
      }

      // Got everything we need — stop early.
      if (meta.aiTitle && meta.firstPrompt && meta.cwd) finish();
      else if (bytesRead > BYTE_BUDGET) finish();
    });

    rl.on('close', () => finish());
    stream.on('error', () => finish());
  });
}

/** Scan the projects folder and return every session with its metadata. */
async function listSessions(projectsDir) {
  const dir = projectsDir || defaultProjectsDir();
  let projectDirs = [];
  try {
    projectDirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return { dir, sessions: [] };
  }

  const files = [];
  for (const pd of projectDirs) {
    let entries = [];
    try { entries = fs.readdirSync(pd); } catch { continue; }
    for (const name of entries) {
      if (name.endsWith('.jsonl')) files.push(path.join(pd, name));
    }
  }

  const metas = await Promise.all(files.map((f) => readSessionMeta(f)));
  const sessions = metas.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  return { dir, sessions };
}

/**
 * Load one chat as a list of turns.
 * Caps the message count so an enormous session can't stall the UI.
 */
function loadSession(filePath, maxMessages) {
  return new Promise((resolve) => {
    const limit = maxMessages || 800;
    const messages = [];
    const meta = { cwd: '', gitBranch: '', aiTitle: '' };
    let truncated = false;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const finish = () => {
      try { rl.close(); } catch {}
      try { stream.destroy(); } catch {}
      resolve({ meta, messages, truncated });
    };

    rl.on('line', (line) => {
      if (messages.length >= limit) {
        truncated = true;
        return finish();
      }
      let o;
      try { o = JSON.parse(line); } catch { return; }

      if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
      if (o.gitBranch && o.gitBranch !== 'HEAD' && !meta.gitBranch) meta.gitBranch = o.gitBranch;
      if (o.type === 'ai-title' && o.aiTitle) meta.aiTitle = o.aiTitle;

      if (o.type !== 'user' && o.type !== 'assistant') return;
      if (o.isSidechain) return; // keep nested sub-agents out of the main transcript
      const msg = o.message;
      if (!msg) return;
      // Only real user turns: tool_results and attachments also arrive with the user role,
      // and they don't belong in the transcript.
      if (o.type === 'user' && !hasRealUserText(msg.content)) return;
      const text = o.type === 'user' ? extractUserText(msg.content) : extractText(msg.content);
      if (!text) return;

      // A turn that is nothing but tool calls renders as a compact chip rather than
      // a full bubble with a speaker heading.
      const toolOnly = o.type === 'assistant' && text.split('\n').every((l) => l.startsWith('🛠'));

      messages.push({
        role: o.type,
        text,
        kind: toolOnly ? 'tool' : 'say',
        ts: o.timestamp || '',
      });
    });

    rl.on('close', finish);
    stream.on('error', finish);
  });
}

module.exports = { defaultProjectsDir, listSessions, loadSession };
