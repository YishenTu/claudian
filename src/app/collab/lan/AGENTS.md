# LAN constraints

- Project-control, Git, provisional physical handoff, and authority-transfer bindings have independent versions and admission policies. Never couple them for import convenience; reject unsupported control versions before body/authentication effects.
- Use the installation-scoped CA/lock. Refresh endpoints only under proven pinned trust; initial invitation trust probes without credentials and completes CA/IP-SAN validation before sending secrets.
- Explicit Host stop clears auto-start intent; unload only releases resources. Startup/recovery must pass the same Host-installation and durable restart guards as explicit start.
- Address replacement starts under the same CA before retiring the old listener. Persist all affected memberships before publication; failure retains the old route and retryability. Missing interfaces must not close a still-reachable listener.
- Transfer registrations can pin a distributed endpoint; ordinary address monitoring cannot override that pin. Read the authority-transfer child guide before changing registration/rebind behavior.
- Stop makes routes unavailable and begins bounded socket/child teardown before waiting for durable invitation revocation.
- Expose Git only after managed receive policy, protected hook, quota, and integrity checks. Reauthenticate immediately before registering a Git child after awaited admission.
- Pending credentials permit activation/initial clone, never ordinary control or receive-pack. Receive-pack may update only the authenticated Member's personal ref, without deletion or force; credentials never enter its child environment.
- Lifecycle routing has one policy authority. Leave replay authentication does not grant bypass admission; terminal acknowledgements use terminal dispatch, not an active-service shortcut.
