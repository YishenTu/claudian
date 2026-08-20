# Collab Protocol Package

`packages/collab-protocol/` produces `@claudian/collab-protocol`, the sole canonical owner of the shared Collab wire contract consumed by Claudian and Claudian Cloud Server.

## Ownership

- This package owns: opaque Collab IDs and their runtime validation predicates, decision-complete transport-neutral request/response DTOs, executable JSON codecs, the one canonical operation registry, decoder-defined compatibility behavior, safe shared wire error codes and sanitized context, shared Git ref semantics, shared limits, idempotency/expected-state field shapes, and protocol-version negotiation contracts.
- There is exactly one source of truth for every exported type, codec, operation, error, limit, ref rule, and compatibility rule. Do not copy, re-declare, or re-register any of them in Claudian `src/`, Cloud Server, or fixtures presented as editable source.
- LAN bindings (HTTP versions, methods, route templates, prefixes, authentication/admission, dispatch, invitation trust, mDNS/TLS/discovery, Host-transfer transports) are owned by the consuming application, never by this package. `IngressPrincipal` and ingress details are server deployment contracts and do not belong here.

## Forbidden dependencies

- The package must not import Claudian `src/`, Obsidian, provider code, Cloud Server source, LAN route implementations, SQL or filesystem implementations, or any transport/runtime adapter.
- Runtime dependencies are limited to `@lezer/markdown` (required by the canonical Markdown masking used by reference parsers). Do not add another runtime dependency without an accepted decision recorded here.
- Keep runtime code platform-neutral. Do not add Node, browser, Obsidian, or server-runtime APIs to the contract package.

## Public exports

- `src/index.ts` is the only public entry point; `package.json` `exports` exposes only `.`. Do not add subpath exports.
- Export only the contract vocabulary consumers bind to: IDs, DTOs, codecs, the operation registry, shared errors, shared limits, ref semantics, parsers, and version constants. Module-private helpers stay unexported. Application-only error codes, recovery actions, quotas, and diff/checkout limits remain outside the package.
- Consumers validate shared Project, Member, opaque-operation, and Git-object IDs through the exported predicates. Do not export regex objects or duplicate their grammar in a transport adapter; application-only request IDs, credentials, fingerprints, and path rules remain locally owned.
- Removing or renaming an export, or tightening a decoder, is a breaking package change; see versioning below.

## Compatibility and versioning

- Package SemVer (pre-1.0) is independent from the wire-protocol version. `COLLAB_PROTOCOL_VERSION` is currently `3`; the supported wire range is exactly `[3, 3]`. Existing application LAN control version `9` is independently owned under `src/app/collab/lan/`.
- `contract-snapshot.json` is the committed public-contract baseline. Regenerate it with repository-root `npm run check:protocol-compatibility -- --write` only for an intentional contract change; any detected contract change requires monotonic increases to both package SemVer and `COLLAB_PROTOCOL_VERSION`. CI compares the proposed snapshot with the merge-base snapshot and rejects rollbacks or unversioned drift.
- Envelope decoders reject unknown fields and unsupported protocol versions (fail closed). Operation compatibility is decoder-defined and pinned by fixtures; decoded DTOs must not retain unrecognized input properties. Unknown operation kinds have no codec and fail at registry lookup.
- Page budgets measure final JSON serialization, including escaping. Every JSON transport adapter must accept `COLLAB_LIMITS.maxJsonPayloadUtf8Bytes`; a producer must fail closed if a single valid item cannot fit its protocol-owned page budget.
- Any change to envelope, DTO, or operation payload shape, or to the operation inventory, is a wire-breaking change requiring a new wire-protocol version; package SemVer alone never signals wire compatibility.
- The package currently owns only the decision-complete request/Ticket/Accept semantics. Do not add Project snapshot, event, onboarding, lifecycle, or HTTP binding contracts until their exact Cloud behavior is accepted. In particular, publish no shared event kind until its exact redacted payload codec and snapshot-fallback behavior are decision-complete.

## Tests

- Package tests live in `packages/collab-protocol/tests/` and run with `npm test` in this directory. They own the codec fixtures, malformed/oversized/unknown-input behavior, safe-error guarantees, the exact public export allowlist, the forbidden-dependency scan, and package/wire version distinction.
- Expected codec results come from specification literals and accepted fixtures, never from re-running the production codec inside an assertion.
- `npm run verify:pack` packs the artifact and proves a clean consumer can install and import it; artifacts go under the repository's ignored `.context/` directory.

## Build

- `npm run build` compiles `src/` to `dist/` (CommonJS + declarations) with `tsc`. `dist/` is generated output, never edited and never committed.
