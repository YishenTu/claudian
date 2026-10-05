# Side chat constraints

- A temporary child conversation owns execution, rendering and settings in memory only; it never reaches conversation persistence or view-scoped tab state. Seed it with returned fork state alone, never the parent's established provider session id. Providers own native ephemeral fork support and any initial context fallback. Side chat sessions are never idle-released; lost native context requires a new side chat, never transcript rehydration.
