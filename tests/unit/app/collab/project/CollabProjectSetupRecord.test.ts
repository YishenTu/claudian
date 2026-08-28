import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  bindLegacyCollabProjectSetupOwner,
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
  ownerInstallationKey: TEST_INSTALLATION_A,
  phase: 'planned',
  projectId: 'project-alpha',
  projectsFolder: 'Shared/Collab Projects',
  schemaVersion: COLLAB_PROJECT_SETUP_SCHEMA_VERSION,
  seedDirectoryName: '.claudian-seed-project-alpha',
  slug: 'alpha',
  updatedAt: '2026-08-08T00:00:00.000Z',
};

describe('CollabProjectSetupRecord', () => {
  it('decodes a version-3 record with its installation owner', () => {
    expect(decodeCollabProjectSetupRecord(baseRecord)).toEqual(baseRecord);
  });

  it('maps a version-1 staged record to the historical workspace root', () => {
    const { ownerInstallationKey: _, ...legacy } = baseRecord;
    expect(decodeCollabProjectSetupRecord({
      ...legacy,
      initialCommitOid: 'a'.repeat(40),
      phase: 'staged',
      projectsFolder: undefined,
      schemaVersion: 1,
      sourcePaths: ['notes/brief.md'],
    })).toEqual(expect.objectContaining({
      legacySetupRecord: true,
      phase: 'staged',
      projectsFolder: 'workspace',
      schemaVersion: 2,
    }));
  });

  it('marks a version-1 planned import as non-resumable', () => {
    const { ownerInstallationKey: _, ...legacy } = baseRecord;
    expect(decodeCollabProjectSetupRecord({
      ...legacy,
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
    const { ownerInstallationKey: _, ...legacy } = baseRecord;
    expect(decodeCollabProjectSetupRecord({
      ...legacy,
      initialCommitOid: 'a'.repeat(40),
      legacySetupRecord: true,
      phase: 'committed',
      projectsFolder: 'workspace',
      schemaVersion: 2,
    })).toEqual(expect.objectContaining({ legacySetupRecord: true }));
  });

  it('accepts version 2 only as ownerless legacy input', () => {
    const { ownerInstallationKey: _, ...legacy } = baseRecord;
    expect(decodeCollabProjectSetupRecord({
      ...legacy,
      schemaVersion: 2,
    })).toMatchObject({ schemaVersion: 2 });
    expect(() => decodeCollabProjectSetupRecord({
      ...baseRecord,
      schemaVersion: 2,
    })).toThrow(TypeError);
  });

  it('binds an ownerless legacy checkpoint only through an explicit installation claim', () => {
    const { ownerInstallationKey: _, ...legacy } = baseRecord;
    const decoded = decodeCollabProjectSetupRecord({ ...legacy, schemaVersion: 2 });

    expect(bindLegacyCollabProjectSetupOwner(decoded, TEST_INSTALLATION_A)).toMatchObject({
      ownerInstallationKey: TEST_INSTALLATION_A,
      schemaVersion: COLLAB_PROJECT_SETUP_SCHEMA_VERSION,
    });
  });

  it('rejects an invalid current installation owner', () => {
    expect(() => decodeCollabProjectSetupRecord({
      ...baseRecord,
      ownerInstallationKey: 'device-invalid',
    })).toThrow(TypeError);
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
