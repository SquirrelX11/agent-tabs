'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { defaultProjectsDir, listSessions, loadSession } = require('./sessionReader');

let panel = null;
let watchers = [];
let refreshTimer = null;

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
    vscode.commands.registerCommand('agentTabs.refresh', () => sendSessions())
  );

  // In the Extension Development Host (F5), show the panel right away; otherwise it would
  // have to be summoned from the palette every run. A normal install waits for the command.
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    openPanel(context);
  }
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
  const csp = [
    `default-src 'none'`,
    `img-src ${panel.webview.cspSource} https: data:`,
    `style-src ${panel.webview.cspSource}`,
    `script-src 'nonce-${n}'`,
    `font-src ${panel.webview.cspSource}`,
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
      });
      await sendSessions();
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
      break;
    }
    case 'refresh': {
      await sendSessions();
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
