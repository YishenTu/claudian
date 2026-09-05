# Remote authority constraints

- Retained sessions belong to a membership generation, not a transport registry. Replacing membership disposes its session; pre-membership operations use short-lived connections, never fabricated bindings.
- Transfer recovery connections use durable identity and cancellation without ordinary snapshot preflight: the source may have closed that endpoint. Fresh transition begin still validates current membership.
- Negotiate only the intersection of server and actually implemented capabilities. A package addition cannot advertise an absent application port; unsupported Cloud operations never use LAN-shaped placeholders.
- Keep LAN wire expectations inside LAN adaptation. Cloud owners freeze exact package request/response facts for replay; adapters must not invent actor identity or retain user mutation intent.
- Completed Cloud rejection is transport provenance, not proof of no effect. Preserve it for operation-specific settlement.
- Complete paged reads stay bound to the authority captured for the first page; bounded Runtime reads bypass complete assembly.
- Desktop Cloud transport cannot depend on renderer fetch/CORS. Accept the user's complete HTTP or HTTPS URL and deployment prefix, including non-loopback HTTP; never guess/upgrade its scheme or rewrite its stored spelling.
- Reject credentials, queries, fragments, and malformed URL input. Do not follow redirects or disable native TLS verification.
- Authentication is operator-supplied consistently across JSON, events, artifacts, and Git. Reachability/tunnels are not identity proof; production never emits development actor/role headers.
- Header credentials/private paths stay out of arguments and diagnostics. Mark a non-secret routing header explicitly before permitting its domain identifier in a Git ref argument; the header itself still travels only through the isolated environment.
- Verify desktop transport behavior with real loopback HTTP and renderer fetch disabled; headless adapter tests alone cannot prove the installed composition.
