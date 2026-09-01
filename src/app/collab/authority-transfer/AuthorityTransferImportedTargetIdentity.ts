import {
  type CollabMemberId,
  collabMemberRef,
  type CollabProjectId,
  type CollabRole,
  isCollabMemberId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

export interface AuthorityTransferImportedTargetIdentity {
  readonly authorityGeneration: number;
  readonly currentMember: Readonly<{
    readonly displayName: string;
    readonly id: CollabMemberId;
    readonly personalRef: string;
    readonly role: CollabRole;
  }>;
  readonly eventSequence: number;
  readonly project: Readonly<{
    readonly id: CollabProjectId;
    readonly name: string;
  }>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

export function decodeAuthorityTransferImportedTargetIdentity(
  value: unknown,
): AuthorityTransferImportedTargetIdentity {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      'authorityGeneration',
      'currentMember',
      'eventSequence',
      'project',
    ])
    || !Number.isSafeInteger(value.authorityGeneration)
    || (value.authorityGeneration as number) < 1
    || !Number.isSafeInteger(value.eventSequence)
    || (value.eventSequence as number) < 0
    || !isRecord(value.currentMember)
    || !exactKeys(value.currentMember, ['displayName', 'id', 'personalRef', 'role'])
    || !isCollabMemberId(value.currentMember.id)
    || typeof value.currentMember.displayName !== 'string'
    || Buffer.byteLength(value.currentMember.displayName, 'utf8') > 128
    || typeof value.currentMember.personalRef !== 'string'
    || value.currentMember.personalRef !== collabMemberRef(value.currentMember.id)
    || (value.currentMember.role !== 'manager' && value.currentMember.role !== 'member')
    || !isRecord(value.project)
    || !exactKeys(value.project, ['id', 'name'])
    || !isCollabProjectId(value.project.id)
    || typeof value.project.name !== 'string'
    || Buffer.byteLength(value.project.name, 'utf8') > 256
  ) throw new TypeError('Invalid imported authority-transfer target identity');
  return Object.freeze({
    authorityGeneration: value.authorityGeneration as number,
    currentMember: Object.freeze({
      displayName: value.currentMember.displayName,
      id: value.currentMember.id,
      personalRef: value.currentMember.personalRef,
      role: value.currentMember.role,
    }),
    eventSequence: value.eventSequence as number,
    project: Object.freeze({
      id: value.project.id,
      name: value.project.name,
    }),
  });
}
