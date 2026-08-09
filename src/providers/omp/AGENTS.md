# OMP Provider

`src/providers/omp/` adapts Oh My Pi through the OMP ACP subprocess and OMP-owned CLI metadata commands.

## Ownership

- OMP launch policy, environment isolation, ACP sessions, model discovery, tool normalization, history, settings, and provider state remain in this directory.
- Reuse `src/providers/acp/` for transport, permissions, session updates, and event normalization; do not assume ACP providers expose the same model or tool semantics.
- OMP model discovery uses `omp models --json` as the complete catalog. ACP config options are used for session configuration such as thinking levels, not as a substitute for the full catalog.

## Isolation Rules

- OMP must not inherit `PI_*` environment variables or Pi data/configuration directories. Keep the filtering in `OmpLaunchSpec` and apply it to both runtime and metadata subprocesses.
- OMP model selections use the `omp:` namespace. Never route an OMP model through Pi's `pi:` namespace or infer provider ownership from an unscoped raw model ID.
- OMP settings writers must merge provider-owned fields and normalize persisted catalog, thinking, environment, and CLI-path values before use.

## Protocol and Presentation

- Live output comes from ACP notifications and is normalized through the shared ACP execution normalizer plus OMP's tool presentation adapter.
- OMP ACP titles such as `Reading ... for context` must be mapped to shared tool names before reaching feature renderers; keep provider-specific mappings here.
- Model discovery runs in an independent metadata subprocess. It must not reuse a conversation session or mutate provider-native history.

## Verification

- Test model JSON parsing, `omp:` model namespacing, Pi environment filtering, ACP tool-name normalization, and thinking-option projection at their provider-owned seams.
- When OMP behavior is uncertain, inspect real `omp models --json` or ACP output first and keep captures or throwaway probes under `.context/`.
