# @claudian/collab-protocol

The canonical shared Collab wire contract, produced from the
[Claudian](https://github.com/yishentu/claudian) repository. Both Claudian
(LAN client and Host) and Claudian Cloud Server consume this package; neither
may maintain copied types, operation registries, codec maps, shared constants,
or compatibility rules.

## Contents

- Opaque Collab ID types (`CollabProjectId`, `CollabMemberId`, `CollabGitOid`, …)
- Transport-neutral request and response DTOs
- Executable request/response codecs with decoder-defined compatibility behavior
- The canonical operation registry (`CollabControlOperationMap`,
  `COLLAB_CONTROL_OPERATION_CODECS`, `collabControlOperationCodec`)
- Safe public error codes and sanitized error context (`CollabError`,
  `COLLAB_ERROR_CODES`, `sanitizeCollabDiagnosticContext`)
- Shared Git ref semantics (`COLLAB_MAIN_REF`, `COLLAB_MEMBER_REF_PREFIX`,
  `collabMemberRef`)
- Shared limits that client and server must agree on (`COLLAB_LIMITS`)
- Protocol-version negotiation (`COLLAB_PROTOCOL_VERSION`, envelope decoding)
- Markdown-derived Ticket-reference and Member-mention semantics shared by
  client rendering and authority derivation

The package is transport-neutral. It contains no HTTP routes, methods, or
dispatch; no LAN Host admission, invitation trust, mDNS/TLS/discovery, or
Host-transfer transport; no Obsidian, Vault, UI, Agent, provider, SQL, or
filesystem behavior; and no `IngressPrincipal` or other deployment-ingress
contracts.

The current registry contains only the decision-complete, transport-neutral
request, Ticket, metadata, and Accept operations. Detail DTOs embed the first
page of their comments and accepted relations; `listRequestComments`,
`listTicketComments`, and `listTicketAcceptedRelations` page the remainder
with stable opaque cursors, and producers bound pages by the shared count and
UTF-8 byte limits. Producers size embedded first pages against the measured
fixed part of the detail so the whole detail stays within
`detailMaxUtf8Bytes`, including JSON escaping. JSON adapters accept the shared
`maxJsonPayloadUtf8Bytes` cap so every valid bounded request, page, and detail
has one compatible final-serialization limit. Request comments and Ticket
accepted relations also have shared authority-enforced total limits; summary
counts let complete consumers reject partial or cross-snapshot assembly.
Existing LAN v9 Join,
invitation, endpoint, membership
lifecycle, Host-transfer, retirement, Project snapshot, and HTTP bindings
remain application-owned. The exact Cloud snapshot and route catalog require
a separate product-level contract decision.

## Usage

```ts
import {
  COLLAB_PROTOCOL_VERSION,
  COLLAB_CONTROL_OPERATION_CODECS,
  CollabError,
} from '@claudian/collab-protocol';

const codec = COLLAB_CONTROL_OPERATION_CODECS.ensureMyRequest;
const decoded = codec.decodeRequest(rawBody);
if (decoded.status !== 'ok') {
  // decoded.error is a safe CollabError: no credentials, paths, or internals.
}
```

Only the package root (`.`) is a supported import. Subpath imports are not
part of the public surface.

## Versioning

Package SemVer and the wire-protocol version are independent concepts.

- **Package version** (this `package.json`): pre-1.0. Minor releases may add or
  break TypeScript API; patch releases are behavior-preserving fixes. The
  package version never signals wire compatibility by itself.
- **Wire version** (`COLLAB_PROTOCOL_VERSION`): currently `3`. The supported
  range is exactly `[3, 3]`. This is independent from the existing application
  LAN control version `9`. Any change to an envelope, DTO, or operation
  payload shape, or to the operation inventory, is wire-breaking and requires
  a new wire-protocol version.

### Compatibility behavior

- Envelope decoders reject unknown fields (`protocol-payload-invalid`).
  Operation request and response compatibility is
  decoder-defined and pinned by package fixtures; decoded DTOs are reconstructed
  rather than retaining unrecognized input properties.
- An unsupported `protocolVersion` decodes to `unsupported-version` with the
  received and supported versions in safe context.
- Unknown operation kinds have no codec and fail at registry lookup.
- `CollabError.safeContext` is sanitized: credential-like keys are redacted
  and filesystem paths are replaced with `[PATH]`.

Compatibility is tested with executable fixtures in this package
(`tests/`), and cross-repository contract fixtures pin client and server to
the same behavior.

## Development

```bash
npm run build        # compile src/ -> dist/ (CommonJS + declarations)
npm test             # package unit tests
npm run verify:pack  # pack the artifact and smoke-test a clean consumer
```

`dist/` is generated output and is never committed. The packed artifact is
reproducible from source: `npm pack` rebuilds via `prepack`.
