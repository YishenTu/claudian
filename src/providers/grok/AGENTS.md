# Grok Provider

`src/providers/grok/` adapts Grok Build through Agent Client Protocol over a `grok agent --no-leader stdio` subprocess.

## Dependency Boundary

- Standard ACP transport and interaction mechanics may be shared. xAI extensions, launch policy, model semantics, tool normalization, session metadata, and history interpretation remain Grok-owned.
- Do not add a generic ACP runtime superclass. Share protocol primitives while keeping provider policy and lifecycle explicit.

## Ownership

| Area | Owns |
| --- | --- |
| `execution/` | Grok process/session binding, native connection, execution state, interaction routing, snapshots, and recovery |
| `runtime/` | CLI resolution, xAI extension calls, model-catalog discovery, environment construction, and notification normalization |
| `history/` | Read-only native-history discovery and replay projection |
| `app/` and `commands/` | Workspace command metadata and model-catalog coordination |
| `types.ts` and provider settings | Typed Grok provider state and current-device discovery snapshots |

- Provider-owned conversation data stays behind `GrokProviderState` helpers; feature code must not inspect it.

## Protocol and Session Rules

- Account authentication is Grok-native. Never call ACP `authenticate` automatically or persist xAI credentials.
- Preserve `Conversation.sessionId` and provider state across prompt, CLI-path, and environment changes. Recycle the process and load the same native session.
- Use Grok's native history under `~/.grok/sessions/` read-only.
- Send image attachments as ACP image content blocks and rehydrate their persisted native blocks. Use Grok's `_x.ai/interject` and `_x.ai/session/fork` extensions behind typed provider-owned boundaries for steering and forks.
- Keep Grok/xAI tools enabled and preserve unknown tool data losslessly. Adapt Grok task-family lifecycle calls into the shared subagent renderer while retaining their raw names and payloads.
- Expose Safe, Plan, and YOLO. Plan is a native ACP session mode layered over the remembered Safe or YOLO base; native mode updates remain authoritative.

## Models and Settings

- Model selections are `grok/<raw-id>` in Claudian and raw ids on the ACP wire. The discovered catalog default is the provider default.
- Catalog snapshots are current-device scoped and contain only normalized non-secret metadata.
- Expose Low, Medium, and High as the initial fallback for enabled models. After a real ACP session, persist and prefer the chosen model's advertised reasoning metadata; never create a session solely for discovery, and prune reasoning state when a model is disabled.
- Do not rewrite `~/.grok/config.toml`, own BYOK endpoints, or source shell startup files.
- Any change to Grok environment text or resolved CLI-path fingerprint clears device discovery state and reloads provider processes while preserving native conversation identifiers.

## Repository Instructions vs Runtime Instructions

- This `AGENTS.md` is a repository developer guide for contributors editing Claudian's Grok adapter.
- Vault/runtime `AGENTS.md` files belong to the user and are discovered natively by Grok.
- Claudian must never create, import, append, suppress, rewrite, or explicitly inject vault/runtime `AGENTS.md` files.

## Evidence and Fixtures

- Provider behavior that is not established by standard ACP must be backed by sanitized Grok protocol evidence.
- Put raw captures and throwaway scripts in `.context/`. Never commit credentials, private prompts, absolute personal paths, or raw user configuration.
