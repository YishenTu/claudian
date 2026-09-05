# OpenCode constraints

- Managed launch artifacts may layer over user configuration, never replace it or claim ownership of native history.
- Preserve the conversation's trusted database path across session updates until a typed history/environment transition replaces it. Historical model recovery must not promote a recovery locator into a live binding.
- File requests use the kernel's captured working directory and approval policy, including out-of-directory requests; feature code must not recreate that policy.
- Model/command probes use isolated metadata storage. Discovery must not create a real chat session for history-backed conversations lacking a native binding.
- Environment/CLI fingerprint changes invalidate native bindings and discovery together.
- Preserve SQLite-reader fallbacks needed by different Obsidian runtime environments.
