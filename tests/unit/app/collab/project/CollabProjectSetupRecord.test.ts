import {
  COLLAB_PROJECT_SETUP_SCHEMA_VERSION,
  type CollabProjectSetupRecord,
  decodeCollabProjectSetupRecord,
} from '@/app/collab/project/CollabProjectSetupRecord';

const baseRecord: CollabProjectSetupRecord = {
  cloneDirectoryName: '.claudian-clone-project-alpha',
  createdAt: '2026-08-08T00:00:00.000Z',
  initialCommitOid: null,
  memberCredential: 'A'.repeat(43),
  memberDisplayName: 'Alice',
  memberId: 'member-alpha',
  name: 'Alpha',
  operationId: 'create-alpha',
  phase: 'planned',
  projectId: 'project-alpha',
  projectsFolder: 'Shared/Collab Projects',
  schemaVersion: COLLAB_PROJECT_SETUP_SCHEMA_VERSION,
  seedDirectoryName: '.claudian-seed-project-alpha',
  slug: 'alpha',
  updatedAt: '2026-08-08T00:00:00.000Z',
};

describe('CollabProjectSetupRecord', () => {
  it('decodes a version-2 record with its captured Projects folder', () => {
    expect(decodeCollabProjectSetupRecord(baseRecord)).toEqual(baseRecord);
  });

  it('maps a version-1 staged record to the historical workspace root', () => {
    expect(decodeCollabProjectSetupRecord({
      ...baseRecord,
      initialCommitOid: 'a'.repeat(40),
      phase: 'staged',
      projectsFolder: undefined,
      schemaVersion: 1,
      sourcePaths: ['notes/brief.md'],
    })).toEqual(expect.objectContaining({
      legacySetupRecord: true,
      phase: 'staged',
      projectsFolder: 'workspace',
      schemaVersion: COLLAB_PROJECT_SETUP_SCHEMA_VERSION,
    }));
  });

  it('marks a version-1 planned import as non-resumable', () => {
    expect(decodeCollabProjectSetupRecord({
      ...baseRecord,
      projectsFolder: undefined,
      schemaVersion: 1,
      sourcePaths: ['notes/brief.md'],
    })).toEqual(expect.objectContaining({
      legacyImportPlanned: true,
      legacySetupRecord: true,
      projectsFolder: 'workspace',
    }));
  });

  it('retains version-1 recovery provenance after durable normalization', () => {
    expect(decodeCollabProjectSetupRecord({
      ...baseRecord,
      initialCommitOid: 'a'.repeat(40),
      legacySetupRecord: true,
      phase: 'committed',
      projectsFolder: 'workspace',
    })).toEqual(expect.objectContaining({ legacySetupRecord: true }));
  });

  it('binds generated staging names to the decoded Project identity', () => {
    expect(() => decodeCollabProjectSetupRecord({
      ...baseRecord,
      seedDirectoryName: '.claudian-seed-project-other',
    })).toThrow('Invalid Project setup operation identity');
    expect(() => decodeCollabProjectSetupRecord({
      ...baseRecord,
      cloneDirectoryName: '.claudian-clone-project-other',
    })).toThrow('Invalid Project setup operation identity');
  });
});
