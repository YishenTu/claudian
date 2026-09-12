# LAN constraints

- Project-control, Git, provisional physical handoff, and authority-transfer bindings have independent versions and admission policies. Never couple them for import convenience; reject unsupported control versions before body/authentication effects.
- The deployed 2.2.6 LAN base remains compatible across plugin and Cloud protocol releases. Preserve its discovery, invitation, envelope, event and existing operation contracts; additive features use authenticated capability metadata. Unknown optional capabilities cannot invalidate base reads, and a capability never grants authorization.
- A base LAN snapshot without authority-generation metadata denotes generation 1 only. Never substitute a selected newer generation or accept a mismatch against an existing binding; Cloud generation requirements remain strict.
- Check the physical receiver's supported authority formats before quiescing the source. A receiver-format upgrade must not require ordinary LAN Members to upgrade, and advertised formats need real published-source handoff evidence.
- Use the installation-scoped CA/lock. Refresh endpoints only under proven pinned trust; initial invitation trust probes without credentials and completes CA/IP-SAN validation before sending secrets.
- Explicit Host stop clears auto-start intent; unload only releases resources. Startup/recovery must pass the same Host-installation and durable restart guards as explicit start.
- Local target convergence drains Project activity, then holds the Host listener queue before the shared Project projection lane. Reading a listener URL before either queue does not reserve that location.
- Address replacement starts under the same CA before retiring the old listener. Persist all affected memberships before publication; failure retains the old route and retryability. Missing interfaces must not close a still-reachable listener.
- Physical Host handoff retains its endpoint restrictions. LAN/Cloud authority-transfer routes share ordinary listener address recovery under the same installation CA; their historical locators do not pin other Projects.
- Stop makes routes unavailable and begins bounded socket/child teardown before waiting for durable invitation revocation.
- Expose Git only after managed receive policy, protected hook, quota, and integrity checks. Reauthenticate immediately before registering a Git child after awaited admission.
- Pending credentials permit activation/initial clone, never ordinary control or receive-pack. Receive-pack may update only the authenticated Member's personal ref, without deletion or force; credentials never enter its child environment.
- Lifecycle routing has one policy authority. Leave replay authentication does not grant bypass admission; terminal acknowledgements use terminal dispatch, not an active-service shortcut.
