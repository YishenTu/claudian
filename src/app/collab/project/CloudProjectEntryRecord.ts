import { collabControlOperationCodec, type CollabControlOperationMap, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import { isCollabWorkingCopySlug } from '@/app/collab/project/CollabWorkingCopySlug';
import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import { decodeCloudProjectSnapshotCache } from '@/app/collab/remote-authority/CloudProjectSnapshotMapper';
import { type CollabCloudProjectSnapshot, parseCollabProjectsFolder } from '@/core/collab';

interface CloudProjectEntryBase {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly projectId: string;
  readonly serverUrl: string;
  readonly projectsFolder: string;
  readonly slug: string;
  readonly stagingDirectoryName: string;
  readonly phase: 'intent' | 'admitted' | 'clone-validated' | 'placed' | 'locally-finalized';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CloudProjectEntryRecord = CloudProjectEntryBase & (
  | {
    readonly operationKind: 'cloud-existing-project';
    readonly request: null;
    readonly admission: {
      readonly response: null;
      readonly snapshot: CollabCloudProjectSnapshot;
    };
  }
  | {
    readonly operationKind: 'cloud-create-project';
    readonly request: CollabControlOperationMap['createCloudProject']['request'];
    readonly admission: {
      readonly response: CollabControlOperationMap['createCloudProject']['response'];
      readonly snapshot: CollabCloudProjectSnapshot;
    } | null;
  }
  | {
    readonly operationKind: 'cloud-join-project';
    readonly request: CollabControlOperationMap['joinCloudProject']['request'] | null;
    readonly admission: {
      readonly response: CollabControlOperationMap['joinCloudProject']['response'];
      readonly snapshot: CollabCloudProjectSnapshot;
    } | null;
  }
);

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new TypeError('Invalid Cloud entry record');
  }
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('Invalid Cloud entry timestamp');
  }
  return value;
}

export function decodeCloudProjectEntryRecord(value: unknown): CloudProjectEntryRecord {
  const source = record(value, [
    'schemaVersion', 'operationKind', 'operationId', 'projectId', 'serverUrl', 'projectsFolder',
    'slug', 'stagingDirectoryName', 'phase', 'request', 'admission', 'createdAt', 'updatedAt',
  ]);
  if (source.schemaVersion !== 1 || (source.operationKind !== 'cloud-create-project' && source.operationKind !== 'cloud-join-project' && source.operationKind !== 'cloud-existing-project')
    || !isCollabOpaqueId(source.operationId) || !isCollabProjectId(source.projectId)
    || typeof source.serverUrl !== 'string' || typeof source.projectsFolder !== 'string'
    || !parseCollabProjectsFolder(source.projectsFolder).ok
    || !isCollabWorkingCopySlug(source.slug)
    || source.stagingDirectoryName !== `.claudian-clone-${source.projectId}`
    || (source.phase !== 'intent' && source.phase !== 'admitted' && source.phase !== 'clone-validated'
      && source.phase !== 'placed' && source.phase !== 'locally-finalized')) {
    throw new TypeError('Invalid Cloud entry identity');
  }
  if ((source.phase === 'intent') !== (source.admission === null)) throw new TypeError('Invalid Cloud entry phase');
  const base: CloudProjectEntryBase = {
    createdAt: timestamp(source.createdAt), operationId: source.operationId,
    phase: source.phase, projectId: source.projectId,
    projectsFolder: source.projectsFolder, schemaVersion: 1,
    serverUrl: validateCloudServerUrl(source.serverUrl, 'serverUrl'), slug: source.slug,
    stagingDirectoryName: source.stagingDirectoryName, updatedAt: timestamp(source.updatedAt),
  };
  const admitted = source.admission === null ? null : record(source.admission, ['response', 'snapshot']);
  const snapshot = admitted && decodeCloudProjectSnapshotCache(admitted.snapshot);
  if (snapshot && (snapshot.project.id !== source.projectId || snapshot.currentMember.status !== 'active')) {
    throw new TypeError('Invalid Cloud entry snapshot');
  }
  if (source.operationKind === 'cloud-existing-project') {
    if (source.request !== null || !snapshot || admitted?.response !== null) throw new TypeError('Invalid existing Cloud entry');
    return { ...base, operationKind: source.operationKind, request: null, admission: { response: null, snapshot } };
  }
  if (source.operationKind === 'cloud-create-project') {
    const codec = collabControlOperationCodec('createCloudProject');
    const request = codec.decodeRequest(source.request);
    if (request.status !== 'ok' || request.value.projectId !== source.projectId
      || request.value.idempotencyKey !== source.operationId) throw new TypeError('Invalid Cloud entry request');
    const response = admitted && codec.decodeResponse(admitted.response);
    if (response && snapshot && (response.projectId !== source.projectId
      || snapshot.project.name !== request.value.projectName || snapshot.currentMember.id !== response.memberId
      || snapshot.currentMember.personalRef !== response.personalRef || snapshot.currentMember.role !== 'manager'
      || snapshot.project.mainOid !== response.mainOid)) throw new TypeError('Invalid Cloud Create admission');
    return { ...base, operationKind: source.operationKind, request: request.value, admission: response && snapshot ? { response, snapshot } : null };
  }
  const codec = collabControlOperationCodec('joinCloudProject');
  if (!admitted || !snapshot) {
    const request = codec.decodeRequest(source.request);
    if (request.status !== 'ok' || request.value.projectId !== source.projectId
      || request.value.idempotencyKey !== source.operationId) throw new TypeError('Invalid Cloud Join request');
    return { ...base, operationKind: source.operationKind, request: request.value, admission: null };
  }
  const response = codec.decodeResponse(admitted.response);
  if (source.request !== null || response.projectId !== source.projectId || snapshot.currentMember.id !== response.memberId
    || snapshot.currentMember.personalRef !== response.personalRef) throw new TypeError('Invalid Cloud Join admission');
  return { ...base, operationKind: source.operationKind, request: null, admission: { response, snapshot } };
}
