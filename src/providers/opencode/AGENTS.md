# OpenCode constraints

- Managed launch artifacts may layer over user configuration, never replace it.
- Preserve the conversation's trusted database path across session updates until a typed history/environment transition replaces it. Recovery locators cannot become live bindings.
- File requests use the kernel's captured working directory and approval policy, including out-of-directory requests; feature code must not recreate that policy.
- Session-based model/command probes use isolated metadata storage. V2 may query native catalog endpoints with the native database to retain saved credentials, but must never create a session. Discovery must not create a real chat session for history-backed conversations lacking a native binding.
- Environment/CLI fingerprint changes invalidate native bindings and fence discovery publication; keep catalog rows until explicit refresh.
- V2 keeps saved credentials in its native database, so executions that request in-memory storage run against the native database and delete their native session on disposal.
- V2 consumers may share a process for a compatible environment and persistent database, including auxiliary sessions as an exception to independent process ownership. Sessions still own cancellation and interactions independently; in-memory execution and different database bindings require separate processes. Dynamic system instructions must use distinct agent definitions, never mutate an agent used by another session.
- Preserve SQLite-reader fallbacks needed by different Obsidian runtime environments.
