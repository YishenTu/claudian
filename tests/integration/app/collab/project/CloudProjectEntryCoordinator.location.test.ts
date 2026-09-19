import assert from 'node:assert/strict';
import fs, { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CREATED_AT, createFeatureFixture, createFixture, git, MEMBER_ID, PROJECT_ID } from '@test/helpers/collab/CloudProjectEntryFixture';

import { isCollabLocalCloudMembership } from '@/app/collab/CollabLocalProjectRepository';
import { decodeCloudProjectEntryRecord } from '@/app/collab/project/CloudProjectEntryRecord';
import { decodeCloudProjectInvitation } from '@/app/collab/project/CloudProjectInvitation';
import { CollabWorkingCopyLocationService } from '@/app/collab/project/CollabWorkingCopyLocationService';
import { decodeCollabPublicationStateRecord } from '@/app/collab/publish/CollabPublicationStateRecord';
import { CloudProjectCredentialStore } from '@/app/collab/remote-authority/CloudProjectCredentialStore';

jest.setTimeout(30_000);

describe('CloudProjectEntryCoordinator', () => {
  it.each(['event', 'startup', 'background-startup'] as const)('follows a user directory rename through %s without losing personal work', async trigger => {
    const fixture = await createFixture({ join: true });
    const feature = createFeatureFixture(fixture);
    const projects = fixture.foundation.local.projects;
    try {
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob' }))
        .resolves.toMatchObject({ status: 'success' });
      const before = await projects.loadMembership(PROJECT_ID);
      const publication = await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord);
      const oldPath = 'Shared/Projects/cloud-notes';
      const newPath = 'Shared/Projects/我的 Demo';
      await writeFile(path.join(fixture.vaultRoot, oldPath, 'local.md'), 'Uncommitted work');
      await rename(path.join(fixture.vaultRoot, oldPath), path.join(fixture.vaultRoot, newPath));
      const recoveryResult = trigger === 'background-startup'
        ? await feature.restoreLifecycle().then(() => feature.restoreHosts()).then(() => ({ status: 'success' }))
        : await (trigger === 'event' ? feature.reconcileWorkingCopyLocations({ oldPath, newPath }) : feature.initialize());
      expect(recoveryResult).toMatchObject({ status: 'success' });
      expect(await projects.loadMembership(PROJECT_ID)).toEqual({ ...before, project: { ...before!.project, workspacePath: newPath }, updatedAt: expect.any(String) });
      expect(feature.state.projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: PROJECT_ID, name: 'Cloud Notes', workspacePath: newPath, health: 'healthy' })]));
      expect(await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord)).toEqual(publication);
      expect(await readFile(path.join(fixture.vaultRoot, newPath, 'local.md'), 'utf8')).toBe('Uncommitted work');
      expect(await git(path.join(fixture.vaultRoot, newPath), ['status', '--porcelain'])).toContain('local.md');
    } finally { await feature.close(); await fixture.close(); }
  });

  it('recovers the actual directory spelling after a case-only rename while offline', async () => {
    const fixture = await createFixture({ join: true });
    const feature = createFeatureFixture(fixture);
    try {
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob' })).resolves.toMatchObject({ status: 'success' });
      const newPath = 'Shared/Projects/Cloud-Notes';
      await rename(path.join(fixture.vaultRoot, 'Shared/Projects/cloud-notes'), path.join(fixture.vaultRoot, newPath));
      await feature.restoreLifecycle();
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toMatchObject({ project: { workspacePath: newPath } });
      expect(feature.state.projects).toEqual(expect.arrayContaining([expect.objectContaining({ workspacePath: newPath, health: 'healthy' })]));
    } finally { await feature.close(); await fixture.close(); }
  });

  it('rediscovers a renamed Project at startup when its old name has been reused', async () => {
    const fixture = await createFixture({ join: true });
    const feature = createFeatureFixture(fixture);
    try {
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob' })).resolves.toMatchObject({ status: 'success' });
      const oldPath = 'Shared/Projects/cloud-notes';
      const newPath = 'Shared/Projects/renamed';
      await rename(path.join(fixture.vaultRoot, oldPath), path.join(fixture.vaultRoot, newPath));
      await mkdir(path.join(fixture.vaultRoot, oldPath));
      await writeFile(path.join(fixture.vaultRoot, oldPath, 'keep.md'), 'Unrelated folder');
      await expect(feature.initialize()).resolves.toMatchObject({ status: 'success' });
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toMatchObject({ project: { workspacePath: newPath } });
      expect(await readFile(path.join(fixture.vaultRoot, oldPath, 'keep.md'), 'utf8')).toBe('Unrelated folder');
    } finally { await feature.close(); await fixture.close(); }
  });

  it('repairs an interrupted rename projection and follows a second rename', async () => {
    const fixture = await createFixture({ join: true });
    const feature = createFeatureFixture(fixture);
    const projects = fixture.foundation.local.projects;
    try {
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob' })).resolves.toMatchObject({ status: 'success' });
      const oldPath = 'Shared/Projects/cloud-notes';
      const firstPath = 'Shared/Projects/First rename';
      const secondPath = 'Shared/Projects/Second rename';
      await rename(path.join(fixture.vaultRoot, oldPath), path.join(fixture.vaultRoot, firstPath));
      const filesystemRename = fs.rename;
      const indexPath = path.join(fixture.vaultRoot, '.claudian', 'collab', 'index.json');
      const cut = jest.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
        if (String(destination) === indexPath) throw new Error('Injected index write failure');
        return filesystemRename(source, destination);
      });
      try {
        await expect(feature.reconcileWorkingCopyLocations({ oldPath, newPath: firstPath })).resolves.toMatchObject({ status: 'failure' });
      } finally { cut.mockRestore(); }
      await rename(path.join(fixture.vaultRoot, firstPath), path.join(fixture.vaultRoot, secondPath));
      await expect(feature.reconcileWorkingCopyLocations({ oldPath: firstPath, newPath: secondPath })).resolves.toMatchObject({ status: 'success' });
      expect(await projects.loadMembership(PROJECT_ID)).toMatchObject({ project: { workspacePath: secondPath } });
      expect(feature.state.projects).toEqual(expect.arrayContaining([expect.objectContaining({ workspacePath: secondPath, health: 'healthy' })]));
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each(['none', 'membership', 'index'] as const)('recovers exchanged Project directories with a %s persistence interruption', async cutAt => {
    const fixture = await createFixture({ join: true });
    const projects = fixture.foundation.local.projects;
    try {
      await expect(fixture.coordinator.joinProject({ invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob' })).resolves.toMatchObject({ status: 'success' });
      const first = (await projects.loadMembership(PROJECT_ID))!;
      assert(isCollabLocalCloudMembership(first));
      const firstEntry = (await projects.loadIndex()).projects.find(entry => entry.id === PROJECT_ID)!;
      const otherId = 'project-other-rename';
      const firstPath = first.project.workspacePath;
      const otherPath = 'Shared/Projects/other-notes';
      const temporaryPath = path.join(fixture.vaultRoot, 'Shared/Projects/temporary');
      await fs.cp(path.join(fixture.vaultRoot, firstPath), path.join(fixture.vaultRoot, otherPath), { recursive: true });
      await (await fixture.foundation.requireGitFoundation()).repositories.configureLocalRepository(path.join(fixture.vaultRoot, otherPath), {
        projectId: otherId, memberId: first.member.id, personalRef: first.member.personalRef, userDisplayName: first.member.displayName,
      });
      await projects.saveMembership({ ...first, authority: { ...first.authority, gitRemoteUrl: first.authority.gitRemoteUrl!.replace(PROJECT_ID, otherId) }, project: { ...first.project, id: otherId, workspacePath: otherPath } });
      await projects.upsertProject({ ...firstEntry, id: otherId, workspacePath: otherPath });
      await writeFile(path.join(fixture.vaultRoot, firstPath, 'local.md'), 'First personal work');
      await writeFile(path.join(fixture.vaultRoot, otherPath, 'local.md'), 'Second personal work');
      await rename(path.join(fixture.vaultRoot, firstPath), temporaryPath);
      await rename(path.join(fixture.vaultRoot, otherPath), path.join(fixture.vaultRoot, firstPath));
      await rename(temporaryPath, path.join(fixture.vaultRoot, otherPath));
      const locations = new CollabWorkingCopyLocationService(fixture.foundation, {
        vaultRoot: fixture.vaultRoot, transitionProject: async (_projectId, operation) => operation(),
      });

      let interruption = 'not-injected';
      if (cutAt !== 'none') {
        const filesystemRename = fs.rename;
        const interruptedPath = cutAt === 'membership'
          ? path.join(fixture.vaultRoot, projects.getProjectPaths(otherId).membership)
          : path.join(fixture.vaultRoot, '.claudian/collab/index.json');
        const cut = jest.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
          if (String(destination) === interruptedPath) throw new Error('Injected location persistence failure');
          return filesystemRename(source, destination);
        });
        try { interruption = await locations.reconcile().then(() => 'unexpected-completion', () => 'interrupted'); } finally { cut.mockRestore(); }
      }
      expect(interruption).toBe(cutAt === 'none' ? 'not-injected' : 'interrupted');
      expect((await projects.loadIndex()).projects).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: PROJECT_ID, workspacePath: firstPath }),
        expect.objectContaining({ id: otherId, workspacePath: otherPath }),
      ]));
      await expect(locations.reconcile()).resolves.toEqual(expect.arrayContaining([PROJECT_ID, otherId]));
      expect(await projects.loadMembership(PROJECT_ID)).toMatchObject({ project: { workspacePath: otherPath } });
      expect(await projects.loadMembership(otherId)).toMatchObject({ project: { workspacePath: firstPath } });
      expect((await projects.loadIndex()).projects).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: PROJECT_ID, workspacePath: otherPath }),
        expect.objectContaining({ id: otherId, workspacePath: firstPath }),
      ]));
      expect(await readFile(path.join(fixture.vaultRoot, otherPath, 'local.md'), 'utf8')).toBe('First personal work');
      expect(await readFile(path.join(fixture.vaultRoot, firstPath, 'local.md'), 'utf8')).toBe('Second personal work');
    } finally { await fixture.close(); }
  });

  it('preserves both copies when a missing working copy has ambiguous matching directories', async () => {
    const fixture = await createFixture({ join: true });
    const feature = createFeatureFixture(fixture);
    const projects = fixture.foundation.local.projects;
    try {
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob' })).resolves.toMatchObject({ status: 'success' });
      const before = await projects.loadMembership(PROJECT_ID);
      const oldPath = 'Shared/Projects/cloud-notes';
      const newPath = 'Shared/Projects/renamed';
      await rename(path.join(fixture.vaultRoot, oldPath), path.join(fixture.vaultRoot, newPath));
      await fs.cp(path.join(fixture.vaultRoot, newPath), path.join(fixture.vaultRoot, 'Shared/Projects/duplicate'), { recursive: true });
      await expect(feature.reconcileWorkingCopyLocations({ oldPath, newPath })).resolves.toMatchObject({ status: 'failure' });
      expect(await projects.loadMembership(PROJECT_ID)).toEqual(before);
      expect(await git(path.join(fixture.vaultRoot, newPath), ['rev-parse', 'HEAD'])).toBe(fixture.mainOid);
      expect(await git(path.join(fixture.vaultRoot, 'Shared/Projects/duplicate'), ['rev-parse', 'HEAD'])).toBe(fixture.mainOid);
    } finally { await feature.close(); await fixture.close(); }
  });

  it('restores a missing Cloud working copy under its user-renamed directory', async () => {
    const fixture = await createFixture({ join: true });
    const feature = createFeatureFixture(fixture);
    try {
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob' })).resolves.toMatchObject({ status: 'success' });
      const oldPath = 'Shared/Projects/cloud-notes';
      const newPath = 'Shared/Projects/My renamed Project';
      await rename(path.join(fixture.vaultRoot, oldPath), path.join(fixture.vaultRoot, newPath));
      await expect(feature.reconcileWorkingCopyLocations({ oldPath, newPath })).resolves.toMatchObject({ status: 'success' });
      await rm(path.join(fixture.vaultRoot, newPath), { recursive: true });
      await expect(feature.joinProject({ existingCloudProjectId: PROJECT_ID })).resolves.toMatchObject({ status: 'success', value: { workspacePath: newPath } });
      expect(await git(path.join(fixture.vaultRoot, newPath), ['rev-parse', 'HEAD'])).toBe(fixture.mainOid);
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each(['file', 'symlink'] as const)('does not mistake a surviving %s for a missing synchronized working copy', async replacement => {
    const fixture = await createFixture({ join: true });
    const feature = createFeatureFixture(fixture);
    try {
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob', projectSlug: 'existing-notes' }))
        .resolves.toMatchObject({ status: 'success' });
      const projects = fixture.foundation.local.projects;
      const membership = await projects.loadMembership(PROJECT_ID);
      const publication = await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord);
      const destination = path.join(fixture.vaultRoot, 'Shared/Projects/existing-notes');
      const retained = path.join(fixture.vaultRoot, 'retained-copy');
      await rename(destination, retained);
      await writeFile(path.join(retained, 'keep.md'), 'Keep local work\n');
      if (replacement === 'file') await writeFile(destination, 'Keep occupied destination\n');
      else await symlink(retained, destination, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(feature.joinProject({ existingCloudProjectId: PROJECT_ID })).resolves.toMatchObject({ status: 'failure' });
      expect(await readFile(path.join(retained, 'keep.md'), 'utf8')).toBe('Keep local work\n');
      const survivingDestination = replacement === 'file' ? await readFile(destination, 'utf8') : (await lstat(destination)).isSymbolicLink();
      expect(survivingDestination).toBe(replacement === 'file' ? 'Keep occupied destination\n' : true);
      expect(await projects.loadMembership(PROJECT_ID)).toEqual(membership);
      expect(await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord)).toEqual(publication);
      expect(await projects.listPendingOperationProjectIds()).toEqual([]);
      expect(fixture.joinRequests).toHaveLength(1);
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each([['join', false], ['join', true], ['restore', false], ['restore', true], ['legacy-restore', true]] as const)('resumes missing-copy setup for %s (retained publication: %s)', async (entryIntent, retainPublication) => {
    const fixture = await createFixture({ join: true, alreadyBound: true, remoteContribution: true });
    await new CloudProjectCredentialStore(fixture.vaultRoot).getOrCreate(PROJECT_ID);
    const feature = createFeatureFixture(fixture);
    const projects = fixture.foundation.local.projects;
    const membership = {
      schemaVersion: 3 as const, createdAt: CREATED_AT, updatedAt: CREATED_AT, lastEventSequence: 7,
      authority: { kind: 'cloud' as const, authorityGeneration: 7, bindingVersion: 10 as const, wireVersion: 15 as const,
        serverUrl: fixture.serverUrl, gitRemoteUrl: `${fixture.serverUrl}/v10/projects/${PROJECT_ID}/repository.git` },
      member: { id: MEMBER_ID, displayName: 'Bob', role: 'member' as const, personalRef: `refs/heads/members/${MEMBER_ID}` },
      project: { id: PROJECT_ID, name: 'Cloud Notes', workspacePath: 'Original/Projects/recovered-notes' },
    };
    const publication = {
      baseMainOid: fixture.mainOid, projectId: PROJECT_ID, schemaVersion: 1, updatedAt: CREATED_AT,
      operation: { contributionHeadOid: fixture.mainOid, createdAt: CREATED_AT, operationId: 'publish-existing', phase: 'captured', updatedAt: CREATED_AT, candidateOid: null, currentMainOid: null },
    };
    await projects.saveMembership(membership);
    const retained = await projects.loadMembership(PROJECT_ID);
    if (retainPublication) await projects.saveProjectDocument(PROJECT_ID, 'publication-state', publication);
    const save = projects.saveProjectDocument.bind(projects);
    const cut = jest.spyOn(projects, 'saveProjectDocument').mockImplementation(async (...args) => {
      await save(...args);
      if (args[1] === 'pending-operation' && (args[2] as { phase?: string }).phase === 'admitted') throw new Error('Injected missing-copy admission cut');
    });
    try {
      const entry = await feature.joinProject(entryIntent !== 'join'
        ? { existingCloudProjectId: PROJECT_ID }
        : { encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Do not rename', projectSlug: 'do-not-create' });
      expect(entry).toMatchObject({ status: 'recovery-required' });
      if (entry.status !== 'recovery-required') throw entry;
      expect(await projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord))
        .toMatchObject({ operationKind: 'cloud-existing-project', phase: 'admitted', projectsFolder: 'Original/Projects', slug: 'recovered-notes', request: null });
      expect(await projects.loadMembership(PROJECT_ID)).toEqual(retained);
      cut.mockRestore();
      if (entryIntent === 'legacy-restore') {
        const retainedRecord = await projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord);
        const { selectOnCompletion: _intent, ...legacyRecord } = retainedRecord!;
        await projects.saveProjectDocument(PROJECT_ID, 'pending-operation', legacyRecord);
      }
      await projects.upsertProject({ authorityKind: 'cloud', id: 'project-other', name: 'Other', workspacePath: 'Shared/Projects/other', createdAt: CREATED_AT, updatedAt: CREATED_AT });
      await projects.selectProject('project-other');
      const brokenPath = path.join(fixture.vaultRoot, projects.getProjectPaths('project-broken').pendingOperation);
      await mkdir(path.dirname(brokenPath), { recursive: true });
      await writeFile(brokenPath, '{invalid');
      await expect(feature.resumeSetup({ operationId: 'wrong-operation', projectId: PROJECT_ID })).resolves.toMatchObject({ status: 'failure' });
      const recovery = { operationId: entry.operationId, projectId: PROJECT_ID };
      await expect((entryIntent === 'join' ? fixture.createCoordinator() : feature).resumeSetup(recovery)).resolves.toMatchObject({ status: 'success', value: { workspacePath: membership.project.workspacePath } });
      expect(await projects.loadMembership(PROJECT_ID)).toEqual(retained);
      expect((await projects.loadIndex()).selectedProjectId).toBe(entryIntent === 'join' ? PROJECT_ID : 'project-other');
      expect(await readFile(path.join(fixture.vaultRoot, membership.project.workspacePath, 'personal.md'), 'utf8')).toBe('Remote personal contribution\n');
      const finalPublication = await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord);
      const initialPublication = expect.objectContaining({ baseMainOid: fixture.mainOid, operation: null });
      expect(finalPublication).toEqual(retainPublication ? publication : initialPublication);
      expect(fixture.joinRequests).toEqual([]);
      expect(await projects.listPendingOperationProjectIds()).toEqual(['project-broken']);
      await expect(lstat(path.join(fixture.vaultRoot, 'Shared/Projects/do-not-create'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { cut.mockRestore(); await feature.close(); await fixture.close(); }
  });

  it('reuses an exact surviving binding and working copy without resetting local publication progress', async () => {
    const fixture = await createFixture({ join: true });
    const feature = createFeatureFixture(fixture);
    try {
      const request = { encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob', projectSlug: 'existing-notes' };
      await expect(feature.joinProject(request)).resolves.toMatchObject({ status: 'success' });
      const publication = {
        baseMainOid: fixture.mainOid, projectId: PROJECT_ID, schemaVersion: 1, updatedAt: CREATED_AT,
        operation: { contributionHeadOid: fixture.mainOid, createdAt: CREATED_AT, operationId: 'publish-existing', phase: 'captured', updatedAt: CREATED_AT, candidateOid: null, currentMainOid: null },
      };
      await fixture.foundation.local.projects.saveProjectDocument(PROJECT_ID, 'publication-state', publication);
      const localPath = path.join(fixture.vaultRoot, 'Shared/Projects/existing-notes/local.md');
      await writeFile(localPath, 'Keep local edits\n');
      await expect(feature.joinProject({ ...request, projectSlug: 'do-not-create', memberDisplayName: 'Do not rename' }))
        .resolves.toMatchObject({ status: 'success', value: { workspacePath: 'Shared/Projects/existing-notes' } });
      expect(fixture.joinRequests).toHaveLength(1);
      expect(await readFile(localPath, 'utf8')).toBe('Keep local edits\n');
      expect(await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord)).toEqual(publication);
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
      await expect(lstat(path.join(fixture.vaultRoot, 'Shared/Projects/do-not-create'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await feature.close(); await fixture.close(); }
  });

  it('recovers an already-bound identity on a fresh device without another Join or losing remote contribution progress', async () => {
    const fixture = await createFixture({ join: true, alreadyBound: true, remoteContribution: true });
    const feature = createFeatureFixture(fixture);
    try {
      await fixture.foundation.local.projects.upsertProject({ authorityKind: 'cloud', id: 'project-other', name: 'Other', workspacePath: 'Shared/Projects/other', createdAt: CREATED_AT, updatedAt: CREATED_AT });
      await fixture.foundation.local.projects.selectProject('project-other');
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Ignored new name', projectSlug: 'existing-notes' }))
        .resolves.toMatchObject({ status: 'success', value: { role: 'member', workspacePath: 'Shared/Projects/existing-notes' } });
      expect((await fixture.foundation.local.projects.loadIndex()).selectedProjectId).toBe(PROJECT_ID);
      expect(fixture.joinRequests).toEqual([]);
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toMatchObject({
        authority: { authorityGeneration: 7 }, member: { displayName: 'Bob', id: MEMBER_ID },
      });
      expect(await readFile(path.join(fixture.vaultRoot, 'Shared/Projects/existing-notes/personal.md'), 'utf8')).toBe('Remote personal contribution\n');
      expect(await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord))
        .toMatchObject({ baseMainOid: fixture.mainOid, operation: null });
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
      expect(fixture.failures).toEqual([]);
    } finally { await feature.close(); await fixture.close(); }
  });
});
