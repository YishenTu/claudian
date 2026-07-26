# Claudian Plus

[![GitHub stars](https://img.shields.io/github/stars/wuyifan-code/Claudian-plus?style=social)](https://github.com/wuyifan-code/Claudian-plus)
[![GitHub release](https://img.shields.io/github/v/release/wuyifan-code/Claudian-plus)](https://github.com/wuyifan-code/Claudian-plus/releases)
[![License](https://img.shields.io/github/license/wuyifan-code/Claudian-plus)](LICENSE)

Claudian Plus is a Codex-first AI workspace with **consciousness mechanism** for local-first knowledge work. It combines Codex, Claude, OpenCode, and Pi in one desktop chat workspace while keeping notes, context, and provider sessions in your local vault.

## ✨ New in v2.1.0: Consciousness Mechanism

Inspired by QoderWork's awareness system, Claudian Plus now features a complete consciousness mechanism that enables:

- **🧠 Self-Reflection** — Automatically extract key insights from conversations without explicit commands
- **📝 Memory Accumulation** — Build long-term user profiles and preferences over time
- **📚 Vault Knowledge** — Index and understand your entire Obsidian vault
- **🔄 Cross-Session Memory** — Carry context and knowledge across conversations

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    Consciousness System                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   SOUL.md   │    │   USER.md   │    │  MEMORY.md  │     │
│  │ Collaboration│    │ User Profile│    │ Long-term   │     │
│  │    Style    │    │             │    │   Memory    │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Vault Knowledge Index                   │   │
│  │  (Scans all notes, extracts tags, headings, etc.)   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Activity Log                            │   │
│  │  (Tracks memory additions, removals, reflections)   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Memory Triggers

| Type | Chinese | English |
|------|---------|---------|
| **Save** | 记住... / 记得... / 别忘了... | remember... / keep in mind... |
| **Delete** | 忘记... / 忘掉... | forget... / remove memory... |
| **List** | 列出记忆 / 显示记忆 | list memories / show memories |

### Implicit Memory (Auto-Extract)

The consciousness system automatically detects important information in conversations:

- **Preferences**: "我喜欢暗色主题" → Saved as user preference
- **Habits**: "我通常用 Vim 键位" → Saved as work habit
- **Personal**: "我叫小明" → Saved as personal info
- **Project**: "我们项目用 React" → Saved as project context
- **Corrections**: "不对，应该用 TypeScript" → Saved as rule

## Highlights

- **Codex-first defaults** — use Codex as the default agent and prefer `gpt-5.6-sol` when that model is available in the local CLI.
- **Consciousness mechanism** — self-reflection, memory accumulation, and vault knowledge indexing.
- **Floating conversation outline** — keep a compact rail of user questions and assistant headings, with thoughts and tool output collapsed out of the outline.
- **Multiple providers** — switch between Codex, Claude, OpenCode, and Pi without changing the chat workspace.
- **Local conversation history** — search previous conversations by title, first message, provider, date, or model.
- **Note and folder context** — drag notes and folders into the chat input to add `@file` and `@folder/` context.
- **Vault search and insights** — use local source-backed search and an insight workflow that keeps citations and sends the resulting task to the active agent.
- **Existing Claudian workflows** — keep slash commands, skills, MCP, inline editing, multi-tab conversations, and provider-native sessions.

## Installation

### Install from a release

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/wuyifan-code/Claudian-plus/releases/latest).
2. Create `.obsidian/plugins/claudian-plus/` inside your vault.
3. Copy the three downloaded files into that directory.
4. Open the app's community plugin settings and enable **Claudian Plus**.

The plugin is desktop-only because it integrates with local agent CLIs and desktop filesystem capabilities.

### Build from source

The project requires Node.js 24.

```bash
git clone https://github.com/wuyifan-code/Claudian-plus.git
cd Claudian-plus
npm ci
npm run build
```

To copy the build into a local vault during development, set `OBSIDIAN_VAULT` before running the build:

```powershell
$env:OBSIDIAN_VAULT = "D:\Obsidian\My Vault"
npm run build
```

You can also put the variable in a local `.env.local` file. That file is ignored by Git and should never contain secrets committed to the repository.

## First-time setup

1. Install and authenticate the [Codex CLI](https://github.com/openai/codex), and make sure `codex` is available in your terminal.
2. Enable Claudian Plus and open its settings.
3. Select **Codex** as the provider. The model selector prefers `gpt-5.6-sol` when the CLI exposes it, and falls back to the available model list otherwise.
4. Keep the default permission mode at `normal` unless a task explicitly requires a different approval policy.
5. Configure Claude, OpenCode, or Pi separately if you want to use those providers. Enabling this plugin does not create or transfer their login state.

## Consciousness Settings

Navigate to **Settings → General → Consciousness**:

| Setting | Description |
|---------|-------------|
| **Consciousness Mode** | Enable cross-session memory and skill evolution |
| **Auto Memory** | Automatically extract important info from conversations |
| **View Awareness Files** | Open the `.claudian/awareness/` directory |
| **Reset All** | Clear all consciousness data |

### Commands

| Command | Description |
|---------|-------------|
| `Open memory file` | Open the memory file for manual editing |
| `Scan vault knowledge` | Index all vault notes for knowledge injection |

## Useful commands

Type these commands in the chat input:

- `/vault-search <query>` searches local vault sources and returns paths, headings, excerpts, and match terms.
- `/insight <topic>` prepares a source-backed insight task. Review the sources, then send it to the active agent.

You can drag a note, folder, or supported file from the vault into the input area. Notes are added as file context; folders are inserted as an editable `@folder/` reference.

## Privacy and permissions

- New installations use the `normal` permission mode by default.
- Provider settings, conversation data, and CLI login state stay in their existing local locations.
- The plugin does not include telemetry. Network requests happen only when you explicitly use a configured provider, MCP server, SDK, or CLI.
- Agent features may use shell execution, local filesystem access, clipboard integration, and vault enumeration. These capabilities are required for local coding-agent workflows; review the selected provider and permission mode before running sensitive tasks.
- Do not enable the official Claudian plugin and Claudian Plus in the same vault if both are configured to share the same `.claudian/` data directory.
- **Consciousness data** is stored locally in `.claudian/awareness/` and never leaves your vault.

## Development and verification

```bash
npm run typecheck
npm run lint
npm run test:architecture
npm run build
npm run check:performance
```

The release workflow installs from `package-lock.json`, builds on GitHub Actions, verifies the release version, generates artifact attestations, and uploads `main.js`, `manifest.json`, and `styles.css`.

## Architecture

```
src/core/memory/
├── ConsciousnessEngine.ts    # Core consciousness engine
├── MemoryExtractor.ts        # Explicit & implicit memory extraction
├── MemoryStore.ts            # Persistent memory storage
├── VaultKnowledgeEngine.ts   # Vault-wide knowledge indexing
├── consciousness-types.ts    # Type definitions
├── memoryPrompt.ts           # Memory injection formatting
└── types.ts                  # Base types
```

## Upstream and license

Claudian Plus is an enhanced fork of [Claudian](https://github.com/YishenTu/claudian). Improvements are developed in the public [Claudian Plus repository](https://github.com/wuyifan-code/Claudian-plus), and upstream-compatible changes are proposed through pull requests when appropriate.

This project is released under the [MIT License](LICENSE).
# Claudian Plus

[![GitHub stars](https://img.shields.io/github/stars/wuyifan-code/Claudian-plus?style=social)](https://github.com/wuyifan-code/Claudian-plus)
[![GitHub release](https://img.shields.io/github/v/release/wuyifan-code/Claudian-plus)](https://github.com/wuyifan-code/Claudian-plus/releases)
[![License](https://img.shields.io/github/license/wuyifan-code/Claudian-plus)](LICENSE)

Claudian Plus is a Codex-first AI workspace for local-first knowledge work. It combines Codex, Claude, OpenCode, and Pi in one desktop chat workspace while keeping notes, context, and provider sessions in your local vault.

## Highlights

- **Codex-first defaults** — use Codex as the default agent and prefer `gpt-5.6-sol` when that model is available in the local CLI.
- **Floating conversation outline** — keep a compact rail of user questions and assistant headings, with thoughts and tool output collapsed out of the outline.
- **Multiple providers** — switch between Codex, Claude, OpenCode, and Pi without changing the chat workspace.
- **Local conversation history** — search previous conversations by title, first message, provider, date, or model.
- **Note and folder context** — drag notes and folders into the chat input to add `@file` and `@folder/` context.
- **Vault search and insights** — use local source-backed search and an insight workflow that keeps citations and sends the resulting task to the active agent.
- **Existing Claudian workflows** — keep slash commands, skills, MCP, inline editing, multi-tab conversations, and provider-native sessions.

## Installation

### Install from a release

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/wuyifan-code/Claudian-plus/releases/latest).
2. Create `.obsidian/plugins/claudian-plus/` inside your vault.
3. Copy the three downloaded files into that directory.
4. Open the app's community plugin settings and enable **Claudian Plus**.

The plugin is desktop-only because it integrates with local agent CLIs and desktop filesystem capabilities.

### Build from source

The project requires Node.js 24.

```bash
git clone https://github.com/wuyifan-code/Claudian-plus.git
cd Claudian-plus
npm ci
npm run build
```

To copy the build into a local vault during development, set `OBSIDIAN_VAULT` before running the build:

```powershell
$env:OBSIDIAN_VAULT = "D:\Obsidian\My Vault"
npm run build
```

You can also put the variable in a local `.env.local` file. That file is ignored by Git and should never contain secrets committed to the repository.

## First-time setup

1. Install and authenticate the [Codex CLI](https://github.com/openai/codex), and make sure `codex` is available in your terminal.
2. Enable Claudian Plus and open its settings.
3. Select **Codex** as the provider. The model selector prefers `gpt-5.6-sol` when the CLI exposes it, and falls back to the available model list otherwise.
4. Keep the default permission mode at `normal` unless a task explicitly requires a different approval policy.
5. Configure Claude, OpenCode, or Pi separately if you want to use those providers. Enabling this plugin does not create or transfer their login state.

## Useful commands

Type these commands in the chat input:

- `/vault-search <query>` searches local vault sources and returns paths, headings, excerpts, and match terms.
- `/insight <topic>` prepares a source-backed insight task. Review the sources, then send it to the active agent.

You can drag a note, folder, or supported file from the vault into the input area. Notes are added as file context; folders are inserted as an editable `@folder/` reference.

## Privacy and permissions

- New installations use the `normal` permission mode by default.
- Provider settings, conversation data, and CLI login state stay in their existing local locations.
- The plugin does not include telemetry. Network requests happen only when you explicitly use a configured provider, MCP server, SDK, or CLI.
- Agent features may use shell execution, local filesystem access, clipboard integration, and vault enumeration. These capabilities are required for local coding-agent workflows; review the selected provider and permission mode before running sensitive tasks.
- Do not enable the official Claudian plugin and Claudian Plus in the same vault if both are configured to share the same `.claudian/` data directory.

## Development and verification

```bash
npm run typecheck
npm run lint
npm run test:architecture
npm run build
npm run check:performance
```

The release workflow installs from `package-lock.json`, builds on GitHub Actions, verifies the release version, generates artifact attestations, and uploads `main.js`, `manifest.json`, and `styles.css`.

## Upstream and license

Claudian Plus is an enhanced fork of [Claudian](https://github.com/YishenTu/claudian). Improvements are developed in the public [Claudian Plus repository](https://github.com/wuyifan-code/Claudian-plus), and upstream-compatible changes are proposed through pull requests when appropriate.

This project is released under the [MIT License](LICENSE).
