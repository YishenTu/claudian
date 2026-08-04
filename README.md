# Oh My Claudian

![Preview](assets/Preview.png)

Oh My Claudian is an Obsidian plugin that embeds coding agents in your vault. Agents can read, write, search, run commands, and carry out multi-step workflows in the vault working directory.

[Install from Obsidian Community Plugins](https://community.obsidian.md/plugins/oh-my-claudian) · [View on GitHub](https://github.com/lee259/oh-my-claudian)

> This repository is based on [YishenTu/claudian](https://github.com/YishenTu/claudian) and adds Oh My Pi (OMP) support through ACP.

## Added in This Repository

- **Oh My Pi (OMP)** — An ACP-backed OMP provider with model discovery and selection in the chat sidebar.

## Features

- Sidebar chat, multiple tabs, conversation history, fork, resume, and compact.
- Inline edits with word-level diff preview.
- Slash commands, skills, `@` mentions, and instruction mode.
- Provider-specific planning, permissions, reasoning controls, and model selection.
- MCP support where available from the selected provider.
- Internationalized interface with 10 locales, including Simplified and Traditional Chinese.

## Requirements

- At least one supported harness:
  - [Claude Code CLI](https://code.claude.com/docs/en/overview)
  - [Codex CLI](https://github.com/openai/codex)
  - [Grok Build](https://github.com/xai-org/grok-build)
  - [OpenCode](https://github.com/anomalyco/opencode)
  - [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi)
  - [Pi](https://github.com/earendil-works/pi)
- A compatible subscription or API provider.
- Obsidian v1.7.2+ on macOS, Linux, or Windows.

## Installation

### From Obsidian Community Plugins (recommended)

1. Open Obsidian → **Settings → Community plugins → Browse**.
2. Search for **Oh My Claudian**, install it, and enable the plugin.

You can also open the [Oh My Claudian community plugin page](https://community.obsidian.md/plugins/oh-my-claudian) directly.

### From source (development)

```bash
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/lee259/oh-my-claudian.git
cd oh-my-claudian
npm install
npm run build
```

Then enable the plugin in Obsidian under **Settings → Community plugins**.

## Usage

Open the chat sidebar from the ribbon icon or command palette. Select text and use the inline-edit hotkey to edit notes with a diff preview. Use `/` for commands and skills, `@` to reference vault files or provider resources, and the provider selector to choose Claude, Codex, Grok, OMP, OpenCode, or Pi.

OMP requires its CLI to be installed and logged in separately. In **Settings → Oh My Claudian → OMP**, enable the provider, set the CLI path if it is not detected automatically, and use **Discover** to load available models.

## Development

```bash
npm run dev
npm run build
npm run typecheck
npm run lint
npm run test
```

## Privacy

Your input, attachments, and tool results are sent only to the provider you select: Claude, Codex, Grok, OMP, OpenCode, Pi, or their configured model providers. Oh My Claudian does not send telemetry. Network activity is limited to explicit provider work and configured MCP endpoints.

## Troubleshooting

If a provider CLI is not found, first leave its configured path blank so Oh My Claudian can auto-detect it. If detection fails, set the executable path in the provider settings and ensure its runtime is available to Obsidian's `PATH`.

For OMP specifically, verify that the CLI is installed, logged in, and executable by the Obsidian desktop process. If model discovery fails, set the absolute OMP path in the OMP settings tab and try **Discover** again.

## Architecture

```text
src/
├── app/          # Application services and persistence
├── core/         # Provider-neutral contracts and runtime
├── providers/    # Provider adaptors, including ACP and OMP
├── features/     # Chat, inline edit, and settings UI
├── shared/       # Reusable UI components
└── style/        # Modular CSS
```

## Contributing

Issues and focused pull requests are welcome. Please describe the problem, reproduction steps, proposed solution, and validation.

## License

Licensed under the [MIT License](LICENSE).
