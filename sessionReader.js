'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

/** Папка с сессиями Claude Code по умолчанию. */
function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Достаём читаемый текст из поля content сообщения (строка или массив блоков). */
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
        parts.push('🖼 [изображение]');
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
        // мысли не показываем в ленте
        break;
      default:
        break;
    }
  }
  return parts.join('\n').trim();
}

/**
 * Настоящая ли это реплика пользователя.
 * В JSONL роль user несут ещё и tool_result'ы с вложениями — это пломбинг агента,
 * а не то, что человек напечатал. Реплика считается настоящей только если в ней
 * есть непустой text-блок, не являющийся служебной обёрткой.
 */
function hasRealUserText(content) {
  if (typeof content === 'string') return content.trim().length > 0 && !isNoiseText(content);
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() && !isNoiseText(b.text)
  );
}

/** Из реплики пользователя берём только то, что он действительно написал. */
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

/** Служебные обёртки, которые не стоит показывать как реплики пользователя. */
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
 * Быстро читает метаданные одной сессии, не загружая весь файл.
 * Стримит строки с бюджетом байт и останавливается, когда нашёл главное.
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

    const BYTE_BUDGET = 512 * 1024; // 512 КБ головы файла хватает для метаданных
    let bytesRead = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const finish = () => {
      try { rl.close(); } catch {}
      try { stream.destroy(); } catch {}
      meta.title = meta.aiTitle || meta.firstPrompt || 'Без названия';
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

      // Достаточно данных — можно закончить рано.
      if (meta.aiTitle && meta.firstPrompt && meta.cwd) finish();
      else if (bytesRead > BYTE_BUDGET) finish();
    });

    rl.on('close', () => finish());
    stream.on('error', () => finish());
  });
}

/** Сканирует папку проектов и возвращает список сессий с метаданными. */
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
 * Загружает содержимое одного чата в виде списка реплик.
 * Ограничивает число сообщений, чтобы не подвесить UI на гигантских сессиях.
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
      if (o.isSidechain) return; // вложенные под-агенты не мешаем в основную ленту
      const msg = o.message;
      if (!msg) return;
      // Реплики пользователя показываем только настоящие: tool_result'ы и вложения,
      // которые тоже приходят с ролью user, в ленте не нужны.
      if (o.type === 'user' && !hasRealUserText(msg.content)) return;
      const text = o.type === 'user' ? extractUserText(msg.content) : extractText(msg.content);
      if (!text) return;

      // Реплика, состоящая только из вызовов инструментов, рисуется компактным чипом,
      // а не полноценным пузырём с заголовком.
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
