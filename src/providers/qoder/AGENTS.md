# Qoder Provider

`src/providers/qoder/` adapts Qoder through `@qoder-ai/qoder-agent-sdk`, which launches and controls `qodercli`.

## Ownership

- Qoder query/session lifecycle, native-history hydration, model discovery, commands, skills, agents, settings reconciliation, UI, and auxiliary services live here.
- Shared code consumes Qoder only through provider-neutral runtime, capability, registry, and workspace-service contracts.
- Provider-owned conversation data stays behind `QoderProviderState` helpers; feature code must not inspect it.

## SDK and Session Rules

- Reuse Qoder-native authentication through `qodercli` or `QODER_PERSONAL_ACCESS_TOKEN`; never persist credentials in Claudian state.
- Qoder queries are turn-scoped. Preserve the native session ID in provider state and resume it for later turns instead of treating the query object as a persistent runtime.
- Use Qoder-native transcripts read-only for history. Never delete or mutate native history when a Claudian conversation is deleted.
- Send images as SDK base64 image content blocks and rehydrate persisted image blocks from native history.
- Use SDK `forkSession` for checkpoint forks, `rewindFiles` for file rewind, and priority-`now` `streamInput` for steering an active turn.
- Route `AskUserQuestion`, `ExitPlanMode`, approvals, and managed-agent tools through the shared UI only at the Qoder SDK boundary.

## Models and Settings

- Model selections are `qoder/<raw-id>` in Claudian and raw IDs on the SDK wire.
- Runtime model metadata is authoritative when Qoder reports it. Preserve discovered context windows, reasoning efforts, aliases, and enabled-model visibility through settings normalization.
- Only expose fallback reasoning controls for routed/default models whose SDK metadata permits reasoning. Do not invent controls for explicitly non-reasoning models.
- Keep CLI paths current-device scoped. Pass provider environment variables only to Qoder and preserve existing provider settings while reconciling environment changes.
- Qoder is opt-in and must stay disabled by default.

## Skills, Commands, and Agents

- Claudian-managed shared skills live only under `.agents/skills`.
- Composer commands, skills, and agent mentions come exclusively from Qoder SDK discovery. Do not synthesize runtime entries by scanning the shared skill repository.
- Resource-generation invalidation must refresh Qoder command, skill, and agent snapshots without leaking credentials or raw environment values into cache keys.

## Repository Instructions vs Runtime Instructions

- This `AGENTS.md` is a repository developer guide for contributors editing Claudian's Qoder adapter.
- Vault/runtime `AGENTS.md` files belong to the user and are discovered natively by Qoder.
- Claudian must never create, import, append, suppress, rewrite, or explicitly inject vault/runtime `AGENTS.md` files.

## Evidence and Tests

- Provider behavior not established by the public SDK types or documentation must be backed by sanitized runtime evidence.
- Put raw captures and throwaway scripts in `.context/`. Never commit credentials, private prompts, absolute personal paths, or raw user configuration.
- Mirror Qoder tests under `tests/unit/providers/qoder/` and use the SDK mock instead of loading the ESM runtime in Jest.
