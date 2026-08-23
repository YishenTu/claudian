import { COLLAB_MAIN_REF, type CollabMemberId, collabMemberRef, type CollabProjectId, isCollabMemberId, isCollabProjectId } from '@claudian-collab/protocol';

import type {
  AuthorityDatabaseConnection,
  AuthoritySqlRow,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface ProjectAuthorityInitializeInput {
  readonly createdAt: string;
  readonly hostCredentialHash: Uint8Array;
  readonly hostDisplayName: string;
  readonly hostMemberId: CollabMemberId;
  readonly name: string;
  readonly projectId: CollabProjectId;
}

export interface AuthorityProjectRecord {
  readonly createdAt: string;
  readonly hostMemberId: CollabMemberId;
  readonly mainRef: typeof COLLAB_MAIN_REF;
  readonly managerSetGeneration: number;
  readonly name: string;
  readonly projectId: CollabProjectId;
  readonly snapshotGeneration: number;
  readonly state: 'active' | 'disabled';
}

function projectError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['open-diagnostics'],
    safeContext: { reason },
  });
}

function assertId(
  value: string,
  predicate: (candidate: unknown) => candidate is string,
  field: string,
): void {
  if (!predicate(value)) {
    throw projectError(`${field}-invalid`);
  }
}

function assertText(value: string, field: string, maxLength: number): void {
  if (
    value.length === 0
    || value.length > maxLength
    || value.includes('\u0000')
    || value.includes('\r')
    || value.includes('\n')
  ) {
    throw projectError(`${field}-invalid`);
  }
}

function assertTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw projectError('project-created-at-invalid');
  }
}

function text(row: AuthoritySqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw projectError('project-row-invalid');
  return value;
}

export class ProjectAuthorityRepository {
  initialize(
    connection: AuthorityDatabaseConnection,
    input: ProjectAuthorityInitializeInput,
  ): void {
    assertId(input.projectId, isCollabProjectId, 'project-id');
    assertId(input.hostMemberId, isCollabMemberId, 'host-member-id');
    assertText(input.name, 'project-name', 200);
    assertText(input.hostDisplayName, 'host-display-name', 200);
    assertTimestamp(input.createdAt);
    if (input.hostCredentialHash.byteLength !== 32) {
      throw projectError('host-credential-hash-invalid');
    }
    if (this.get(connection)) throw projectError('project-already-initialized');

    connection.run(
      `INSERT INTO members (
        member_id, display_name, personal_ref, role, status, credential_hash,
        join_attempt_id, created_at, activated_at, revoked_at
      ) VALUES (?, ?, ?, 'manager', 'active', ?, NULL, ?, ?, NULL)`,
      [
        input.hostMemberId,
        input.hostDisplayName,
        collabMemberRef(input.hostMemberId),
        input.hostCredentialHash,
        input.createdAt,
        input.createdAt,
      ],
    );
    connection.run(
      `INSERT INTO project (
        singleton, project_id, name, state, host_member_id,
        manager_set_generation, main_ref, created_at, snapshot_generation
      ) VALUES (1, ?, ?, 'active', ?, 0, ?, ?, 0)`,
      [
        input.projectId,
        input.name,
        input.hostMemberId,
        COLLAB_MAIN_REF,
        input.createdAt,
      ],
    );
  }

  get(connection: AuthorityDatabaseConnection): AuthorityProjectRecord | null {
    const row = connection.get(`
      SELECT
        project_id,
        name,
        state,
        host_member_id,
        manager_set_generation,
        main_ref,
        created_at,
        snapshot_generation
      FROM project
      WHERE singleton = 1
    `);
    if (!row) return null;
    const generation = row.snapshot_generation;
    const state = row.state;
    const mainRef = row.main_ref;
    const managerSetGeneration = row.manager_set_generation;
    if (
      typeof generation !== 'number'
      || !Number.isSafeInteger(generation)
      || generation < 0
      || (state !== 'active' && state !== 'disabled')
      || mainRef !== COLLAB_MAIN_REF
      || typeof managerSetGeneration !== 'number'
      || !Number.isSafeInteger(managerSetGeneration)
      || managerSetGeneration < 0
    ) {
      throw projectError('project-row-invalid');
    }
    const project: AuthorityProjectRecord = {
      createdAt: text(row, 'created_at'),
      hostMemberId: text(row, 'host_member_id'),
      mainRef,
      managerSetGeneration,
      name: text(row, 'name'),
      projectId: text(row, 'project_id'),
      snapshotGeneration: generation,
      state,
    };
    assertId(project.projectId, isCollabProjectId, 'project-id');
    assertId(project.hostMemberId, isCollabMemberId, 'host-member-id');
    assertText(project.name, 'project-name', 200);
    assertTimestamp(project.createdAt);
    return project;
  }
}
