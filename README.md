# Agent Tabs

Your **Claude Code** chats, at the top, as **browser-style tabs** — with a bookmarks bar, search, and grouping by project.

Reads session history straight from `~/.claude/projects/*/*.jsonl`.

![Agent Tabs](media/screenshot.png)

## 🔒 Privacy

**Everything runs locally. This extension sends nothing anywhere.** No telemetry, no analytics, no network requests — none at all. It only reads the Claude Code history files already sitting on your disk and renders them in a panel. The source is open, so you can check: there isn't a single line of networking in it.

## Features

- 🗂 **Browser-style tabs** — open chats live as tabs at the top; switch with one click.
- ★ **Bookmarks** — the star pins a chat to the bookmarks bar (persists across restarts).
- 🔎 **Search & list** on the left — every session, grouped by project; search by title, first message, or path.
- 🤖 **Automatic titles** — taken from the `ai-title` that Claude Code generates itself.
- 🛠 **Readable transcript** — internal tool results don't pose as your messages; tool calls collapse into compact chips.
- ↗ **Quick actions** — open the project folder in a new window, reveal the `.jsonl` in your file manager.
- ⚡ **Handles huge sessions** — an 850 MB session opens in ~50 ms via streaming reads with early exit.

## Install

**From Open VSX** (Cursor, VSCodium, Windsurf, Gitpod):
search for “Agent Tabs” in the extensions view.

**From `.vsix`** (any VS Code):
download it from [Releases](https://github.com/SquirrelX11/agent-tabs/releases) → Extensions → `···` → **Install from VSIX**.

Then: `Cmd+Shift+P` → **Agent Tabs: open chat panel**.

## Development

```bash
git clone https://github.com/SquirrelX11/agent-tabs.git
cd agent-tabs
code .
# Press F5 — the Extension Development Host opens and the panel appears on its own
```

No build step — the extension is plain JavaScript.

Package it: `npm run package` → `agent-tabs-0.1.0.vsix`

## Settings

| Setting | Default | Description |
|---|---|---|
| `agentTabs.projectsDir` | `~/.claude/projects` | Where to look for sessions. |
| `agentTabs.maxMessagesPerChat` | `800` | Message cap per chat (guards against enormous sessions). |

## Roadmap

- Providers for **Cursor** (SQLite in `workspaceStorage`) and **Cline / Roo**.
- A **JetBrains** plugin sharing the same bookmarks format.
- Export a chat to Markdown.

## License

[MIT](LICENSE) © Alex (SquirrelX11)

---

### Disclaimer

This is an **unofficial** extension. It is **not affiliated with, endorsed by, or supported by Anthropic**.
“Claude” and “Claude Code” are trademarks of Anthropic PBC and are used here solely to describe compatibility.
