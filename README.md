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
- Provider readiness diagnostics in each provider settings tab, covering enablement, CLI availability, model discovery, and model selection.
- Readiness state refreshes immediately after provider enablement changes, so the settings page does not show stale status.
- Model catalog state in provider settings, including freshness, cached/failed refresh state, default model, and all-versus-explicit selection.
- Provider-neutral execution outcomes for completion, cancellation, invalidation, and recoverable errors, with recovery actions fenced while a turn is active.
- MCP support where available from the selected provider.
- Internationalized interface with 10 locales, including Simplified and Traditional Chinese.
**Plan Mode** — Toggle via `Shift+Tab`. The agent explores and designs before implementing, then presents a plan for approval.

**Instruction Mode (`#`)** — Refined custom instructions added from the chat input.

**MCP Servers** — Connect external tools via Model Context Protocol (stdio, SSE, HTTP). Claude manages vault MCP in-app; Other harnesses uses its own CLI-managed MCP configuration.

**Tabs & Session Management** — Use multiple tabs in single-panel mode or a persistent session manager beside the chat in dual-pane mode.

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

Each provider has a readiness panel in its settings tab. Use it to see whether the provider is enabled, its CLI is available, models have been discovered, and a chat model is selected. The panel refreshes after enablement changes and lets you recheck the current provider state; installation and authentication remain provider-native. Model pickers also show whether the catalog is fresh, cached, or failed to refresh, along with the provider default and current selection mode.

OMP requires its CLI to be installed and logged in separately. In **Settings → Oh My Claudian → OMP**, enable the provider, set the CLI path if it is not detected automatically, and use **Discover** to load available models.

## Development

```bash
npm run dev
npm run build
npm run typecheck
npm run lint
npm run test
```

`npm run dev` watches TypeScript, styles, and `manifest.json`. When `OBSIDIAN_VAULT` is set in `.env.local`, rebuilt plugin resources are copied to that vault automatically, including CSS and manifest changes.

## Release

Releases are created automatically by [`.github/workflows/release.yml`](.github/workflows/release.yml) when a version tag is pushed.

1. Update the version in `manifest.json` and commit the change.
2. Run the local validation checks:

   ```bash
   npm run typecheck
   npm run lint
   npm run test
   npm run build
   ```

3. Create a tag that exactly matches the `manifest.json` version, for example:

   ```bash
   git tag 2.1.2
   git push origin 2.1.2
   ```

   If your writable remote is named `fork`, use `git push fork 2.1.2` instead.

The workflow validates the version, builds the plugin, runs the performance check, generates release notes, and publishes `main.js`, `manifest.json`, and `styles.css` to the GitHub Release. These are the files used for the Obsidian Community Plugins release.

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

Issues and focused pull requests are welcome. Before opening one, please search existing issues and pull requests to avoid duplicates. For substantial changes, open an issue first so the problem and scope can be discussed.

Pull requests should focus on one problem and explain:

- Why the change is needed and who it affects.
- What behavior or code changed, and why this approach was chosen.
- How it was validated, including tests and manual checks.
- Known limitations, compatibility risks, and follow-up work.

Add or update tests for behavior changes, preserve provider ownership boundaries, avoid unnecessary production dependencies, and update documentation for user-facing changes. New provider additions are not accepted; improvements to existing providers should document provider-specific capabilities and limitations.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full development and pull request guide.

## License

Licensed under the [MIT License](LICENSE).
