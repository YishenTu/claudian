import {
  COLLAB_AUTHORITY_TRANSFER_OPERATIONS,
  type CollabAuthorityTransferOperation,
  type CollabProjectId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

export const COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION = 1 as const;

const ROUTE_PREFIX = '/authority-transfer';
const ROUTE_PATTERN = /^\/authority-transfer\/v(\d+)\/projects\/([^/]+)\/operations\/([^/]+)$/;
const OPERATION_SET: ReadonlySet<string> = new Set(
  COLLAB_AUTHORITY_TRANSFER_OPERATIONS,
);

export interface CollabLanAuthorityTransferRouteMatch {
  readonly operation: CollabAuthorityTransferOperation;
  readonly projectId: CollabProjectId;
  readonly version: number;
}

export function collabLanAuthorityTransferOperationPath(
  projectId: string,
  operation: CollabAuthorityTransferOperation,
): string {
  if (!isCollabProjectId(projectId) || !OPERATION_SET.has(operation)) {
    throw new RangeError('Invalid LAN authority-transfer route input');
  }
  return `${ROUTE_PREFIX}/v${COLLAB_LAN_AUTHORITY_TRANSFER_BINDING_VERSION}`
    + `/projects/${projectId}/operations/${operation}`;
}

export function matchCollabLanAuthorityTransferRoute(
  method: string | undefined,
  target: string | undefined,
): CollabLanAuthorityTransferRouteMatch | null {
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
