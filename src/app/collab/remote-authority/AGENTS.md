# Remote Collab authority

## Ownership

- `CollabAuthoritySessionFactory` is stateless. It constructs one membership-generation session composed of authority-neutral control, event, and Git-network ports, then transfers disposal ownership to `CollabProjectWorkSession`.
- `CollabProjectWorkSessionRegistry` remains the sole retained per-Project lifecycle registry. A work session owns at most one authority session, event connection, refresh queue, and mutation queue and closes them before its membership generation changes.
- `LanAuthorityAdapter` wraps the existing LAN clients and lifecycle extensions without changing LAN v9 binding, credentials, CA pinning, discovery, Host, or transfer semantics.
- `CloudAuthorityAdapter` owns Cloud binding-v1 capability negotiation, package-owned route construction and codecs, development-principal presentation, snapshot and event adaptation, safe binding-error mapping, and Git endpoint construction. It never implements server Project policy or translates Cloud lifecycle into LAN lifecycle.
- `CloudAuthorityError` centralizes only the shared safe-error construction mechanics used by the Cloud adapter and transport. Each caller still owns when a binding or transport condition maps to that vocabulary.
- `NodeCloudAuthorityHttpTransport` owns the production desktop JSON request lifecycle behind `CloudAuthorityHttpTransport`: Node HTTP/HTTPS dispatch, caller cancellation, deadline teardown, bounded response consumption, JSON decoding, and sanitized transport failures. It is stateless across calls, never follows redirects, and never disables native TLS verification.

## Dependency and safety

- Publication, projection, review, reconciliation, feature, UI, and Agent-facing services depend on the neutral ports and never construct LAN or Cloud transports directly.
- Cloud Projects expose only negotiated capabilities. Host transfer, membership administration, Manager responsibility, Leave, Retire, and LAN diagnostics remain LAN-only and must not fall back to a stale LAN session.
- The Obsidian desktop Cloud path must not depend on renderer `fetch` or server-side browser CORS permission. Plain HTTP remains restricted to canonical loopback origins by `CloudAuthorityUrls`; non-loopback Cloud origins require HTTPS.
- Canonicalize self-host URLs once and compare exact normalized values. Git environments may carry multiple headers and an optional CA path. Credential-bearing headers are sensitive by default and their values plus private paths never enter process arguments, logs, errors, or persisted diagnostics. A non-credential routing header must be explicitly marked non-sensitive so its domain identifier may independently appear in a Git ref argument; the header itself still enters Git only through the isolated environment.

## Verification

- Adapter contract tests keep owned application modules real, prove LAN behavior is preserved, prove unknown Cloud capabilities are ignored while unknown binding/wire/schema values fail closed, and prove replacing a membership generation disposes the old session exactly once.
- Default Cloud transport tests use real loopback HTTP with renderer `fetch` disabled and cover cancellation, deadline, response bounds, redirect containment, cleanup, and sanitized failures. Headless Node adapter success alone does not prove the installed Obsidian composition path.
