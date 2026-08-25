# Project authority transfer

## Ownership

- This scope owns production LAN-to-Cloud and Cloud-to-LAN phase policy, source/target orchestration, semantic checkpoint capture/import, transfer-claim custody and redemption convergence, authority-generation movement, cancellation, terminal settlement, and restart recovery.
- Persist Project-local transfer records and operation-owned artifacts through `CollabLocalProjectRepository`. Register startup enumeration and recovery through `CollabProjectLifecycleSubsystem`; do not create a second Vault catalog, lifecycle subsystem, Project index, or physical-state owner.
- Reuse Project admission tokens, work-session drain/reset, Host start guards, origin and membership replacement, index reconstruction, retirement handling, and local Keep/Delete cleanup through their owning seams. Do not mutate their files or infer completion around them.
- `bootstrap/` remains a private two-client development fixture. `HostTransferPackage` remains physical LAN-to-LAN Host handoff. Neither is a production transfer transport, checkpoint, claim, or recovery mechanism.
- Before Host acceptance changes Project admission, acquire the existing `CollabProjectLifecycleSubsystem` per-Project lifecycle arbiter and re-enter it during every recovery attempt. A nonterminal physical Host transfer, Leave/cleanup, Retire/acknowledgement, private bootstrap, Manager-responsibility handoff, or another authority transfer must settle through its own owner or block; coordinator-local inspection never cancels or bypasses it. `ProjectOperationAdmission` supplies the later ordinary-work drain/suspension token but is not the lifecycle arbiter.

## Authority and identity

- Any authenticated active LAN Member may propose one exact canonical Cloud URL and stable intent. Only the current LAN Host may accept that exact proposal, settle pending admission, quiesce, capture, upload, retain claim custody, and commit source relinquishment. Presence is never consent or identity proof and all-online participation is never required.
- LAN-to-Cloud initially binds only the source Host through the accepted source proof. Cloud-to-LAN initially binds only the selected target Host through its provisional authority and locally generated credential. Every other imported active Member remains unbound until exact claim redemption.
- Before cutover, the source durably retains the complete raw claim batch and the target durably acknowledges its exact digest. Batch acknowledgement proves custody only. A source-held claim is scrubbed only after the same former Member forwards an exact target-signed redemption receipt or after bounded expiry.
- A LAN claimant generates and durably stores its own credential before submitting only its hash. Claims never authenticate Cloud ingress, issue credentials, create membership, choose roles, move refs, or bind a different Member.

## Lifecycle and recovery

- Existing authorities begin at generation `1`; the target activates at exactly `source + 1`. Before source relinquishment, cancellation must prove the target did not accept the fence. At or after relinquishment every owner recovers forward and no Host start or local recovery path may reopen the source.
- Host acceptance closes invitation and Join admission, revokes live invitations, and settles recoverable pending Joins through their owner. Divergent or ambiguous pending state blocks transfer and is never serialized.
- Logical checkpoint production excludes SQLite bytes, credentials, invitation secrets, CA private keys, working trees, unpublished files, caches, and local-only drafts/commits. Capture binds one quiesced authority snapshot to the exact allowed repository ref/OID inventory and package-owned manifest.
- Raw claim batches, checkpoint artifacts, and target staging are permission-restricted operation-owned state with durable intent before creation and exact cleanup on allowed cancellation, completion, or expiry. Never persist absolute paths in the transfer record or log content, claims, credentials, endpoints, or Git output.

## Verification

- Use TDD at the coordinator and owning persistence seams. Kill recovery after every durable phase and prove exact replay, source non-restart after relinquishment, target generation, no dual writer, retained offline-Member convergence, one-claim receipt scrubbing, and cleanup of only exact operation-owned staging.
- Keep ordinary-user UI absent until the Step 13 capability-gated entry work. Internal composition and test drivers may invoke only complete negotiated operations.
