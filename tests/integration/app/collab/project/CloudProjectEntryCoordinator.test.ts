import fs, { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CREATED_AT, createFeatureFixture, createFixture, git, gitRuntimeResolver, MEMBER_ID, OPERATION_ID, PROJECT_ID } from '@test/helpers/collab/CloudProjectEntryFixture';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { decodeCloudProjectEntryRecord } from '@/app/collab/project/CloudProjectEntryRecord';
import { decodeCloudProjectInvitation, encodeCloudProjectInvitation } from '@/app/collab/project/CloudProjectInvitation';
import { decodeCollabPublicationStateRecord } from '@/app/collab/publish/CollabPublicationStateRecord';

jest.setTimeout(30_000);

describe('CloudProjectEntryCoordinator', () => {
  it('uses the authenticated Project name for an invitation Join directory', async () => {
    const fixture = await createFixture({ join: true });
    try {
      await expect(fixture.coordinator.joinProject({
        invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob',
      })).resolves.toMatchObject({ status: 'success', value: { workspacePath: 'Shared/Projects/cloud-notes' } });
      expect(await git(path.join(fixture.vaultRoot, 'Shared/Projects/cloud-notes'), ['rev-parse', 'HEAD'])).toBe(fixture.mainOid);
    } finally { await fixture.close(); }
  });

  it('suffixes the derived directory and preserves an occupied path', async () => {
    const projectName = 'Collab Demo';
    const slug = 'collab-demo';
    const fixture = await createFixture({ join: true, projectName });
    const occupied = path.join(fixture.vaultRoot, 'Shared/Projects', slug);
    await fixture.foundation.local.workspace.claimProjectsFolder('Shared/Projects');
    await mkdir(occupied);
    await writeFile(path.join(occupied, 'keep.md'), 'Existing work');
    try {
      await expect(fixture.coordinator.joinProject({
        invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob',
      })).resolves.toMatchObject({ status: 'success', value: { workspacePath: `Shared/Projects/${slug}-1` } });
      expect(await readFile(path.join(occupied, 'keep.md'), 'utf8')).toBe('Existing work');
    } finally { await fixture.close(); }
  });

  it.each([
    ['Workspace', 'workspace-1'],
    ['CON', 'con-1'],
  ])('joins a Project named %s using an admissible directory', async (projectName, slug) => {
    const fixture = await createFixture({ join: true, projectName });
    try {
      await expect(fixture.coordinator.joinProject({
        invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob',
      })).resolves.toMatchObject({ status: 'success', value: { workspacePath: `Shared/Projects/${slug}` } });
    } finally { await fixture.close(); }
  });

  it.each(['directory', 'symlink', 'pending'] as const)('rejects an explicit Join slug already occupied by a %s before remote admission', async collision => {
    const fixture = await createFixture({ join: true });
    const feature = createFeatureFixture(fixture);
    const projects = fixture.foundation.local.projects;
    await fixture.foundation.local.workspace.claimProjectsFolder('Shared/Projects');
    const destination = path.join(fixture.vaultRoot, 'Shared/Projects/cloud-notes');
    const preserved = path.join(fixture.vaultRoot, 'preserved');
    await mkdir(preserved);
    await writeFile(path.join(preserved, 'keep.md'), 'Keep existing work\n');
    if (collision === 'pending') {
      await projects.saveProjectDocument('project-other-entry', 'pending-operation', decodeCloudProjectEntryRecord({
        admission: null, createdAt: CREATED_AT, operationId: 'entry-other', operationKind: 'cloud-create-project', phase: 'intent',
        projectId: 'project-other-entry', projectsFolder: 'Shared/Projects',
        request: { idempotencyKey: 'entry-other', managerDisplayName: 'Other', projectId: 'project-other-entry', projectName: 'Other' },
        schemaVersion: 2, principalId: `vault-${'a'.repeat(64)}`, serverUrl: fixture.serverUrl, slug: 'cloud-notes', stagingDirectoryName: '.claudian-clone-project-other-entry', updatedAt: CREATED_AT,
      }));
    } else if (collision === 'symlink') {
      await symlink(preserved, destination, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      await mkdir(destination);
      await writeFile(path.join(destination, 'keep.md'), 'Keep existing work\n');
    }
    try {
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob', projectSlug: 'cloud-notes' }))
        .resolves.toMatchObject({ status: 'failure', error: { code: 'workspace-boundary-invalid' } });
      expect(fixture.joinRequests).toEqual([]);
      expect(await projects.loadMembership(PROJECT_ID)).toBeNull();
      expect(await projects.listPendingOperationProjectIds()).toEqual(collision === 'pending' ? ['project-other-entry'] : []);
      expect(await readFile(path.join(preserved, 'keep.md'), 'utf8')).toBe('Keep existing work\n');
      const retained = collision === 'pending' ? await projects.loadProjectDocument('project-other-entry', 'pending-operation', decodeCloudProjectEntryRecord)
        : await readFile(path.join(destination, 'keep.md'), 'utf8');
      const pendingExpectation = expect.objectContaining({ operationId: 'entry-other', slug: 'cloud-notes' });
      const expected = collision === 'pending' ? pendingExpectation : 'Keep existing work\n';
      expect(retained).toEqual(expected);
    } finally { await feature.close(); await fixture.close(); }
  });

  it('does not turn an unknown local Cloud binding into discovery or ordinary Join', async () => {
    const fixture = await createFixture({ join: true, alreadyBound: true });
    const feature = createFeatureFixture(fixture);
    try {
      await expect(feature.joinProject({ existingCloudProjectId: PROJECT_ID })).resolves.toMatchObject({ status: 'failure' });
      expect(fixture.transportRequests).toEqual([]);
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each(['authorization', 'transport', 'malformed'] as const)('does not redeem an invitation after a %s snapshot failure', async snapshotFailure => {
    const fixture = await createFixture({ join: true, snapshotFailure });
    const feature = createFeatureFixture(fixture);
    try {
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob' })).resolves.toMatchObject({ status: 'failure' });
      expect(fixture.joinRequests).toEqual([]);
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toBeNull();
      expect(fixture.failures).toEqual([]);
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each(['rejected', 'wrong-member'] as const)('retains the exact intent without adopting a %s Join result', async joinFailure => {
    const fixture = await createFixture({ join: true, joinFailure });
    const feature = createFeatureFixture(fixture);
    try {
      const started = await feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob', projectSlug: 'cloud-notes' });
      expect(started).toMatchObject({ status: 'recovery-required' });
      if (started.status !== 'recovery-required') throw started;
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toBeNull();
      expect(await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord)).toMatchObject({ phase: 'intent', operationKind: 'cloud-join-project' });
      expect((await fixture.foundation.local.projects.loadIndex()).projects).toEqual([]);
      expect(feature.state).toMatchObject({ projects: [], pendingSetups: [{ operationId: started.operationId, projectId: PROJECT_ID, name: 'cloud-notes' }] });
      expect(fixture.joinRequests).toHaveLength(1);
      expect(fixture.failures).toEqual([]);
      await feature.close();
      await fixture.foundation.close();
      const restartedFoundation = new ClaudianCollabService({
        getConfiguredGitPath: () => '', gitRuntimeResolver, installationKey: TEST_INSTALLATION_A,
        obsidianConfigDirectory: '.obsidian', vaultRoot: fixture.vaultRoot,
      });
      const reopened = createFeatureFixture({ ...fixture, foundation: restartedFoundation });
      try {
        await expect(reopened.initialize()).resolves.toMatchObject({ status: 'success', value: {
          projects: [], pendingSetups: [{ operationId: started.operationId, projectId: PROJECT_ID, name: 'cloud-notes' }],
        } });
      } finally { await reopened.close(); await restartedFoundation.close(); }
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each(['expired', 'revoked', 'wrong-secret'] as const)('allows a fresh invitation after a proved %s Join rejection and client restart', async joinFailure => {
    const options: Parameters<typeof createFixture>[0] = { join: true, joinFailure };
    const fixture = await createFixture(options);
    let feature = createFeatureFixture(fixture);
    let restartedFoundation: ClaudianCollabService | undefined;
    try {
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob' }))
        .resolves.toMatchObject({ status: 'failure', error: { code: 'authorization-denied' } });
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
      await feature.close();
      await fixture.foundation.close();
      restartedFoundation = new ClaudianCollabService({
        getConfiguredGitPath: () => '', gitRuntimeResolver, installationKey: TEST_INSTALLATION_A,
        obsidianConfigDirectory: '.obsidian', vaultRoot: fixture.vaultRoot,
      });
      feature = createFeatureFixture({ ...fixture, foundation: restartedFoundation });
      delete options.joinFailure;
      const invitation = decodeCloudProjectInvitation(fixture.encodedInvitation);
      const fresh = encodeCloudProjectInvitation({ serverUrl: invitation.serverUrl, invitation: { ...invitation.invitation, invitationId: 'invitation-fresh' } });
      await expect(feature.joinProject({ encodedInvitation: fresh, memberDisplayName: 'Bob' }))
        .resolves.toMatchObject({ status: 'success' });
      expect(fixture.joinRequests).toHaveLength(2);
      const [rejected, admitted] = fixture.joinRequests as { idempotencyKey: string; invitationId: string }[];
      expect(admitted.invitationId).toBe('invitation-fresh');
      expect(admitted.idempotencyKey).not.toBe(rejected.idempotencyKey);
      expect(fixture.failures).toEqual([]);
    } finally { await feature.close(); await restartedFoundation?.close(); await fixture.close(); }
  });

  it.each(['before', 'after'] as const)('settles a proved Join rejection when its local removal fails %s commit', async point => {
    const fixture = await createFixture({ join: true, joinFailure: 'revoked' });
    const feature = createFeatureFixture(fixture);
    const projects = fixture.foundation.local.projects;
    const documentPath = path.join(fixture.vaultRoot, `.claudian/collab/projects/${PROJECT_ID}/pending-operation.json`);
    const unlink = fs.unlink;
    let injectFailure = true;
    const cut = jest.spyOn(fs, 'unlink').mockImplementation(async target => {
      if (target !== documentPath || !injectFailure) return unlink(target);
      injectFailure = false;
      if (point === 'after') await unlink(target);
      throw Object.assign(new Error('Injected document removal failure'), { code: 'EIO' });
    });
    try {
      const result = await feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob' });
      cut.mockRestore();
      expect(result).toMatchObject({ status: point === 'before' ? 'recovery-required' : 'failure' });
      const settled = point === 'before' && result.status === 'recovery-required'
        ? await feature.resumeSetup({ operationId: result.operationId }) : result;
      expect(settled).toMatchObject({ status: 'failure', error: { code: 'authorization-denied', recoveryActions: ['refresh-invitation'] } });
      const requests = fixture.joinRequests as { idempotencyKey: string }[];
      expect(requests).toHaveLength(point === 'before' ? 2 : 1);
      expect(requests.at(-1)!.idempotencyKey).toBe(requests[0].idempotencyKey);
      expect(await projects.listPendingOperationProjectIds()).toEqual([]);
      expect(feature.state.pendingSetups ?? []).toEqual([]);
      expect(await projects.loadMembership(PROJECT_ID)).toBeNull();
      expect(fixture.failures).toEqual([]);
    } finally { cut.mockRestore(); await feature.close(); await fixture.close(); }
  });

  it('keeps an admitted Join recoverable when its following snapshot is rejected', async () => {
    const options: Parameters<typeof createFixture>[0] = { join: true };
    const fixture = await createFixture(options);
    const feature = createFeatureFixture(fixture);
    let snapshotReads = 0;
    fixture.onSnapshot(() => { if (++snapshotReads === 2) options.snapshotFailure = 'settled'; });
    try {
      const result = await feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob' });
      expect(result).toMatchObject({ status: 'recovery-required' });
      if (result.status !== 'recovery-required') throw result;
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([PROJECT_ID]);
      delete options.snapshotFailure;
      await expect(feature.resumeSetup({ operationId: result.operationId })).resolves.toMatchObject({ status: 'success' });
      const requests = fixture.joinRequests as { idempotencyKey: string }[];
      expect(requests[1].idempotencyKey).toBe(requests[0].idempotencyKey);
      expect(fixture.failures).toEqual([]);
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each(['member', 'generation', 'missing-publication'] as const)('does not replace surviving local facts after %s drift', async drift => {
    const fixture = await createFixture({ join: true });
    const feature = createFeatureFixture(fixture);
    try {
      const request = { encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob', projectSlug: 'same-copy' };
      await expect(feature.joinProject(request)).resolves.toMatchObject({ status: 'success' });
      const retained = await fixture.foundation.local.projects.loadMembership(PROJECT_ID);
      const publication = await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord);
      if (drift === 'missing-publication') await fixture.foundation.local.projects.removeProjectDocument(PROJECT_ID, 'publication-state');
      else fixture.driftIdentity(drift);
      await expect(feature.joinProject(request)).resolves.toMatchObject({ status: 'failure' });
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toEqual(retained);
      expect(fixture.joinRequests).toHaveLength(1);
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
      expect(await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord)).toEqual(drift === 'missing-publication' ? null : publication);
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each(['missing', 'replaced'] as const)('requires the original credential when pending Join identity is %s', async state => {
    const fixture = await createFixture({ join: true });
    try {
      fixture.loseNextReply();
      await expect(fixture.coordinator.joinProject({
        invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob', projectSlug: 'cloud-notes',
      })).resolves.toMatchObject({ status: 'recovery-required', operationId: OPERATION_ID });
      const file = path.join(fixture.vaultRoot, `.claudian/collab/cloud-credentials/${PROJECT_ID}.json`);
      const credential = await readFile(file);
      const pending = await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord);
      await rm(file);
      if (state === 'replaced') await writeFile(file, JSON.stringify({ schemaVersion: 1, projectId: PROJECT_ID, credential: '1'.repeat(64) }));
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(fixture.joinRequests).toEqual([pending?.request]);
      expect(await lstat(file).then(() => true, () => false)).toBe(state === 'replaced');
      await writeFile(file, credential);
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'success' });
      expect(fixture.joinRequests).toEqual([pending?.request, pending?.request]);
    } finally { await fixture.close(); }
  });

  it('replays a possibly submitted Join exactly after reply loss even when the principal is now bound', async () => {
    const fixture = await createFixture({ join: true });
    try {
      fixture.loseNextReply();
      const request = { invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob', projectSlug: 'cloud-notes' };
      await expect(fixture.coordinator.joinProject(request)).resolves.toMatchObject({ status: 'recovery-required', operationId: OPERATION_ID });
      const pending = await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord);
      expect(pending).toMatchObject({ phase: 'intent', request: {
        idempotencyKey: OPERATION_ID, projectId: PROJECT_ID, displayName: 'Bob', invitationId: 'invitation-entry', secret: 'A'.repeat(43),
      } });
      fixture.setProjectsFolder('Do/Not/Use');
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'success' });
      expect(fixture.joinRequests).toEqual([pending?.request, pending?.request]);
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
      expect(fixture.failures).toEqual([]);
    } finally { await fixture.close(); }
  });

  it('joins an ordinary Cloud invitation through the real feature and shared working-copy owner', async () => {
    const fixture = await createFixture({ join: true, nonempty: true });
    const feature = createFeatureFixture(fixture);
    try {
      await expect(feature.joinProject({
        encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob', projectSlug: 'joined-notes',
      })).resolves.toMatchObject({ status: 'success', value: {
        authorityKind: 'cloud', hostStatus: 'not-host', id: PROJECT_ID,
        role: 'member', workspacePath: 'Shared/Projects/joined-notes',
      } });
      expect(fixture.joinRequests).toEqual([expect.objectContaining({
        displayName: 'Bob', invitationId: 'invitation-entry', projectId: PROJECT_ID, secret: 'A'.repeat(43),
      })]);
      expect(fixture.admittedRequests).toEqual([]);
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toMatchObject({
        authority: { authorityGeneration: 7, kind: 'cloud', serverUrl: fixture.serverUrl },
        member: { id: MEMBER_ID, personalRef: `refs/heads/members/${MEMBER_ID}`, role: 'member' },
      });
      expect(await readFile(path.join(fixture.vaultRoot, 'Shared/Projects/joined-notes/unexpected.md'), 'utf8')).toBe('Unexpected remote content\n');
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
      await expect(feature.readSnapshot(PROJECT_ID)).resolves.toMatchObject({ status: 'success', value: { snapshot: { project: { authorityKind: 'cloud', id: PROJECT_ID } } } });
      expect(fixture.failures).toEqual([]);
    } finally { await feature.close(); await fixture.close(); }
  });

  it('creates through the complete feature composition without starting a LAN Host', async () => {
    const fixture = await createFixture({ generatedProjectId: true });
    const feature = createFeatureFixture(fixture);
    try {
      await expect(feature.initialize()).resolves.toMatchObject({ status: 'success' });
      const result = await feature.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      });
      expect(result).toMatchObject({
        status: 'success', value: { authorityKind: 'cloud', hostStatus: 'not-host', workspacePath: 'Shared/Projects/cloud-notes' },
      });
      if (result.status !== 'success') throw result;
      expect(fixture.failures).toEqual([]);
      expect(await feature.listProjects()).toMatchObject({ status: 'success', value: [expect.objectContaining({ id: result.value.id, health: 'healthy' })] });
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
      expect(await feature.readSnapshot(result.value.id)).toMatchObject({ status: 'success', value: { snapshot: { project: { authorityGeneration: 7 } } } });
    } finally {
      await feature.close();
      await fixture.close();
    }
  });

  it('does not adopt a nonempty native Create repository', async () => {
    const fixture = await createFixture({ nonempty: true });
    try {
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toBeNull();
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([PROJECT_ID]);
    } finally { await fixture.close(); }
  });

  it.each(['before-start', 'before-send'] as const)('cleans only an unsent intent when cancelled %s', async point => {
    const fixture = await createFixture();
    const controller = new AbortController();
    try {
      if (point === 'before-start') controller.abort();
      else fixture.onCapabilities(() => controller.abort());
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      }, { signal: controller.signal })).resolves.toMatchObject({ status: 'cancelled', durableProgress: false });
      expect(fixture.admittedRequests).toEqual([]);
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
    } finally { await fixture.close(); }
  });

  it('closes an in-flight entry without losing a possibly committed Create', async () => {
    const fixture = await createFixture();
    let closing: Promise<void> | undefined;
    fixture.onCreate(() => { closing = fixture.coordinator.close(); });
    try {
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      })).resolves.toMatchObject({ status: 'recovery-required', operationId: OPERATION_ID });
      await closing;
      expect(closing).toBeDefined();
      expect(fixture.failures).toEqual([]);
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toBeNull();
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([PROJECT_ID]);
      fixture.onCreate(() => undefined);
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'success' });
      expect(fixture.admittedRequests).toHaveLength(2);
    } finally { await fixture.close(); }
  });

  it('persists admission before sending and activates only one completely finalized empty working copy', async () => {
    const fixture = await createFixture();
    const { admittedRequests, coordinator, failures, foundation, mainOid, serverUrl, vaultRoot } = fixture;
    try {
      const result = await coordinator.createProject({
        authority: { kind: 'cloud', serverUrl },
        memberDisplayName: 'Alice',
        name: 'Cloud Notes',
      });
      expect(failures).toEqual([]);
      if (result.status === 'failure' || result.status === 'recovery-required') throw result.error;
      expect(result).toMatchObject({
        status: 'success',
        value: { authorityKind: 'cloud', id: PROJECT_ID, role: 'manager', workspacePath: 'Shared/Projects/cloud-notes' },
      });
      expect(failures).toEqual([]);
      expect(admittedRequests).toHaveLength(1);
      expect(await foundation.local.projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord))
        .toMatchObject({ baseMainOid: mainOid, operation: null });
      expect(await foundation.local.projects.loadMembership(PROJECT_ID)).toMatchObject({
        authority: { authorityGeneration: 7, bindingVersion: 10, kind: 'cloud', serverUrl, wireVersion: 15 },
        member: { id: MEMBER_ID, personalRef: `refs/heads/members/${MEMBER_ID}`, role: 'manager' },
      });
      const workingCopy = path.join(vaultRoot, 'Shared', 'Projects', 'cloud-notes');
      expect(await git(workingCopy, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/members/${MEMBER_ID}`);
      expect(await git(workingCopy, ['ls-tree', '--name-only', 'HEAD'])).toBe('');
      expect(await foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);

    } finally {
      await fixture.close();
    }
  });

  it('replays the exact stored Create after losing its reply, without a second Project or changed folder', async () => {
    const fixture = await createFixture();
    try {
      fixture.loseNextReply();
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl },
        memberDisplayName: 'Alice', name: 'Cloud Notes',
      })).resolves.toMatchObject({ status: 'recovery-required', operationId: OPERATION_ID });
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([PROJECT_ID]);
      expect((await fixture.foundation.local.projects.loadIndex()).projects).toEqual([]);
      fixture.setProjectsFolder('Other/Projects');
      const restarted = fixture.createCoordinator();
      await expect(restarted.resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({
        status: 'success', value: { id: PROJECT_ID, workspacePath: 'Shared/Projects/cloud-notes' },
      });
      expect(fixture.admittedRequests).toEqual([
        { idempotencyKey: OPERATION_ID, managerDisplayName: 'Alice', projectId: PROJECT_ID, projectName: 'Cloud Notes' },
        { idempotencyKey: OPERATION_ID, managerDisplayName: 'Alice', projectId: PROJECT_ID, projectName: 'Cloud Notes' },
      ]);
      expect(fixture.failures).toEqual([]);
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
