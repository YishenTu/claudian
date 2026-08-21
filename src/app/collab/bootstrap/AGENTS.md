# Private Cloud bootstrap

## Authority transfer

- This scope owns private two-client readiness/report orchestration, the former-Host stop fence, activation request/replay, and the client-local binding transition. It does not own Cloud server activation policy, LAN Host-transfer protocol, or production onboarding.
- Persist the non-restart Host fence and drain Project work sessions and Git children before the source Host begins bootstrap. Step 5 may complete with Cloud activated and both clients still holding pending local transition intent; terminal binding waits for step 6 snapshot and upload-pack.
- Both Members submit independent actor-bound reports. The source Host cannot attest for the other Member, and no path uploads SQLite, credentials, CA material, Project-directory archives, unpublished files, local-only commits, or private drafts.

## Binding lifecycle

- One transition record is the sole phase authority and advances only through `intent`, `readiness-confirmed`, `origin-rotated`, `cloud-verified`, `membership-replaced`, `index-repaired`, `lan-authority-retired`, and `fence-terminal`.
- `membership-replaced` atomically installs the strict tagged Cloud membership and is the adapter-selection boundary. The separate Project index is derived and repaired afterward; neither file duplicates the transition phase.
- `lan-authority-retired` atomically moves only the former Host's exact inactive authority directory to an attempt-scoped private directory on the same filesystem. The other client records a no-op. Retained data is inert diagnostic state and is never opened, auto-started, or treated as rollback authority.
- Recovery revalidates exact old/new URLs, repository identity, activation identity, membership, index, and retired-authority observations at every phase. After Cloud activation, recovery only moves forward or remains visibly pending; it never restores LAN authority or clears the terminal non-restart fence.
- Preserve unpublished files, local commits, private drafts, and cache-rebuild ability throughout binding. The Cloud membership contains server URL, binding/wire versions, derived Git URL, and development actor ID only; it contains no active LAN credential, CA, Host ownership, or recovery phase.
