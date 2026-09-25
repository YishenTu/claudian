import {
  COLLAB_AUTHORITY_TRANSFER_OPERATIONS,
  type CollabAuthorityTransferOperation,
  type CollabProjectId,
  decodeCollabAuthorityTransferOperationRequest,
  isCollabProjectId,
} from '@claudian-collab/protocol';

export const COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION = 3 as const;

const ROUTE_PREFIX = '/authority-transfer';
const ROUTE_PATTERN = /^\/authority-transfer\/v(\d+)\/projects\/([^/]+)\/operations\/([^/]+)$/;
const IDENTITY_ROUTE_PATTERN = /^\/authority-transfer\/v(\d+)\/projects\/([^/]+)\/identity$/;
const OPERATION_SET: ReadonlySet<string> = new Set(
  COLLAB_AUTHORITY_TRANSFER_OPERATIONS,
);

export interface CollabLANAuthorityTransferRouteMatch {
  readonly operation: CollabAuthorityTransferOperation;
  readonly projectId: CollabProjectId;
  readonly version: number;
}

/** A TLS-authenticated routing scope; this grants no operation admission. */
export interface LANAuthorityTransferEndpointIdentity {
  readonly authorityGeneration: number | null;
  readonly projectId: CollabProjectId;
  readonly transferId: string | null;
}

export function decodeLANAuthorityTransferEndpointIdentity(
  value: unknown,
): LANAuthorityTransferEndpointIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('Invalid transfer endpoint identity');
  }
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).sort().join(',') !== 'authorityGeneration,projectId,transferId'
    || !isCollabProjectId(fields.projectId)
    || (fields.authorityGeneration !== null && (
      typeof fields.authorityGeneration !== 'number'
      || !Number.isSafeInteger(fields.authorityGeneration)
      || fields.authorityGeneration < 1
    ))
    || (fields.transferId === null && fields.authorityGeneration === null)
  ) throw new RangeError('Invalid transfer endpoint identity');
  if (fields.transferId !== null) {
    decodeCollabAuthorityTransferOperationRequest('getProjectAuthorityTransfer', {
      projectId: fields.projectId, transferId: fields.transferId,
    });
  }
  return Object.freeze({
    authorityGeneration: fields.authorityGeneration,
    projectId: fields.projectId,
    transferId: fields.transferId as string | null,
  });
}

export function matchesLANAuthorityTransferEndpointIdentity(
  expected: LANAuthorityTransferEndpointIdentity,
  actual: LANAuthorityTransferEndpointIdentity,
): boolean {
  // A generation-only lookup discovers routing metadata; Member authentication
  // still authorizes the subsequent operation against the exact transfer.
  return actual.projectId === expected.projectId
    && (expected.authorityGeneration === null
      || actual.authorityGeneration === expected.authorityGeneration)
    && (expected.transferId === null
      || actual.transferId === expected.transferId
      || (actual.transferId === null && expected.authorityGeneration !== null));
}

export function collabLANAuthorityTransferIdentityPath(projectId: CollabProjectId): string {
  if (!isCollabProjectId(projectId)) throw new RangeError('Invalid Project identity');
  return `${ROUTE_PREFIX}/v${COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION}/projects/${projectId}/identity`;
}

export function matchCollabLANAuthorityTransferIdentityRoute(
  method: string | undefined,
  target: string | undefined,
): { readonly projectId: CollabProjectId; readonly version: number } | null {
  if (method !== 'POST' || !target || target.length > 2_048) return null;
  const match = IDENTITY_ROUTE_PATTERN.exec(target);
  if (!match || !isCollabProjectId(match[2])) return null;
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { projectId: match[2], version };
}

export function collabLANAuthorityTransferOperationPath(
  projectId: string,
  operation: CollabAuthorityTransferOperation,
): string {
  if (!isCollabProjectId(projectId) || !OPERATION_SET.has(operation)) {
    throw new RangeError('Invalid LAN authority-transfer route input');
  }
  return `${ROUTE_PREFIX}/v${COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION}`
    + `/projects/${projectId}/operations/${operation}`;
}

export function matchCollabLANAuthorityTransferRoute(
  method: string | undefined,
  target: string | undefined,
): CollabLANAuthorityTransferRouteMatch | null {
  if (method !== 'POST' || !target || target.length > 2_048) return null;
  let parsed: URL;
  try {
    parsed = new URL(target, 'https://claudian.invalid');
  } catch {
    return null;
  }
  if (
    parsed.origin !== 'https://claudian.invalid'
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || parsed.pathname !== target
  ) return null;
  const match = ROUTE_PATTERN.exec(parsed.pathname);
  if (!match) return null;
  const version = Number(match[1]);
  const projectId = match[2];
  const operation = match[3];
  if (
    !Number.isSafeInteger(version)
    || version < 1
    || !isCollabProjectId(projectId)
    || !OPERATION_SET.has(operation)
  ) return null;
  return {
    operation: operation as CollabAuthorityTransferOperation,
    projectId,
    version,
  };
}
