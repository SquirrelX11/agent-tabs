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
    // Cmd+F within the open chat: query, which hit is selected, and whether the bar is up.
    find: { query: '', idx: 0, open: false },
    // User-chosen tab names, keyed by session id. These win over Claude's ai-title.
    // Kept inside this extension only — Claude Code's own history files are never touched.
    titles: {},
    // Chats the user hid from the list. The .jsonl stays on disk; this is reversible.
    hidden: [],
    showHidden: false,
  };

  const app = document.getElementById('app');

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Counter for the hits produced during one pass over the messages.
  let hitSeq = 0;

  /**
   * Escape first, then wrap matches in <mark> — escaping the query too, so it matches
   * the escaped text and can never inject markup of its own.
   */
  function highlight(text) {
    const escaped = esc(text);
    const q = state.find.query.trim();
    if (!q) return escaped;
    const re = new RegExp(escRe(esc(q)), 'gi');
    return escaped.replace(re, (m) => `<mark class="hit" data-i="${hitSeq++}">${m}</mark>`);
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
  /** A user-set name beats Claude's generated ai-title; fall back through to 'Chat'. */
  function titleOf(id) {
    if (state.titles[id]) return state.titles[id];
    const s = sessionById(id) || (state.contents[id] && state.contents[id].meta);
    return (s && s.title) || 'Chat';
  }
  function renameSession(id, name) {
    const clean = (name || '').trim();
    if (clean) state.titles[id] = clean;
    else delete state.titles[id]; // empty input restores the original title
    const bm = state.bookmarks.find((b) => b.id === id);
    if (bm) bm.title = titleOf(id);
    persist();
    render();
  }
  function isBookmarked(id) { return state.bookmarks.some((b) => b.id === id); }
  function isHidden(id) { return state.hidden.includes(id); }

  function persist() {
    vscode.postMessage({
      type: 'persist',
      openTabs: state.openTabs,
      bookmarks: state.bookmarks,
      active: state.active,
      titles: state.titles,
      hidden: state.hidden,
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
  /** Hide a chat from the list. The file stays on disk — this is a view filter. */
  function hideSession(id) {
    if (!isHidden(id)) state.hidden.push(id);
    const i = state.openTabs.indexOf(id);
    if (i !== -1) closeTab(id); // closeTab persists+renders
    else { persist(); render(); }
  }
  function unhideSession(id) {
    state.hidden = state.hidden.filter((h) => h !== id);
    persist();
    render();
  }
  /** Ask the extension to trash the .jsonl. It runs the confirmation dialog. */
  function deleteSession(id) {
    vscode.postMessage({ type: 'deleteSession', id });
  }

  function toggleBookmark(id) {
    const idx = state.bookmarks.findIndex((b) => b.id === id);
    if (idx >= 0) state.bookmarks.splice(idx, 1);
    else {
      const s = sessionById(id) || (state.contents[id] && state.contents[id].meta) || { id, title: id };
      state.bookmarks.push({ id, title: titleOf(id) });
    }
    persist();
    render();
  }

  // ---------- context menu ----------
  function closeMenu() {
    const m = document.querySelector('.ctxmenu');
    if (m) m.remove();
  }
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  /** items: [{label, run, danger}] or {sep:true} */
  function showMenu(x, y, items) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'ctxmenu';
    for (const it of items) {
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'sep';
        m.appendChild(s);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'mi' + (it.danger ? ' danger' : '');
      el.textContent = it.label;
      el.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenu(); it.run(); });
      m.appendChild(el);
    }
    document.body.appendChild(m);
    // Keep the menu inside the panel even when opened near an edge.
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  }

  function sessionMenu(e, id) {
    e.preventDefault();
    e.stopPropagation();
    const items = [
      { label: 'Open', run: () => openSession(id) },
      { label: 'Rename…', run: () => startRenameById(id) },
      { label: isBookmarked(id) ? 'Remove bookmark' : 'Bookmark', run: () => toggleBookmark(id) },
      { sep: true },
    ];
    if (state.openTabs.includes(id)) items.push({ label: 'Close tab', run: () => closeTab(id) });
    items.push(
      isHidden(id)
        ? { label: 'Unhide', run: () => unhideSession(id) }
        : { label: 'Hide from list', run: () => hideSession(id) }
    );
    items.push({ label: 'Delete permanently…', danger: true, run: () => deleteSession(id) });
    showMenu(e.clientX, e.clientY, items);
  }

  /** Start renaming wherever the chat is currently visible. */
  function startRenameById(id) {
    const sel = (q) => document.querySelector(q);
    const tab = sel(`.tab[data-id="${CSS.escape(id)}"]`);
    if (tab) { startRename(tab, id); return; }
    if (state.active === id) {
      const t = sel('.addressbar .title');
      if (t) { startRename(t, id); return; }
    }
    const listTitle = sel(`.session-item[data-id="${CSS.escape(id)}"] .title`);
    if (listTitle) { startRename(listTitle, id); return; }
    // Not on screen: open it, then rename in the address bar.
    openSession(id);
    setTimeout(() => {
      const t = sel('.addressbar .title');
      if (t) startRename(t, id);
    }, 60);
  }

  // ---------- render ----------
  function render() {
    // Rebuilding the DOM resets scrollTop, which threw the sidebar back to the top
    // every time you clicked a chat far down a long list. Carry the position over.
    const prevList = document.querySelector('.session-list');
    const listScroll = prevList ? prevList.scrollTop : null;

    closeMenu();
    app.innerHTML = '';
    app.appendChild(renderTabbar());
    app.appendChild(renderBookmarks());
    const body = document.createElement('div');
    body.className = 'body';
    body.appendChild(renderSidebar());
    body.appendChild(renderContent());
    app.appendChild(body);

    if (listScroll != null) {
      const list = document.querySelector('.session-list');
      if (list) list.scrollTop = listScroll;
    }
  }

  function renderTabbar() {
    const bar = document.createElement('div');
    bar.className = 'tabbar';
    for (const id of state.openTabs) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (id === state.active ? ' active' : '');
      tab.dataset.id = id;
      tab.title = titleOf(id) + '  —  right-click for options · double-click to rename';
      tab.innerHTML =
        `<span class="favicon">${isBookmarked(id) ? '★' : '💬'}</span>` +
        `<span class="label">${esc(titleOf(id))}</span>` +
        `<span class="pencil" data-rename="${esc(id)}" title="Rename">✎</span>` +
        `<span class="close" data-close="${esc(id)}">✕</span>`;
      tab.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename(tab, id);
      });
      tab.addEventListener('contextmenu', (e) => sessionMenu(e, id));
      tab.addEventListener('click', (e) => {
        if (e.target.dataset && e.target.dataset.close) { closeTab(id); return; }
        if (e.target.dataset && e.target.dataset.rename) { e.stopPropagation(); startRename(tab, id); return; }
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
      chip.innerHTML = `<span class="label">${esc(titleOf(b.id))}</span><span class="rm" data-rm="${esc(b.id)}">✕</span>`;
      chip.addEventListener('click', (e) => {
        if (e.target.dataset && e.target.dataset.rm) { toggleBookmark(b.id); return; }
        openSession(b.id);
      });
      chip.addEventListener('contextmenu', (e) => sessionMenu(e, b.id));
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
    // Hiding must be reversible, so the hidden ones stay reachable behind a toggle.
    if (state.hidden.length) {
      const eye = document.createElement('button');
      eye.className = 'btn' + (state.showHidden ? ' on' : '');
      eye.textContent = state.showHidden ? '🙈' : '👁';
      eye.title = state.showHidden
        ? 'Hide the hidden chats again'
        : `Show hidden chats (${state.hidden.length})`;
      eye.addEventListener('click', () => { state.showHidden = !state.showHidden; render(); });
      search.appendChild(eye);
    }
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
      if (!state.showHidden && isHidden(s.id)) return false;
      if (!f) return true;
      return (
        // Search the name the user actually sees, not just Claude's original title.
        titleOf(s.id).toLowerCase().includes(f) ||
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
      // An empty list means two very different things; saying "No matches" when the user
      // has simply never run Claude Code reads as a broken extension.
      if (state.sessions.length === 0) {
        empty.className = 'empty-state';
        empty.innerHTML =
          '<b>No Claude Code sessions found.</b>' +
          '<p>This extension shows the history of Claude Code, read from <code>~/.claude/projects/</code>. ' +
          'If you have not used Claude Code on this machine yet, there is nothing to show here.</p>' +
          '<p>It cannot read chats from Cursor, Copilot or other assistants — they store history in their own formats.</p>';
      } else {
        empty.className = 'session-group-title';
        empty.textContent = 'No matches';
      }
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
        item.className = 'session-item' + (state.openTabs.includes(s.id) ? ' open' : '') +
          (isHidden(s.id) ? ' hidden-item' : '');
        item.dataset.id = s.id;
        item.innerHTML =
          `<div class="title">${isBookmarked(s.id) ? '★ ' : ''}${esc(titleOf(s.id))}</div>` +
          `<div class="meta"><span>${timeAgo(s.mtime)}</span>` +
          (s.gitBranch ? `<span>⎇ ${esc(s.gitBranch)}</span>` : '') +
          (isHidden(s.id) ? '<span>hidden</span>' : '') + `</div>`;
        item.title = (s.firstPrompt || s.title || '') + '\n\nRight-click for rename / hide / delete';
        item.addEventListener('click', () => openSession(s.id));
        item.addEventListener('contextmenu', (e) => sessionMenu(e, s.id));
        list.appendChild(item);
      }
    }
  }

  /** Render the transcript into `msgs`, highlighting hits for the current query. */
  function buildMessages(msgs, data) {
    msgs.innerHTML = '';
    hitSeq = 0;
    if (data.messages.length === 0) {
      msgs.innerHTML = `<div class="placeholder">This session has no text messages.</div>`;
      return;
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
        el.innerHTML = chips.map((l) => `<span class="toolchip">${highlight(l)}</span>`).join('');
      } else {
        el.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
        el.innerHTML =
          `<div class="who">${m.role === 'user' ? '🧑 You' : '🤖 Claude'}</div>` +
          `<div class="bubble">${highlight(m.text)}</div>`;
      }
      msgs.appendChild(el);
    }
  }

  // ---------- rename ----------
  /** Turn a tab (or the address-bar title) into an input, in place. */
  function startRename(anchor, id) {
    if (anchor.querySelector('input.rename') || anchor.classList.contains('renaming')) return;
    const prev = anchor.innerHTML;
    anchor.classList.add('renaming');
    anchor.innerHTML = '';

    const input = document.createElement('input');
    input.className = 'rename';
    input.type = 'text';
    input.value = titleOf(id);
    input.title = 'Enter to save · Esc to cancel · empty to restore the original';
    anchor.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const cancel = () => {
      if (done) return;
      done = true;
      anchor.classList.remove('renaming');
      anchor.innerHTML = prev;
      render();
    };
    const save = () => {
      if (done) return;
      done = true;
      renameSession(id, input.value);
    };

    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't let Cmd+F/Esc handlers fire while typing a name
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', save);
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  // ---------- find in chat ----------
  function openFind() {
    if (!state.active) return;
    state.find.open = true;
    render();
    const input = document.querySelector('.findbar input');
    if (input) { input.focus(); input.select(); }
  }

  function closeFind() {
    state.find.open = false;
    state.find.query = '';
    state.find.idx = 0;
    render();
  }

  function hits() { return Array.from(document.querySelectorAll('mark.hit')); }

  /** Re-render just the transcript, then mark and scroll to the selected hit. */
  function applyFind(keepFocus) {
    const data = state.contents[state.active];
    const msgs = document.querySelector('.messages');
    if (!data || !msgs) return;
    buildMessages(msgs, data);

    const all = hits();
    if (all.length === 0) state.find.idx = 0;
    else state.find.idx = ((state.find.idx % all.length) + all.length) % all.length;

    all.forEach((h, i) => h.classList.toggle('current', i === state.find.idx));
    if (all.length) all[state.find.idx].scrollIntoView({ block: 'center', behavior: 'smooth' });

    const count = document.querySelector('.findbar .count');
    if (count) count.textContent = all.length ? `${state.find.idx + 1}/${all.length}` : 'no results';

    if (keepFocus) {
      const input = document.querySelector('.findbar input');
      if (input) input.focus();
    }
  }

  function step(delta) {
    if (!hits().length) return;
    state.find.idx += delta;
    applyFind(true);
  }

  function renderFindBar() {
    const bar = document.createElement('div');
    bar.className = 'findbar';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Find in this chat…';
    input.value = state.find.query;
    input.addEventListener('input', () => {
      state.find.query = input.value;
      state.find.idx = 0;
      applyFind(true);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    });

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = '';

    const prev = document.createElement('span');
    prev.className = 'nav'; prev.textContent = '↑'; prev.title = 'Previous (Shift+Enter)';
    prev.addEventListener('click', () => step(-1));
    const next = document.createElement('span');
    next.className = 'nav'; next.textContent = '↓'; next.title = 'Next (Enter)';
    next.addEventListener('click', () => step(1));
    const close = document.createElement('span');
    close.className = 'nav'; close.textContent = '✕'; close.title = 'Close (Esc)';
    close.addEventListener('click', () => closeFind());

    bar.append(input, count, prev, next, close);
    return bar;
  }

  // Cmd+F anywhere in the panel opens find; Esc closes it.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      openFind();
    } else if (e.key === 'Escape' && state.find.open) {
      e.preventDefault();
      closeFind();
    }
  });

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
    titleEl.textContent = titleOf(state.active);
    titleEl.title = 'Double-click to rename';
    titleEl.style.cursor = 'text';
    titleEl.addEventListener('dblclick', () => startRename(titleEl, state.active));
    titleEl.addEventListener('contextmenu', (e) => sessionMenu(e, state.active));
    // Double-click alone was invisible; this spells the action out.
    const renameBtn = document.createElement('span');
    renameBtn.className = 'act rename-btn';
    renameBtn.textContent = '✎ rename';
    renameBtn.title = 'Rename this chat (only inside Agent Tabs)';
    renameBtn.addEventListener('click', () => startRename(titleEl, state.active));
    const crumbs = document.createElement('span');
    crumbs.className = 'crumbs';
    crumbs.innerHTML =
      `<span>📁 ${esc(projectName(meta.cwd))}</span>` +
      (meta.gitBranch ? `<span>⎇ ${esc(meta.gitBranch)}</span>` : '') +
      `<span>${timeAgo(meta.mtime)}</span>`;
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    // The whole point of browsing history is picking up where you left off.
    const cont = document.createElement('span');
    cont.className = 'act primary';
    cont.textContent = '▶ continue in Claude Code';
    cont.title = 'Open this session as a live Claude Code chat';
    cont.addEventListener('click', () => vscode.postMessage({ type: 'continueInClaude', id: state.active }));
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

    const findBtn = document.createElement('span');
    findBtn.className = 'act';
    findBtn.textContent = '🔍 find';
    findBtn.title = 'Search inside this chat (Cmd+F)';
    findBtn.addEventListener('click', () => openFind());

    addr.append(star, titleEl, renameBtn, crumbs, spacer, findBtn, cont, openFolder, revealBtn);

    // One sticky header: pinning the bars separately meant guessing the address bar's
    // height, and any drift opened a gap that the transcript showed through.
    const header = document.createElement('div');
    header.className = 'chrome-header';
    header.appendChild(addr);
    if (state.find.open) header.appendChild(renderFindBar());
    content.appendChild(header);

    if (!data) {
      const ph = document.createElement('div');
      ph.className = 'placeholder';
      ph.innerHTML = `<div>Loading…</div>`;
      content.appendChild(ph);
      return content;
    }

    const msgs = document.createElement('div');
    msgs.className = 'messages';
    buildMessages(msgs, data);
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
        state.titles = msg.titles || {};
        state.hidden = msg.hidden || [];
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
      case 'openTab':
        openSession(msg.id);
        break;
      case 'sessionContent':
        state.contents[msg.id] = { meta: msg.meta, messages: msg.messages, truncated: msg.truncated };
        render();
        break;
      case 'sessionDeleted': {
        // The file is gone — drop every trace of it so nothing points at a dead id.
        state.sessions = state.sessions.filter((s) => s.id !== msg.id);
        state.openTabs = state.openTabs.filter((t) => t !== msg.id);
        state.bookmarks = state.bookmarks.filter((b) => b.id !== msg.id);
        state.hidden = state.hidden.filter((h) => h !== msg.id);
        delete state.titles[msg.id];
        delete state.contents[msg.id];
        if (state.active === msg.id) state.active = state.openTabs[0] || '';
        persist();
        render();
        break;
      }
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
