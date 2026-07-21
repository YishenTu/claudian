# Grok Provider

`src/providers/grok/` adapts Grok Build through Agent Client Protocol over a `grok agent --no-leader stdio` subprocess.

## Ownership

- Grok process/session lifecycle, xAI protocol extensions, native-history hydration, model catalogs, tool normalization, settings reconciliation, UI, and auxiliary services live here.
- Shared code consumes Grok only through provider-neutral runtime, capability, registry, and workspace-service contracts.
- Provider-owned conversation data stays behind `GrokProviderState` helpers; feature code must not inspect it.

## Protocol and Session Rules

- Account authentication is Grok-native. Never call ACP `authenticate` automatically or persist xAI credentials.
- Preserve `Conversation.sessionId` and provider state across prompt, CLI-path, and environment changes. Recycle the process and load the same native session.
- Use Grok's native history read-only. Never delete or mutate a Grok session when a Claudian conversation is deleted.
- Keep Grok/xAI tools enabled and preserve unknown tool data losslessly. Adapt Grok task-family lifecycle calls into the shared subagent renderer while retaining their raw names and payloads.
- Expose Safe and YOLO only. Claudian does not expose Grok plan mode.

## Models and Settings

- Model selections are `grok/<raw-id>` in Claudian and raw ids on the ACP wire. The discovered catalog default is the provider default.
- Catalog snapshots are current-device scoped and contain only normalized non-secret metadata.
- Expose Low, Medium, and High as the initial fallback for enabled models. After a real ACP session, persist and prefer the chosen model's advertised reasoning metadata; never create a session solely for discovery, and prune reasoning state when a model is disabled.
- Do not rewrite `~/.grok/config.toml`, own BYOK endpoints, or source shell startup files.
- Do not add a generic ACP runtime superclass; share protocol primitives while keeping xAI behavior provider-owned.

## Repository Instructions vs Runtime Instructions

- This `AGENTS.md` is a repository developer guide for contributors editing Claudian's Grok adapter.
- Vault/runtime `AGENTS.md` files belong to the user and are discovered natively by Grok.
- Claudian must never create, import, append, suppress, rewrite, or explicitly inject vault/runtime `AGENTS.md` files.

## Evidence and Fixtures

- Provider behavior that is not established by standard ACP must be backed by sanitized Grok protocol evidence.
- Put raw captures and throwaway scripts in `.context/`. Never commit credentials, private prompts, absolute personal paths, or raw user configuration.
