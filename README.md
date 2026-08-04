# Oh My Claudian

![Preview](assets/Preview.png)

Oh My Claudian is an Obsidian plugin that embeds coding agents in your vault. Agents can read, write, search, run commands, and carry out multi-step workflows in the vault working directory.

> This repository is based on [YishenTu/claudian](https://github.com/YishenTu/claudian) and adds Oh My Pi (OMP) support through ACP.

## Added in This Repository

- **Oh My Pi (OMP)** — An ACP-backed OMP provider with model discovery and selection in the chat sidebar.

## Features

- Sidebar chat, multiple tabs, conversation history, fork, resume, and compact.
- Inline edits with word-level diff preview.
- Slash commands, skills, `@` mentions, and instruction mode.
- Provider-specific planning, permissions, reasoning controls, and model selection.
- MCP support where available from the selected provider.

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

## Installation from Source

```bash
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/lee259/oh-my-claudian.git
cd oh-my-claudian
npm install
npm run build
```

Then enable the plugin in Obsidian under **Settings → Community plugins**.

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
