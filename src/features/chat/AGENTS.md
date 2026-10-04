# Chat constraints

- Conversation, persisted tab shell, runtime tab, hydration, and provider execution have independent lifetimes. Layout/selection/hydration cannot create provider execution, rewrite durable identity, or cancel another tab's turn.
- A tab's provider session lives until close, rebind, or 30 idle minutes. Idle release requires no turn, interaction, background work, or tab-owned busy state, and preserves hydrated UI/resume state.
- History previews are provisional until explicit retention. Returning to compact mode must finish preview cleanup before exposing controls that could target closing tabs.
- Persist view-scoped tab shells only, never composer drafts, hydrated messages, DOM, turns, or lifecycle values. Restore inactive shells before one final activation. Provider command discovery runs only on demand for the active tab (live session snapshot first, then an isolated metadata probe); it never runs eagerly and cannot create chat sessions.
- Restore follows Obsidian's delivered state, not early onOpen synthesis. Same-instance reopen uses the finalized shutdown snapshot. Versioned snapshots reject malformed/duplicate identities as a whole; permissive normalization is legacy-only.
- Optimistic tab presentation must not enter persistence before admission/switch commit. Failed assembly/activation restores the prior committed owner; post-commit observer failure cannot undo membership.
- Close pauses intent admission reversibly until replacement/successor publication succeeds. Keep required runtime state callbacks available during preflight and drain; duplicate close/destroy must not repeat effects.
- Shutdown joins navigation and drains all admitted work before sealing final identity. While restoration is pending, its full plan remains the persistence authority, not partially assembled membership.
- Forking captures and revalidates the source binding across every await; never use whichever tab becomes current later.
- First canonical input freezes Linked content for both creation and provider context. Create failure restores the draft; post-create failure leaves a locked conversation whose retry is still the first turn. Later/steered/compact turns must not resend it through a mutable sent flag.
- Blank-tab provider transitions serialize and roll back to the last stable draft. Model-picker intents affect only the selected tab/conversation and the future-tab seed; existing tabs must not subscribe to that seed.
- Conversation authority is revalidated after session preparation immediately before provider handoff. Superseded preparation cannot install or publish resources.
- A temporary child conversation owns execution, rendering and settings in memory only; it never reaches conversation persistence or view-scoped tab state. Seed it with returned fork state alone, never the parent's established provider session id. Providers own native ephemeral fork support and any initial context fallback. Side chat sessions are never idle-released; lost native context requires a new side chat, never transcript rehydration.

## Surface and input behavior

- Model selection alone must not change displayed context usage. Retain the previous complete report until the new model reports a usable window; never combine one model’s token count with another model’s window.
- Render and submit model/reasoning from the same destination-owned settings. Submission cannot rederive them from provider-wide defaults; side chat owns its selection in memory.

- Dynamic Main Agent sections are best-effort system configuration; failures must not block Chat.
- One composer serves every destination, and its target is derived from presentation state rather than a separately mutable selection. User-originated sends and cancels resolve the target when they run; internally queued main work keeps the owner it was admitted with and must never read the current target at dispatch.
- Zen mode relocates the active runtime's existing transcript and composer through the view's placement owner; it never builds a second view, composer, renderer, or cloned transcript. Release restores every moved node before its host is removed, and showing, hiding, or disclosure cannot create conversations, switch tabs, send, cancel, or change the destination.
