# Chat constraints

- Conversation, persisted tab shell, runtime tab, hydration, and provider execution have independent lifetimes. Layout/selection/hydration cannot create provider execution, rewrite durable identity, or cancel another tab's turn.
- Unlimited tabs do not imply unlimited warm execution. Cooling may evict only idle owners and preserves hydrated UI/resume state; unresolved interactions protect execution.
- History previews are provisional until explicit retention. Returning to compact mode must finish preview cleanup before exposing controls that could target closing tabs.
- Persist view-scoped tab shells only, never composer drafts, hydrated messages, DOM, turns, or lifecycle values. Restore inactive shells before one final activation; history warmup may perform isolated command discovery but cannot create chat sessions.
- Restore follows Obsidian's delivered state, not early onOpen synthesis. Same-instance reopen uses the finalized shutdown snapshot. Versioned snapshots reject malformed/duplicate identities as a whole; permissive normalization is legacy-only.
- Optimistic tab presentation must not enter persistence before admission/switch commit. Failed assembly/activation restores the prior committed owner; post-commit observer failure cannot undo membership.
- Close pauses intent admission reversibly until replacement/successor publication succeeds. Keep required runtime state callbacks available during preflight and drain; duplicate close/destroy must not repeat effects.
- Shutdown joins navigation and drains all admitted work before sealing final identity. While restoration is pending, its full plan remains the persistence authority, not partially assembled membership.
- Forking captures and revalidates the source binding across every await; never copy accepted input from whichever tab becomes current later.
- First canonical input freezes Linked content for both creation and provider context. Create failure restores the draft; post-create failure leaves a locked conversation whose retry is still the first turn. Later/steered/compact turns must not resend it through a mutable sent flag.
- Blank-tab provider transitions serialize and roll back to the last stable draft. Model-picker intents affect only the selected tab/conversation and the future-tab seed; existing tabs must not subscribe to that seed.
- Conversation authority is revalidated after accepted-input staging and session preparation immediately before provider handoff. Superseded warm preparation cannot install or publish resources.

## Surface and input behavior

- Dynamic Main Agent sections are best-effort system configuration; failures must not block Chat. Collab references insert visible text only and cannot mutate selected Project or persist hidden entity metadata.
- Live Collab disable destroys its surface while preserving the chat tab. Plugin-lifetime composer ports reset to unavailable rather than terminal disposal; compact/dual presentation reuse one controller/tree.
- Horizontal swipes rely on native snap scrolling and scrollend. Do not cancel wheel events, classify gestures by idle/delta heuristics, or move the strip with transforms; Chromium retains the stationary pointer's wheel target through the transaction.
- Preload may prepare a drag target without activating it. Commit semantic surface state only after snap completion; the two-surface visual replica stays inert and owns no controller/state.
- Bang-bash bypasses provider execution, so gate it by the provider's UI capability.
