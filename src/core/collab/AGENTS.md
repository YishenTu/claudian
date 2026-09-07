# Collab core contracts

- `CollabAuthorityKind` is exactly `'lan' | 'cloud'`. `CollabProject` is a discriminated union over one common Project base; only the LAN variant has `hostMemberId` and `managerSetGeneration`. Never fabricate Cloud values or weaken LAN-only fields into meaningless optionals.
- `CollabProjectSnapshot` has one common base, a LAN extension for Host transfer and Manager-responsibility state, and a Cloud variant composed from the package-owned Cloud snapshot plus local authority metadata.
- Core owns authority-neutral client and feature contracts, not transport construction, retained sessions, route registries, compatibility policy, or server domain semantics. Consumers import package-owned wire symbols from `@claudian-collab/protocol`; core does not re-export or duplicate them.
- Core may name authority-neutral transfer intent and result capabilities needed by features, but it never owns checkpoint representation, transfer phases, claim semantics, LAN/Cloud route versions, protocol operation names, or lifecycle persistence.
- Feature contracts expose authority kind and negotiated capability support so callers must narrow before invoking LAN-only lifecycle or administration behavior. Absence of a Cloud capability is unsupported behavior, not permission to use a LAN route.
