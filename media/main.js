'use strict';
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {{sessions: any[], openTabs: string[], bookmarks: {id:string,title:string}[], active: string, contents: Record<string, any>, filter: string, dir: string}} */
  const state = {
    sessions: [],
    openTabs: [],
    bookmarks: [],
    active: '',
    contents: {}, // id -> {meta, messages, truncated}
    filter: '',
    dir: '',
  };

  const app = document.getElementById('app');

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function timeAgo(ms) {
    if (!ms) return '';
    const diff = (Date.now() - ms) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + 'd';
    return new Date(ms).toLocaleDateString();
  }
  function projectName(cwd) {
    if (!cwd) return 'no project';
    const parts = cwd.split('/').filter(Boolean);
    return parts[parts.length - 1] || cwd;
  }
  function sessionById(id) { return state.sessions.find((s) => s.id === id); }
  function isBookmarked(id) { return state.bookmarks.some((b) => b.id === id); }

  function persist() {
    vscode.postMessage({
      type: 'persist',
      openTabs: state.openTabs,
      bookmarks: state.bookmarks,
      active: state.active,
    });
  }

  // ---------- actions ----------
  function openSession(id) {
    if (!state.openTabs.includes(id)) state.openTabs.push(id);
    state.active = id;
    if (!state.contents[id]) vscode.postMessage({ type: 'openSession', id });
    persist();
    render();
  }
  function closeTab(id) {
    const i = state.openTabs.indexOf(id);
    if (i === -1) return;
    state.openTabs.splice(i, 1);
    if (state.active === id) {
      state.active = state.openTabs[i] || state.openTabs[i - 1] || state.openTabs[0] || '';
      if (state.active && !state.contents[state.active])
        vscode.postMessage({ type: 'openSession', id: state.active });
    }
    persist();
    render();
  }
  function toggleBookmark(id) {
    const idx = state.bookmarks.findIndex((b) => b.id === id);
    if (idx >= 0) state.bookmarks.splice(idx, 1);
    else {
      const s = sessionById(id) || (state.contents[id] && state.contents[id].meta) || { id, title: id };
      state.bookmarks.push({ id, title: s.title || 'Chat' });
    }
    persist();
    render();
  }

  // ---------- render ----------
  function render() {
    app.innerHTML = '';
    app.appendChild(renderTabbar());
    app.appendChild(renderBookmarks());
    const body = document.createElement('div');
    body.className = 'body';
    body.appendChild(renderSidebar());
    body.appendChild(renderContent());
    app.appendChild(body);
  }

  function renderTabbar() {
    const bar = document.createElement('div');
    bar.className = 'tabbar';
    for (const id of state.openTabs) {
      const s = sessionById(id) || (state.contents[id] && state.contents[id].meta) || { id, title: id };
      const tab = document.createElement('div');
      tab.className = 'tab' + (id === state.active ? ' active' : '');
      tab.title = s.title || id;
      tab.innerHTML =
        `<span class="favicon">${isBookmarked(id) ? '★' : '💬'}</span>` +
        `<span class="label">${esc(s.title || 'Chat')}</span>` +
        `<span class="close" data-close="${esc(id)}">✕</span>`;
      tab.addEventListener('click', (e) => {
        if (e.target.dataset && e.target.dataset.close) { closeTab(id); return; }
        state.active = id;
        if (!state.contents[id]) vscode.postMessage({ type: 'openSession', id });
        persist();
        render();
      });
      bar.appendChild(tab);
    }
    const nt = document.createElement('div');
    nt.className = 'tab newtab';
    nt.title = 'All chats are listed on the left';
    nt.textContent = '＋';
    nt.addEventListener('click', () => {
      const input = document.querySelector('.sidebar input');
      if (input) input.focus();
    });
    bar.appendChild(nt);
    return bar;
  }

  function renderBookmarks() {
    const bar = document.createElement('div');
    bar.className = 'bookmarks';
    const label = document.createElement('span');
    label.className = 'bm-label';
    label.textContent = '★ Bookmarks:';
    bar.appendChild(label);
    if (state.bookmarks.length === 0) {
      const e = document.createElement('span');
      e.className = 'empty';
      e.textContent = 'none yet — press ★ in a chat to pin it here';
      bar.appendChild(e);
      return bar;
    }
    for (const b of state.bookmarks) {
      const chip = document.createElement('div');
      chip.className = 'bookmark';
      chip.title = b.title;
      chip.innerHTML = `<span class="label">${esc(b.title)}</span><span class="rm" data-rm="${esc(b.id)}">✕</span>`;
      chip.addEventListener('click', (e) => {
        if (e.target.dataset && e.target.dataset.rm) { toggleBookmark(b.id); return; }
        openSession(b.id);
      });
      bar.appendChild(chip);
    }
    return bar;
  }

  function renderSidebar() {
    const sb = document.createElement('div');
    sb.className = 'sidebar';

    const search = document.createElement('div');
    search.className = 'search';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search chats…';
    input.value = state.filter;
    input.addEventListener('input', () => { state.filter = input.value; renderListOnly(); });
    const refresh = document.createElement('button');
    refresh.className = 'btn';
    refresh.textContent = '⟳';
    refresh.title = 'Refresh';
    refresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    search.appendChild(input);
    search.appendChild(refresh);
    sb.appendChild(search);

    const list = document.createElement('div');
    list.className = 'session-list';
    sb.appendChild(list);
    renderList(list);
    return sb;
  }

  function renderListOnly() {
    const list = document.querySelector('.session-list');
    if (list) renderList(list);
  }

  function renderList(list) {
    list.innerHTML = '';
    const f = state.filter.trim().toLowerCase();
    const filtered = state.sessions.filter((s) => {
      if (!f) return true;
      return (
        (s.title || '').toLowerCase().includes(f) ||
        (s.firstPrompt || '').toLowerCase().includes(f) ||
        (s.cwd || '').toLowerCase().includes(f)
      );
    });

    // group by project
    const groups = {};
    for (const s of filtered) {
      const key = projectName(s.cwd);
      (groups[key] = groups[key] || []).push(s);
    }
    const keys = Object.keys(groups);
    if (keys.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-group-title';
      empty.textContent = 'No matches';
      list.appendChild(empty);
      return;
    }
    for (const key of keys) {
      const gt = document.createElement('div');
      gt.className = 'session-group-title';
      gt.textContent = key + '  (' + groups[key].length + ')';
      list.appendChild(gt);
      for (const s of groups[key]) {
        const item = document.createElement('div');
        item.className = 'session-item' + (state.openTabs.includes(s.id) ? ' open' : '');
        item.innerHTML =
          `<div class="title">${isBookmarked(s.id) ? '★ ' : ''}${esc(s.title || 'Untitled')}</div>` +
          `<div class="meta"><span>${timeAgo(s.mtime)}</span>` +
          (s.gitBranch ? `<span>⎇ ${esc(s.gitBranch)}</span>` : '') + `</div>`;
        item.title = s.firstPrompt || s.title || '';
        item.addEventListener('click', () => openSession(s.id));
        list.appendChild(item);
      }
    }
  }

  function renderContent() {
    const content = document.createElement('div');
    content.className = 'content';

    if (!state.active) {
      const ph = document.createElement('div');
      ph.className = 'placeholder';
      ph.innerHTML = `<div class="big">💬</div><div>Pick a chat on the left — it opens as a tab.</div>` +
        `<div style="font-size:12px">Press ★ to bookmark it.</div>`;
      content.appendChild(ph);
      return content;
    }

    const data = state.contents[state.active];
    const meta = (data && data.meta) || sessionById(state.active) || { id: state.active };

    // address bar
    const addr = document.createElement('div');
    addr.className = 'addressbar';
    const star = document.createElement('span');
    star.className = 'star-btn' + (isBookmarked(state.active) ? ' on' : '');
    star.textContent = isBookmarked(state.active) ? '★' : '☆';
    star.title = 'Bookmark';
    star.addEventListener('click', () => toggleBookmark(state.active));
    const titleEl = document.createElement('span');
    titleEl.className = 'title';
    titleEl.textContent = meta.title || 'Chat';
    const crumbs = document.createElement('span');
    crumbs.className = 'crumbs';
    crumbs.innerHTML =
      `<span>📁 ${esc(projectName(meta.cwd))}</span>` +
      (meta.gitBranch ? `<span>⎇ ${esc(meta.gitBranch)}</span>` : '') +
      `<span>${timeAgo(meta.mtime)}</span>`;
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const openFolder = document.createElement('span');
    openFolder.className = 'act';
    openFolder.textContent = '↗ project';
    openFolder.title = 'Open the project folder in a new window';
    openFolder.addEventListener('click', () => vscode.postMessage({ type: 'openCwd', id: state.active }));
    const revealBtn = document.createElement('span');
    revealBtn.className = 'act';
    revealBtn.textContent = '⧉ file';
    revealBtn.title = 'Reveal the .jsonl in your file manager';
    revealBtn.addEventListener('click', () => vscode.postMessage({ type: 'revealInOS', id: state.active }));

    addr.append(star, titleEl, crumbs, spacer, openFolder, revealBtn);
    content.appendChild(addr);

    if (!data) {
      const ph = document.createElement('div');
      ph.className = 'placeholder';
      ph.innerHTML = `<div>Loading…</div>`;
      content.appendChild(ph);
      return content;
    }

    const msgs = document.createElement('div');
    msgs.className = 'messages';
    if (data.messages.length === 0) {
      msgs.innerHTML = `<div class="placeholder">This session has no text messages.</div>`;
    }
    for (let i = 0; i < data.messages.length; i++) {
      const m = data.messages[i];
      const el = document.createElement('div');

      if (m.kind === 'tool') {
        // Collapse a run of consecutive tool calls into one row of chips;
        // otherwise every Bash would take a row of its own.
        const chips = [];
        while (i < data.messages.length && data.messages[i].kind === 'tool') {
          chips.push(...data.messages[i].text.split('\n'));
          i++;
        }
        i--;
        el.className = 'toolrow';
        el.innerHTML = chips.map((l) => `<span class="toolchip">${esc(l)}</span>`).join('');
      } else {
        el.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
        el.innerHTML =
          `<div class="who">${m.role === 'user' ? '🧑 You' : '🤖 Claude'}</div>` +
          `<div class="bubble">${esc(m.text)}</div>`;
      }
      msgs.appendChild(el);
    }
    content.appendChild(msgs);

    if (data.truncated) {
      const tr = document.createElement('div');
      tr.className = 'truncated';
      tr.textContent = 'Showing the first messages only — this session is very long (cap: agentTabs.maxMessagesPerChat).';
      content.appendChild(tr);
    }
    return content;
  }

  // ---------- messages from the extension ----------
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        state.openTabs = msg.openTabs || [];
        state.bookmarks = msg.bookmarks || [];
        state.active = msg.active || '';
        for (const id of state.openTabs) {
          if (!state.contents[id]) vscode.postMessage({ type: 'openSession', id });
        }
        render();
        break;
      case 'sessions':
        state.sessions = msg.sessions || [];
        state.dir = msg.dir || '';
        render();
        break;
      case 'sessionContent':
        state.contents[msg.id] = { meta: msg.meta, messages: msg.messages, truncated: msg.truncated };
        render();
        break;
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
