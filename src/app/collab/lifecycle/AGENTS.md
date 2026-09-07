# Project lifecycle subsystem

## Ownership

- `CollabProjectLifecycleSubsystem` is the single app-owned assembly, recovery registration, and per-Project arbitration boundary for Leave, Retire, physical Host transfer, production authority transfer, private bootstrap transition, responsibility handoff, retirement acknowledgement, and local cleanup.
- Each lifecycle module retains its own authorization, phases, persistence, physical effects, and recovery policy. The subsystem owns only mutually exclusive transition admission, stable owner dispatch, startup ordering, and common close/drain; it never interprets another owner's journal or becomes a generic phase engine.
- Register Project-local recovery through `CollabLocalProjectRepository` and the existing subsystem enumeration. Vault-wide pending-Leave and applied-Retired-cleanup journals remain with `CollabLifecycleJournalStore`. Do not add a second Project catalog or infer pending work from the Project index.

## Arbitration

- One Project may have at most one admitted irreversible lifecycle transition. Proposal/read-only status may coexist where its owner permits, but Host acceptance, authority quiescence, Retire commitment, Host-transfer preparation, and destructive local cleanup require the per-Project lifecycle arbiter before `ProjectOperationAdmission` is suspended or physical state changes.
- Every operation and startup recovery reacquires the same arbiter, reads the durable summaries from each owning module, and dispatches the exact nonterminal owner first. A competing operation proceeds only after that owner proves terminal settlement. Unknown, corrupt, divergent, or multiply nonterminal state fails the Project closed.
- `ProjectOperationAdmission` still owns ordinary feature-operation entry, suspension tokens, and drain. It cannot replace lifecycle arbitration because it does not know durable cross-owner state. Coordinator-local flags or checks cannot replace either owner.
- Shutdown closes new lifecycle admission, waits for admitted arbitration to settle within the lifecycle budget, preserves every durable record on ambiguity, and closes underlying stores only after recovery workers stop.

## Verification

- Use real owner records in subsystem tests. Prove each alternate lifecycle entry and recovery path is mutually excluded, a different Project proceeds, stale proposal state grants no permit, exact terminal settlement unblocks the next transition, and ambiguous multi-owner state never reaches ordinary Project admission or Host start.
