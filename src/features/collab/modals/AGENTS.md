# Collab Modals

## Transient Lifetime

- `CollabTransientSurfaceRegistry.ts` is the composition-owned plugin-lifetime registry for Create, Join, Reconnect, and Project-management surfaces. Live disable or unload closes and aborts every registered modal before Collab service teardown.
- Asynchronous modal launch revalidates the captured Collab lifecycle after every await before opening UI. Each modal retains its own operation admission, AbortController, close behavior, and stale-completion fence; no operation may update or reopen a closed surface.

## Project Management

- `project/ProjectManagementModal.ts` opens without an online coordination preflight and always exposes local LAN Host controls for a Host-owned Project. It owns the later snapshot for Member identity/list presentation, confirmation focus, and access-operation retry. LAN Host, Invite, Leave, and Retire remain in one stable footer; successful Host start retries the snapshot in place.
- Manager promotion, demotion, removal, and responsibility-offer actions retain one mutation intent across the modal's explicit Retry. Clear it only after success, user cancellation, identity change, or modal close; otherwise a lost response cannot reach the authority's exact idempotent replay. Promotion confirmation also freezes whether the operation creates an offer or completes one, including the exact offer ID; a snapshot refresh must not change that operation while Retry remains available.
- `project/ProjectInvitationModal.ts` owns transient invitation creation, text, copy, revoke, and retry. `project/HostDiagnosticsModal.ts` owns redacted Host diagnostics presentation and copy. Project Management closes either child surface on close so their operations cannot outlive the registered parent.
- Manager invitation/administration permission is independent from Host capability. Removal copy must not imply remote deletion. Leave copy must distinguish visible-file retention from removal of collaboration Git history.
- Project Management owns the only Leave and Retire actions. Leave offers Keep local files by default and Delete local files as the destructive alternative for every role. Responsibility requirements come from the authority projection, never a cached member-list inference.
- Manager responsibility offers are visible only to source and target. The target acknowledges Manager responsibility through synchronization, so do not add Accept Manager. Accept Host appears only on the selected target's own row; acceptance is progress, not completion. Retire is available only to a synchronized Manager and explains that collaboration and Git-only history end for everyone.

## LAN Host Controls

- `project/LanHostSection.ts` renders only local Host capability inside Project Management and owns its in-flight start/stop presentation fence. It must not infer Manager permission or expose invitation or membership actions.
- Host creation persists auto-start intent and starts LAN hosting immediately. Listener startup failure never rolls back the durable Project; Project Management remains available for retry and redacted diagnostics.

## Create, Join, and Reconnect

- Project creation is empty-only. `project/CreateProjectModal.ts` collects only Project name and initial Member display name; it never discovers, previews, selects, copies, or summarizes Vault files.
- Create, Join, and Reconnect prevent duplicate submission, abort active work on close, ignore stale completion, and preserve retry input. Durable-progress results expose the existing Resume setup operation instead of rotating operation intent.

## Verification

- Test through fake ports for duplicate admission, cancellation on close, stale completion, recovery-required Resume, local Host start/stop fencing, snapshot retry, responsibility visibility, Leave cleanup choice, and Retire synchronization gating.
