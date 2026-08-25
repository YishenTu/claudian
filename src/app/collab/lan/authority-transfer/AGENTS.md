# LAN authority-transfer binding

## Ownership

- This scope owns the dedicated authenticated LAN Project-authority-transfer binding and client. Its version is independent from Project-control v9, Git v1, and physical Host-transfer v6.
- Package-owned DTO meaning is adapted at this boundary. Method, path, LAN envelope, version, request source, bearer extraction, authentication, active-versus-terminal admission, dispatch, success status, and parameter matching remain local. Do not create a second shared operation/codec registry or change existing LAN control routes for import convenience.
- Source-active routes authorize Member proposal, exact Host acceptance, source status, quiescence/capture coordination, and pre-cutover cancellation. Target-only-staged routes expose only exact target acceptance, provisional authority proof, bounded checkpoint receipt/stage status, and source-fence observation; they deny ordinary Project control, Git, Host start, claim redemption, and discovery advertisement. After exact source relinquishment, `LanHostCoordinator` atomically promotes that same staged target registration to target-active with the next authority generation. Target-active routes authorize an authenticated unbound imported Member to redeem only its exact Cloud-to-LAN transfer claim, atomically install its already persisted client-generated credential hash, and receive the replayable target-signed receipt; this is not Join or membership creation. Terminal-only source routes authorize exact transfer status, redirect, retrieval of only the authenticated former Member's retained claim, and forwarding of that Member's target-signed redemption receipt.

## Listener lifecycle

- The real Vault-scoped HTTPS listener and all four registration states remain owned by `LanHostCoordinator`. Authority transfer requests source-active, target-only-staged, atomic target-active promotion, or terminal-source registration through that owner; it does not open a hidden listener, reuse the physical Host-transfer provisional router, or retain a parallel router.
- Terminal route state is authenticated, content-minimal, restart-recoverable, and bounded to 30 days. Expiry removes only the exact responder and source-held claims through their owning transfer record. Terminal routing cannot start a Host, admit ordinary Project traffic, mint replacement claims, change membership/role, or serve another Member's claim.
- Listener replacement, preferred-address change, shutdown, and process restart must preserve the exact registration state. A target-only-staged registration recovers inert until exact Cloud relinquishment proof permits promotion, and a terminal source can never return to source-active. The coordinator closes route resources and sockets in its existing order.

## Verification

- Binding tests cover independent version negotiation, target-only ordinary-control/Git/Host-start denial, exact source-active/target-active/terminal-source authorization, promotion only after exact source-fence proof, wrong-Member and cross-Project denial without identity leakage, replayable claim and receipt delivery, listener replacement, restart, expiry, and shutdown cleanup.
