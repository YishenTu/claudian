# Remote Collab authority

## Ownership

- `CollabAuthoritySessionFactory` is stateless. It constructs one membership-generation session composed of authority-neutral control, event, and Git-network ports, then transfers disposal ownership to `CollabProjectWorkSession`.
- `CollabProjectWorkSessionRegistry` remains the sole retained per-Project lifecycle registry. A work session owns at most one authority session, event connection, refresh queue, and mutation queue and closes them before its membership generation changes.
- `LanAuthorityAdapter` wraps the existing LAN clients and lifecycle extensions without changing LAN v9 binding, credentials, CA pinning, discovery, Host, or transfer semantics.
- `CloudAuthorityAdapter` owns Cloud binding-v1 capability negotiation, package-owned route construction and codecs, development-principal presentation, snapshot/event transport, safe error mapping, and Git endpoint construction. It never implements server Project policy or translates Cloud lifecycle into LAN lifecycle.

## Dependency and safety

- Publication, projection, review, reconciliation, feature, UI, and Agent-facing services depend on the neutral ports and never construct LAN or Cloud transports directly.
- Cloud Projects expose only negotiated capabilities. Host transfer, membership administration, Manager responsibility, Leave, Retire, and LAN diagnostics remain LAN-only and must not fall back to a stale LAN session.
- Canonicalize self-host URLs once and compare exact normalized values. Git environments may carry multiple redacted headers and an optional CA path; credentials, header values, and private paths never enter process arguments, logs, errors, or persisted diagnostics.

## Verification

- Adapter contract tests keep owned application modules real, prove LAN behavior is preserved, prove unknown Cloud capabilities are ignored while unknown binding/wire/schema values fail closed, and prove replacing a membership generation disposes the old session exactly once.
