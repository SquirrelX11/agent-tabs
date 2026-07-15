'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { defaultProjectsDir, listSessions, loadSession } = require('./sessionReader');

let panel = null;
let watchers = [];
let refreshTimer = null;
// A chat picked before the webview finished booting; flushed once it reports 'ready'.
let pendingOpenId = null;

function getProjectsDir() {
  const cfg = vscode.workspace.getConfiguration('agentTabs').get('projectsDir');
  return cfg && cfg.trim() ? cfg.trim() : defaultProjectsDir();
}

function getMaxMessages() {
  return vscode.workspace.getConfiguration('agentTabs').get('maxMessagesPerChat') || 800;
}

function nonce() {
  let t = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  return t;
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('agentTabs.open', () => openPanel(context)),
    vscode.commands.registerCommand('agentTabs.refresh', () => sendSessions()),
    vscode.commands.registerCommand('agentTabs.quickOpen', () => quickOpen(context))
  );

  // One-click way in that's always on screen.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(comment-discussion) Chats';
  status.tooltip = 'Agent Tabs — pick a Claude Code chat';
  status.command = 'agentTabs.quickOpen';
  status.show();
  context.subscriptions.push(status);

  // In the Extension Development Host (F5), show the panel right away; otherwise it would
  // have to be summoned from the palette every run. A normal install waits for the command.
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    openPanel(context);
  }
}

// The Claude Code extension registers this as (sessionId, initialPrompt, viewColumn) and
// calls it that way internally. It is NOT a documented API, so treat it as best-effort:
// probe for it every time and fall back to the built-in viewer when it's missing.
const CLAUDE_OPEN_COMMAND = 'claude-vscode.editor.open';

async function claudeCodeAvailable() {
  const all = await vscode.commands.getCommands(true);
  return all.includes(CLAUDE_OPEN_COMMAND);
}

/**
 * Open the real, live Claude Code chat for a session.
 * Returns false if that isn't possible, so the caller can fall back.
 */
async function openInClaudeCode(sessionId) {
  if (!(await claudeCodeAvailable())) return false;
  try {
    await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, sessionId, undefined, vscode.ViewColumn.Active);
    return true;
  } catch (err) {
    console.error('Agent Tabs: handing off to Claude Code failed', err);
    return false;
  }
}

