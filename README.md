# Claudian

![GitHub stars](https://img.shields.io/github/stars/YishenTu/claudian?style=social)
![GitHub release](https://img.shields.io/github/v/release/YishenTu/claudian)
![License](https://img.shields.io/github/license/YishenTu/claudian)

![Preview](assets/Preview.png)

An Obsidian plugin that embeds AI coding agents (Claude Code, Codex, Grok, Opencode, Pi, and more to come) in your vault. Your vault becomes the agent's working directory — file read/write, search, bash, and multi-step workflows all work out of the box.

## Features & Usage

Open the chat sidebar from the ribbon icon or command palette. Select text and use the hotkey for inline edit. Everything works like your familiar coding agent, Claude Code, Codex, Grok, Opencode, and Pi — talk to the agent, and it reads, writes, edits, and searches files in your vault.

**Inline Edit** — Select text or start at the cursor position + hotkey to edit directly in notes with word-level diff preview.

**Slash Commands & Skills** — Type `/` or `$` for reusable prompt templates or Skills from user- and vault-level scopes.

**`@mention`** - Type `@` to mention anything you want the agent to work with, vault files, subagents, MCP servers, or files in external directories.

**Plan Mode** — Toggle via `Shift+Tab`. The agent explores and designs before implementing, then presents a plan for approval.

**Instruction Mode (`#`)** — Refined custom instructions added from the chat input.

**MCP Servers** — Connect external tools via Model Context Protocol (stdio, SSE, HTTP). Claude manages vault MCP in-app; Codex uses its own CLI-managed MCP configuration.

**Multi-Tab & Conversations** — Multiple chat tabs, conversation history, fork, resume, and compact.

## Requirements

- **Claude provider**: [Claude Code CLI](https://code.claude.com/docs/en/overview) installed (native install recommended). Claude subscription/API or compatible provider ([Openrouter](https://openrouter.ai/docs/guides/guides/claude-code-integration), [Kimi](https://platform.kimi.ai/docs/guide/claude-code-kimi), [GLM](https://docs.z.ai/devpack/tool/claude) etc.).
- **Optional providers**: [Codex CLI](https://github.com/openai/codex), [Grok Build](https://github.com/xai-org/grok-build), [Opencode](https://github.com/anomalyco/opencode), [Pi](https://github.com/earendil-works/pi).
- Obsidian v1.7.2+
- Desktop only (macOS, Linux, Windows)

## Installation

### From Obsidian Community Plugins (recommended)

1. Open Obsidian → Settings → Community plugins → Browse
2. Search for "Claudian" and click Install
3. Enable the plugin

Or install directly from the [community plugin page](https://community.obsidian.md/plugins/realclaudian).

### From GitHub Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/YishenTu/claudian/releases/latest)
2. Create a folder called `claudian` in your vault's plugins folder:
   ```
   /path/to/vault/.obsidian/plugins/claudian/
   ```
3. Copy the downloaded files into the `claudian` folder
4. Enable the plugin in Obsidian:
   - Settings → Community plugins → Enable "Claudian"

### From source (development)

1. Clone this repository into your vault's plugins folder:
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/YishenTu/claudian.git
   cd claudian
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Enable the plugin in Obsidian:
   - Settings → Community plugins → Enable "Claudian"

### Development

```bash
# Watch mode
npm run dev

# Production build
npm run build
```

## Privacy & Data Use

- **Sent to API**: Your input, attached files, images, and tool call outputs. Default: Anthropic (Claude), OpenAI (Codex), xAI (Grok), or the provider configured in Opencode/Pi; configurable via provider settings and environment variables.
- **Local storage**: Claudian settings and session metadata in `vault/.claudian/`; Claude provider files in `vault/.claude/`; shared skills for Codex, Grok, Opencode, and Pi in `vault/.agents/skills/`; transcripts in `~/.claude/projects/` (Claude), `~/.codex/sessions/` (Codex), `~/.grok/sessions/` or `$GROK_HOME/sessions/` (Grok), and `.pi/agent/sessions/` or `~/.pi/agent/sessions/` (Pi).
- **Environment variables**: Provider subprocesses inherit the Obsidian process environment plus any variables you configure in Claudian. This is needed for CLI authentication, proxies, certificates, and PATH resolution.
- **Device-specific paths**: Per-device CLI paths use an opaque local key stored in browser local storage, not your system hostname.
- **Background activity**: Claudian does not run telemetry beacons. UI polling timers read local Obsidian/editor selection state only. Network activity is limited to explicit provider runtime work, configured MCP endpoints, and provider SDK/CLI calls needed to answer your requests.

## Troubleshooting

### Claude CLI not found

If you encounter `spawn claude ENOENT` or `Claude CLI not found`, the plugin can't auto-detect your Claude installation. Common with Node version managers (nvm, fnm, volta).

**Solution**: Leave the setting empty first so Claudian can auto-detect Claude Code. If auto-detection fails, find your CLI path and set it in Settings → Advanced → Claude CLI path.

| Platform | Command | Example Path |
|----------|---------|--------------|
| macOS/Linux | `which claude` | `/Users/you/.volta/bin/claude` |
| Windows (native) | `where.exe claude` | `C:\Users\you\AppData\Local\Claude\claude.exe` |
| Windows (npm) | `npm root -g` | `{root}\@anthropic-ai\claude-code\cli-wrapper.cjs` |

> **Note**: On Windows, avoid `.cmd` and `.ps1` wrappers. Use `claude.exe` for native installs, or `cli-wrapper.cjs` for package-manager installs. `cli.js` is only a legacy fallback for older Claude Code npm packages.

**Alternative**: Add your Node.js bin directory to PATH in Settings → Environment → Custom variables.

### npm CLI and Node.js not in same directory

If using npm-installed CLI, check if `claude` and `node` are in the same directory:
```bash
dirname $(which claude)
dirname $(which node)
```

If different, GUI apps like Obsidian may not find Node.js.

**Solutions**:
1. Install native binary (recommended)
2. Add Node.js path to Settings → Environment: `PATH=/path/to/node/bin`

### Other providers

Codex, Grok, Opencode, and Pi support are live but still need more testing across platforms and installation methods. If you have a feature request or run into any bugs, please [submit a GitHub issue](https://github.com/YishenTu/claudian/issues).

## Architecture

```
src/
├── main.ts                      # Plugin entry point
├── app/                         # Shared defaults and plugin-level storage
├── core/                        # Provider-neutral runtime, registry, and type contracts
│   ├── runtime/                 # ChatRuntime interface and approval types
│   ├── providers/               # Provider registry and workspace services
│   ├── auxiliary/               # Shared provider auxiliary services
│   ├── bootstrap/               # Plugin bootstrap wiring
│   ├── security/                # Approval utilities
│   └── ...                      # commands, mcp, prompt, storage, tools, types
├── providers/
│   ├── claude/                  # Claude SDK adaptor, prompt encoding, storage, MCP, plugins
│   ├── codex/                   # Codex app-server adaptor, JSON-RPC transport, JSONL history
│   ├── grok/                    # Grok Build ACP adaptor, native history, models, and tools
│   ├── opencode/                # Opencode adaptor
│   ├── pi/                      # Pi RPC adaptor, model discovery, JSONL history
│   └── acp/                     # Agent Client Protocol shared transport
├── features/
│   ├── chat/                    # Sidebar chat: tabs, controllers, renderers
│   ├── inline-edit/             # Inline edit modal and provider-backed edit services
│   └── settings/                # Settings shell with provider tabs
├── shared/                      # Reusable UI components and modals
├── i18n/                        # Internationalization (10 locales)
├── types/                       # Shared ambient types
├── utils/                       # Cross-cutting utilities
└── style/                       # Modular CSS
```

## Star History

<a href="https://www.star-history.com/?repos=YishenTu%2Fclaudian&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=YishenTu/claudian&type=date&theme=dark&legend=top-left&sealed_token=gXv_vWhYBwlA0DehVo1Lwkf2jquI2mMAgmTawJA0nVFNaSdTkokMxxdjqk3zfUqWZKVuPlPi9e5hzWb3265cHWdgwm8Y-n3D7X4pyPM6w0sKWGE_WlHHTO-Gf3zoeP3XG8p3cHVEg_7oq3rhjLXpNFrluGUDWtFP3bwenzBJhHvoLmJaHUPD6KGHLqyO" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=YishenTu/claudian&type=date&legend=top-left&sealed_token=gXv_vWhYBwlA0DehVo1Lwkf2jquI2mMAgmTawJA0nVFNaSdTkokMxxdjqk3zfUqWZKVuPlPi9e5hzWb3265cHWdgwm8Y-n3D7X4pyPM6w0sKWGE_WlHHTO-Gf3zoeP3XG8p3cHVEg_7oq3rhjLXpNFrluGUDWtFP3bwenzBJhHvoLmJaHUPD6KGHLqyO" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=YishenTu/claudian&type=date&legend=top-left&sealed_token=gXv_vWhYBwlA0DehVo1Lwkf2jquI2mMAgmTawJA0nVFNaSdTkokMxxdjqk3zfUqWZKVuPlPi9e5hzWb3265cHWdgwm8Y-n3D7X4pyPM6w0sKWGE_WlHHTO-Gf3zoeP3XG8p3cHVEg_7oq3rhjLXpNFrluGUDWtFP3bwenzBJhHvoLmJaHUPD6KGHLqyO" />
 </picture>
</a>

## Sponsorship

### Ke Holdings Inc. (BEIKE)

<img src="assets/sponsors/MOMA.png" alt="MOMA" width="90%">

Claudian is proudly sponsored by Ke Holdings Inc. (BEIKE) and the MOMA team. Their support helps Claudian continue to
improve through ongoing development and maintenance.

> Want to support Claudian or appear here? Contact me: [tysk01213@gmail.com](mailto:tysk01213@gmail.com).

## License

Licensed under the [MIT License](LICENSE).
