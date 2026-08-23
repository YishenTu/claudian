import { COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC } from '@claudian-collab/protocol';

import type { CollabCloudProjectSnapshot } from '@/core/collab';

type UnknownRecord = Readonly<Record<string, unknown>>;
const LOCAL_CLOUD_PROJECT_KEYS = new Set([
  'authorityKind',
  'createdAt',
  'id',
  'mainOid',
  'mainRef',
  'name',
]);

function requireRecord(value: unknown): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Cloud Project snapshot');
  }
  return value as UnknownRecord;
}

export function decodeCloudAuthorityProjectSnapshot(value: unknown): CollabCloudProjectSnapshot {
  const snapshot = COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC.decodeResponse(value);
  return {
    ...snapshot,
    project: {
      authorityKind: 'cloud',
      createdAt: snapshot.project.createdAt,
      id: snapshot.project.id,
      mainOid: snapshot.project.expectedMainOid,
      mainRef: snapshot.project.mainRef,
      name: snapshot.project.name,
    },
  };
}

export function decodeCloudProjectSnapshotCache(value: unknown): CollabCloudProjectSnapshot {
  const snapshot = requireRecord(value);
  const project = requireRecord(snapshot.project);
  if (
    Object.keys(project).length !== LOCAL_CLOUD_PROJECT_KEYS.size
    || Object.keys(project).some(key => !LOCAL_CLOUD_PROJECT_KEYS.has(key))
  ) {
    throw new TypeError('Invalid Cloud Project snapshot');
  }
  const { authorityKind, mainOid, ...wireProject } = project;
  if (authorityKind !== 'cloud') {
    throw new TypeError('Invalid Cloud Project snapshot');
  }
  return decodeCloudAuthorityProjectSnapshot({
    ...snapshot,
    project: {
      ...wireProject,
      expectedMainOid: mainOid,
    },
  });
}