/** Cmd+P-style chat picker: bookmarks first, then everything by recency. */
async function quickOpen(context) {
  const { sessions } = await listSessions(getProjectsDir());
  sessionCache = sessions;

  if (sessions.length === 0) {
    vscode.window.showInformationMessage('Agent Tabs: no Claude Code sessions found in ' + getProjectsDir());
    return;
  }

  const bookmarked = new Set(context.globalState.get('bookmarks', []).map((b) => b.id));
  const titles = context.globalState.get('titles', {});
  const ordered = [
    ...sessions.filter((s) => bookmarked.has(s.id)),
    ...sessions.filter((s) => !bookmarked.has(s.id)),
  ];

  const items = ordered.map((s) => ({
    label: (bookmarked.has(s.id) ? '$(star-full) ' : '$(comment-discussion) ') + (titles[s.id] || s.title || 'Untitled'),
    description: [projectLabel(s.cwd), s.gitBranch].filter(Boolean).join('  ·  '),
    detail: s.firstPrompt ? s.firstPrompt.slice(0, 110) : undefined,
    id: s.id,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Search your Claude Code chats…',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return;

  await revealSession(context, pick.id);
}

/**
 * Show a session the best way available: the live Claude Code chat if we can reach it,
 * otherwise our own read-only viewer.
 */
async function revealSession(context, id) {
  // Keep this fallback in step with the manifest default.
  const target = vscode.workspace.getConfiguration('agentTabs').get('openChatsIn') || 'built-in-viewer';

  if (target === 'claude-code' && (await openInClaudeCode(id))) return;

  const wasOpen = !!panel;
  openPanel(context);
  if (wasOpen) {
    panel.webview.postMessage({ type: 'openTab', id });
  } else {
    // Panel is still booting; hand the pick over once the webview says it's ready.
    pendingOpenId = id;
  }
}

function projectLabel(cwd) {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function openPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'agentTabs',
    'Agent Tabs',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
    }
  );

  const mediaUri = (name) =>
    panel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media', name)));

  const n = nonce();
  // No remote origins anywhere: the panel may only load what ships with the extension.
  // This makes "reads local files, talks to nobody" enforced rather than merely true.
  const csp = [
    `default-src 'none'`,
    `img-src ${panel.webview.cspSource} data:`,
    `style-src ${panel.webview.cspSource}`,
    `script-src 'nonce-${n}'`,
    `font-src ${panel.webview.cspSource}`,
    `connect-src 'none'`,
  ].join('; ');

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${mediaUri('style.css')}" rel="stylesheet">
<title>Agent Tabs</title>
</head>
<body>
<div id="app"></div>
<script nonce="${n}" src="${mediaUri('main.js')}"></script>
</body>
</html>`;

  panel.webview.onDidReceiveMessage(handleMessage.bind(null, context));

  panel.onDidDispose(() => {
    panel = null;
    disposeWatchers();
  });

  setupWatchers();
}

async function handleMessage(context, msg) {
  if (!panel) return;
  switch (msg.type) {
    case 'ready': {
      panel.webview.postMessage({
        type: 'init',
        openTabs: context.globalState.get('openTabs', []),
        bookmarks: context.globalState.get('bookmarks', []),
        active: context.globalState.get('activeTab', ''),
        titles: context.globalState.get('titles', {}),
      });
      await sendSessions();
      // A chat picked while the panel was still booting — open it now.
      if (pendingOpenId) {
        panel.webview.postMessage({ type: 'openTab', id: pendingOpenId });
        pendingOpenId = null;
      }
      break;
    }
    case 'openSession': {
      const session = await findSession(msg.id);
      if (!session) return;
      const data = await loadSession(session.file, getMaxMessages());
      panel.webview.postMessage({
        type: 'sessionContent',
        id: msg.id,
        meta: session,
        messages: data.messages,
        truncated: data.truncated,
      });
      break;
    }
    case 'persist': {
      // The webview owns tab/bookmark state; mirror it into globalState so it survives restarts.
      if (Array.isArray(msg.openTabs)) context.globalState.update('openTabs', msg.openTabs);
      if (Array.isArray(msg.bookmarks)) context.globalState.update('bookmarks', msg.bookmarks);
      if (typeof msg.active === 'string') context.globalState.update('activeTab', msg.active);
      if (msg.titles && typeof msg.titles === 'object') context.globalState.update('titles', msg.titles);
      break;
    }
    case 'refresh': {
      await sendSessions();
      break;
    }
    case 'continueInClaude': {
      const ok = await openInClaudeCode(msg.id);
      if (!ok) {
        vscode.window.showWarningMessage(
          'Agent Tabs: could not hand this chat to Claude Code. Is the Claude Code extension installed and up to date?'
        );
      }
      break;
    }
    case 'revealInOS': {
      const session = await findSession(msg.id);
      if (session) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(session.file));
      break;
    }
    case 'openCwd': {
      const session = await findSession(msg.id);
      if (session && session.cwd && fs.existsSync(session.cwd)) {
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(session.cwd), {
          forceNewWindow: true,
        });
      } else {
        vscode.window.showWarningMessage('Project folder is unavailable: ' + (session && session.cwd));
      }
      break;
    }
  }
}

let sessionCache = [];

async function findSession(id) {
  let hit = sessionCache.find((s) => s.id === id);
  if (hit) return hit;
  const { sessions } = await listSessions(getProjectsDir());
  sessionCache = sessions;
  return sessions.find((s) => s.id === id) || null;
}

async function sendSessions() {
  if (!panel) return;
  const { dir, sessions } = await listSessions(getProjectsDir());
  sessionCache = sessions;
  panel.webview.postMessage({ type: 'sessions', dir, sessions });
}

function setupWatchers() {
  disposeWatchers();
  const dir = getProjectsDir();
  try {
    const w = fs.watch(dir, { recursive: true }, () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => sendSessions(), 800);
    });
    watchers.push(w);
  } catch {
    // Recursive watch isn't supported everywhere; fall back quietly — the Refresh button covers it.
  }
}

function disposeWatchers() {
  for (const w of watchers) {
    try { w.close(); } catch {}
  }
  watchers = [];
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}

function deactivate() {
  disposeWatchers();
}

module.exports = { activate, deactivate };
