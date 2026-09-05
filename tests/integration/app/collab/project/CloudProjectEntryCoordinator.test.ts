import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import fs, { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  COLLAB_LIMITS,
  collabCloudCapabilityDocument,
  collabCloudErrorEnvelope,
  collabCloudProjectOperationRoute,
  collabCloudSuccessEnvelope,
  collabControlOperationCodec,
  CollabError,
  decodeCollabProtocolEnvelope,
  matchCollabCloudRoute,
} from '@claudian-collab/protocol';
import { runGitHttpBackendFixture } from '@test/helpers/collab/GitHttpBackendFixture';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';

import { CollabProjectWorkSessionRegistry } from '@/app/collab/activity/CollabProjectWorkSession';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { createCollabFeatureSubcomposition } from '@/app/collab/CollabFeatureSubcomposition';
import { decodeManagerResponsibilityReceiptRecord } from '@/app/collab/exit/ManagerResponsibilityReceiptRecord';
import { CloudProjectEntryCoordinator } from '@/app/collab/project/CloudProjectEntryCoordinator';
import { decodeCloudProjectEntryRecord } from '@/app/collab/project/CloudProjectEntryRecord';
import { decodeCloudProjectInvitation, encodeCloudProjectInvitation } from '@/app/collab/project/CloudProjectInvitation';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { decodeCollabPublicationStateRecord } from '@/app/collab/publish/CollabPublicationStateRecord';
import { CloudAuthorityAdapter } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import type { CollabAuthoritySession } from '@/app/collab/remote-authority/CollabAuthoritySession';

const PROJECT_ID = 'project-cloud-entry';
const MEMBER_ID = 'member-server-selected';
const OPERATION_ID = 'entry-one';
const CREATED_AT = '2026-09-01T00:00:00.000Z';
const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

jest.setTimeout(30_000);


describe('CloudProjectEntryCoordinator', () => {
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
        schemaVersion: 1, serverUrl: fixture.serverUrl, slug: 'cloud-notes', stagingDirectoryName: '.claudian-clone-project-other-entry', updatedAt: CREATED_AT,
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

  it.each(['create', 'join', 'existing'] as const)('does not claim durable %s progress when its initial intent write never commits', async entry => {
    const fixture = await createFixture({ join: entry !== 'create', alreadyBound: entry === 'existing' });
    const projects = fixture.foundation.local.projects;
    const cut = jest.spyOn(projects, 'saveProjectDocument').mockRejectedValueOnce(Object.assign(new Error('Injected initial disk failure'), { code: 'ENOSPC' }));
    const start = () => entry === 'create' ? fixture.coordinator.createProject({
      authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
    }) : fixture.coordinator.joinProject({ invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob', projectSlug: 'cloud-notes' });
    try {
      await expect(start()).resolves.toMatchObject({ status: 'failure', error: { code: 'operation-failed', recoveryActions: ['retry', 'open-diagnostics'] } });
      expect(await projects.listPendingOperationProjectIds()).toEqual([]);
      expect(fixture.admittedRequests).toEqual([]);
      expect(fixture.joinRequests).toEqual([]);
      cut.mockRestore();
      await expect(start()).resolves.toMatchObject({ status: 'success' });
      expect(await projects.listPendingOperationProjectIds()).toEqual([]);
    } finally { cut.mockRestore(); await fixture.close(); }
  });

  it.each(['unreadable', 'different'] as const)('does not claim a known durable intent when the failed initial write leaves %s state', async state => {
    const fixture = await createFixture();
    const projects = fixture.foundation.local.projects;
    const save = projects.saveProjectDocument.bind(projects);
    const load = projects.loadProjectDocument.bind(projects);
    let writeFailed = false;
    const cut = jest.spyOn(projects, 'saveProjectDocument').mockImplementationOnce(async (...args) => {
      const value = state === 'different' ? { ...args[2], serverUrl: 'http://127.0.0.1:1/different' } : args[2];
      await save(args[0], args[1], value);
      writeFailed = true;
      throw new Error('Injected post-promotion failure');
    });
    const readCut = jest.spyOn(projects, 'loadProjectDocument').mockImplementation((...args) => {
      if (writeFailed && state === 'unreadable') return Promise.reject(new Error('Injected read failure'));
      return load(...args);
    });
    try {
      await expect(fixture.coordinator.createProject({ authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes' }))
        .resolves.toMatchObject({ status: 'failure', error: { code: 'operation-failed', recoveryActions: ['open-diagnostics'] } });
      cut.mockRestore();
      readCut.mockRestore();
      expect(await projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord)).toMatchObject({ operationId: OPERATION_ID, phase: 'intent', serverUrl: state === 'different' ? 'http://127.0.0.1:1/different' : fixture.serverUrl });
      expect(fixture.admittedRequests).toEqual([]);
      expect(await projects.listPendingOperationProjectIds()).toEqual([PROJECT_ID]);
    } finally { cut.mockRestore(); readCut.mockRestore(); await fixture.close(); }
  });

  it('does not adopt a markerless current Cloud staging clone even when its Git identity matches', async () => {
    const fixture = await createFixture();
    const projects = fixture.foundation.local.projects;
    const save = projects.saveProjectDocument.bind(projects);
    const cut = jest.spyOn(projects, 'saveProjectDocument').mockImplementation(async (...args) => {
      await save(...args);
      if (args[1] === 'pending-operation' && (args[2] as { phase?: string }).phase === 'clone-validated') throw new Error('Injected clone checkpoint cut');
    });
    try {
      await expect(fixture.coordinator.createProject({ authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes' }))
        .resolves.toMatchObject({ status: 'recovery-required' });
      cut.mockRestore();
      await fixture.foundation.local.workspace.releaseReservedProjectsFolderChild('Shared/Projects', {
        childName: `.claudian-clone-${PROJECT_ID}`, operationId: OPERATION_ID, projectId: PROJECT_ID, purpose: 'create-clone',
      });
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await projects.loadMembership(PROJECT_ID)).toBeNull();
      expect((await lstat(path.join(fixture.vaultRoot, `Shared/Projects/.claudian-clone-${PROJECT_ID}`))).isDirectory()).toBe(true);
      await expect(lstat(path.join(fixture.vaultRoot, 'Shared/Projects/cloud-notes'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { cut.mockRestore(); await fixture.close(); }
  });

  it('derives a portable directory from an underscore-prefixed valid Project name', async () => {
    const fixture = await createFixture({ projectName: '_Cloud Notes' });
    try {
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: '_Cloud Notes',
      })).resolves.toMatchObject({ status: 'success', value: { name: '_Cloud Notes', workspacePath: 'Shared/Projects/cloud-notes' } });
      expect(fixture.failures).toEqual([]);
    } finally { await fixture.close(); }
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

  it.each([false, true])('resumes missing-copy setup from a synchronized binding (retained publication: %s)', async retainPublication => {
    const fixture = await createFixture({ join: true, alreadyBound: true, remoteContribution: true });
    const feature = createFeatureFixture(fixture);
    const projects = fixture.foundation.local.projects;
    const membership = {
      schemaVersion: 3 as const, createdAt: CREATED_AT, updatedAt: CREATED_AT, lastEventSequence: 7,
      authority: { kind: 'cloud' as const, authorityGeneration: 7, bindingVersion: 5 as const, wireVersion: 9 as const,
        serverUrl: fixture.serverUrl, gitRemoteUrl: `${fixture.serverUrl}/v5/projects/${PROJECT_ID}/repository.git` },
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
      const entry = await feature.joinProject(retainPublication
        ? { existingCloudProjectId: PROJECT_ID }
        : { encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Do not rename', projectSlug: 'do-not-create' });
      expect(entry).toMatchObject({ status: 'recovery-required' });
      if (entry.status !== 'recovery-required') throw entry;
      expect(await projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord))
        .toMatchObject({ operationKind: 'cloud-existing-project', phase: 'admitted', projectsFolder: 'Original/Projects', slug: 'recovered-notes', request: null });
      expect(await projects.loadMembership(PROJECT_ID)).toEqual(retained);
      cut.mockRestore();
      await expect(feature.resumeSetup({ operationId: entry.operationId })).resolves.toMatchObject({ status: 'success', value: { workspacePath: membership.project.workspacePath } });
      expect(await projects.loadMembership(PROJECT_ID)).toEqual(retained);
      expect(await readFile(path.join(fixture.vaultRoot, membership.project.workspacePath, 'personal.md'), 'utf8')).toBe('Remote personal contribution\n');
      const finalPublication = await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord);
      const initialPublication = expect.objectContaining({ baseMainOid: fixture.mainOid, operation: null });
      expect(finalPublication).toEqual(retainPublication ? publication : initialPublication);
      expect(fixture.joinRequests).toEqual([]);
      expect(await projects.listPendingOperationProjectIds()).toEqual([]);
      await expect(lstat(path.join(fixture.vaultRoot, 'Shared/Projects/do-not-create'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { cut.mockRestore(); await feature.close(); await fixture.close(); }
  });

  it.each(['inspectProject', 'selectProject'] as const)('fences %s until a locally finalized Cloud entry completes recovery', async operation => {
    const fixture = await createFixture();
    fixture.failNextActivation();
    const feature = createFeatureFixture(fixture);
    try {
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      })).resolves.toMatchObject({ status: 'recovery-required', operationId: OPERATION_ID });
      expect(await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord))
        .toMatchObject({ phase: 'locally-finalized' });
      const before = [...fixture.transportRequests];
      await expect(feature[operation](PROJECT_ID)).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
      expect(fixture.transportRequests).toEqual(before);
      await expect(feature.listProjects()).resolves.toMatchObject({ status: 'success', value: [expect.objectContaining({ id: PROJECT_ID, health: 'needs-attention' })] });
      await expect(feature.listPendingSetupOperationIds()).resolves.toEqual([OPERATION_ID]);
      await expect(feature.resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'success' });
      await expect(feature[operation](PROJECT_ID)).resolves.toMatchObject({ status: 'success' });
    } finally { await feature.close(); await fixture.close(); }
  });

  it('preserves existing-identity entry recovery when cancellation follows local placement', async () => {
    const fixture = await createFixture({ join: true, alreadyBound: true });
    const controller = new AbortController();
    const projects = fixture.foundation.local.projects;
    const save = projects.saveProjectDocument.bind(projects);
    const cut = jest.spyOn(projects, 'saveProjectDocument').mockImplementation(async (...args) => {
      await save(...args);
      if (args[1] === 'pending-operation' && (args[2] as { phase?: string }).phase === 'placed') controller.abort();
    });
    try {
      await expect(fixture.coordinator.joinProject({
        invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob', projectSlug: 'cloud-notes',
      }, { signal: controller.signal })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord)).toMatchObject({ operationKind: 'cloud-existing-project', phase: 'placed' });
      cut.mockRestore();
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'success' });
      expect(fixture.joinRequests).toEqual([]);
    } finally { cut.mockRestore(); await fixture.close(); }
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
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Bob' })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toBeNull();
      expect(await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord)).toMatchObject({ phase: 'intent', operationKind: 'cloud-join-project' });
      expect((await fixture.foundation.local.projects.loadIndex()).projects).toEqual([]);
      expect(fixture.joinRequests).toHaveLength(1);
      expect(fixture.failures).toEqual([]);
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
        getConfiguredGitPath: () => '', installationKey: TEST_INSTALLATION_A,
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
      expect(settled).toMatchObject({ status: 'failure', error: { code: 'authorization-denied' } });
      const requests = fixture.joinRequests as { idempotencyKey: string }[];
      expect(requests).toHaveLength(point === 'before' ? 2 : 1);
      expect(requests.at(-1)!.idempotencyKey).toBe(requests[0].idempotencyKey);
      expect(await projects.listPendingOperationProjectIds()).toEqual([]);
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
      await expect(feature.joinProject({ encodedInvitation: fixture.encodedInvitation, memberDisplayName: 'Ignored new name', projectSlug: 'existing-notes' }))
        .resolves.toMatchObject({ status: 'success', value: { role: 'member', workspacePath: 'Shared/Projects/existing-notes' } });
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

  it('retains completed local facts when cancellation interrupts ordinary activation', async () => {
    const fixture = await createFixture({ generatedProjectId: true });
    const feature = createFeatureFixture(fixture);
    const controller = new AbortController();
    fixture.onSnapshot(async projectId => {
      const pending = await fixture.foundation.local.projects.loadProjectDocument(projectId, 'pending-operation', decodeCloudProjectEntryRecord);
      if (pending?.phase === 'locally-finalized') controller.abort();
    });
    try {
      await expect(feature.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      }, { signal: controller.signal })).resolves.toMatchObject({ status: 'recovery-required' });
      const [projectId] = await fixture.foundation.local.projects.listPendingOperationProjectIds();
      expect(await fixture.foundation.local.projects.loadProjectDocument(projectId, 'pending-operation', decodeCloudProjectEntryRecord)).toMatchObject({ phase: 'locally-finalized' });
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each(['create', 'join'].flatMap(entry => ['intent', 'admitted', 'clone-validated', 'rename-before-checkpoint', 'placed', 'locally-finalized'].map(phase => ({ entry, phase }))))(
    'recovers $entry after actual process death at the durable $phase boundary', async ({ entry, phase }) => {
      const fixture = await createFixture({ join: entry === 'join' });
      const bundle = path.join(fixture.vaultRoot, 'crash-fixture.cjs');
      await build({
        bundle: true, entryPoints: [path.resolve('tests/helpers/collab/CloudEntryCrashFixture.ts')],
        logLevel: 'silent', outfile: bundle, packages: 'external', platform: 'node',
        target: 'node24', tsconfig: path.resolve('tsconfig.json'),
      });
      const child = fork(bundle, [], {
        env: { ...process.env, NODE_PATH: path.resolve('node_modules') }, execArgv: [],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      try {
        const durable = new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', () => reject(new Error(`Fixture exited before the durable cut: ${String(child.stderr?.read() ?? '').slice(0, 500)}`)));
          child.once('message', message => {
            if ((message as { type?: string; phase?: string }).type !== 'durable-cut'
              || (message as { phase?: string }).phase !== phase) reject(new Error('Unexpected crash fixture outcome'));
            else resolve();
          });
        });
        child.send({ phase, installationKey: TEST_INSTALLATION_A, operationId: OPERATION_ID, projectId: PROJECT_ID, serverUrl: fixture.serverUrl, vaultRoot: fixture.vaultRoot,
          ...(entry === 'join' ? { encodedInvitation: fixture.encodedInvitation } : {}),
        });
        await durable;
        expect(child.kill('SIGKILL')).toBe(true);
        await exited;
        expect(child.signalCode).toBe('SIGKILL');
        expect(await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord)).toMatchObject({ phase: phase === 'rename-before-checkpoint' ? 'clone-validated' : phase });
        await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'success' });
        expect(entry === 'join' ? fixture.joinRequests : fixture.admittedRequests).toHaveLength(1);
        expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        await fixture.close();
      }
    },
  );

  it('does not resume entry past a competing durable lifecycle owner', async () => {
    const fixture = await createFixture({ generatedProjectId: true });
    const feature = createFeatureFixture(fixture);
    try {
      fixture.loseNextReply();
      const created = await feature.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      });
      if (created.status !== 'recovery-required') throw created;
      const projects = fixture.foundation.local.projects;
      const [projectId] = await projects.listPendingOperationProjectIds();
      await projects.saveLifecycleProjectDocument(projectId, 'manager-responsibility-receipt', {
        schemaVersion: 2, kind: 'manager-responsibility-receipt', projectId, offerId: 'offer-conflicting',
        sourceManagerMemberId: 'member-other', targetMemberId: MEMBER_ID, purpose: 'manager-leave',
        status: 'acknowledged', offeredAt: CREATED_AT, expiresAt: '2026-09-01T00:10:00.000Z',
        acknowledgedAt: CREATED_AT, updatedAt: CREATED_AT,
      }, decodeManagerResponsibilityReceiptRecord);
      await expect(feature.resumeSetup({ operationId: created.operationId })).resolves.toMatchObject({
        status: 'failure', error: { code: 'durable-progress-recovery-required', safeContext: { reason: 'lifecycle-owner-ambiguous' } },
      });
      expect(fixture.admittedRequests).toHaveLength(1);
      expect(await projects.listPendingOperationProjectIds()).toEqual([projectId]);
    } finally { await feature.close(); await fixture.close(); }
  });

  it.each(['occupied', 'symlink', 'foreign-staging'] as const)('preserves a %s boundary introduced after admission intent', async boundary => {
    const fixture = await createFixture();
    const folder = path.join(fixture.vaultRoot, 'Shared/Projects');
    const outside = path.join(fixture.vaultRoot, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.md'), 'Keep outside work\n');
    fixture.onCreate(async () => {
      if (boundary === 'occupied') {
        await mkdir(path.join(folder, 'cloud-notes'));
        await writeFile(path.join(folder, 'cloud-notes/keep.md'), 'Keep occupied work\n');
      } else if (boundary === 'symlink') {
        await symlink(outside, path.join(folder, 'cloud-notes'), 'junction');
      } else {
        await fixture.foundation.local.workspace.reserveProjectsFolderChild('Shared/Projects', {
          childName: `.claudian-clone-${PROJECT_ID}`, operationId: 'different-operation', projectId: PROJECT_ID, purpose: 'create-clone',
        });
        await mkdir(path.join(folder, `.claudian-clone-${PROJECT_ID}`));
        await writeFile(path.join(folder, `.claudian-clone-${PROJECT_ID}/keep.md`), 'Keep staging work\n');
      }
    });
    try {
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await fixture.foundation.local.projects.loadMembership(PROJECT_ID)).toBeNull();
      const protectedPath = boundary === 'foreign-staging' ? `.claudian-clone-${PROJECT_ID}/keep.md` : 'cloud-notes/keep.md';
      expect(await readFile(path.join(folder, protectedPath), 'utf8')).toBe(
        boundary === 'foreign-staging' ? 'Keep staging work\n' : boundary === 'occupied' ? 'Keep occupied work\n' : 'Keep outside work\n',
      );
      expect(await readFile(path.join(outside, 'keep.md'), 'utf8')).toBe('Keep outside work\n');
      expect(await fixture.foundation.local.projects.listPendingOperationProjectIds()).toEqual([PROJECT_ID]);
    } finally { await fixture.close(); }
  });

  it.each([
    { schemaVersion: 0 }, { phase: 'unknown' }, { serverUrl: 'http://host.invalid/?secret=not-allowed' },
    { stagingDirectoryName: '../foreign' }, { ownerInstallationKey: TEST_INSTALLATION_A },
  ])('leaves corrupt current-only recovery evidence untouched (%j)', async corruption => {
    const fixture = await createFixture();
    try {
      fixture.loseNextReply();
      await fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      });
      const documentPath = path.join(fixture.vaultRoot, `.claudian/collab/projects/${PROJECT_ID}/pending-operation.json`);
      const original = JSON.parse(await readFile(documentPath, 'utf8'));
      const corrupt = JSON.stringify({ ...original, ...corruption });
      await writeFile(documentPath, corrupt);
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'failure', error: { code: 'durable-progress-recovery-required' } });
      expect(await readFile(documentPath, 'utf8')).toBe(corrupt);
      expect(fixture.admittedRequests).toHaveLength(1);
      expect((await lstat(documentPath)).isFile()).toBe(true);
    } finally { await fixture.close(); }
  });

  it.each(['membership', 'publication-state', 'index'] as const)('does not activate a finalized entry whose %s is no longer complete', async missing => {
    const fixture = await createFixture({ generatedProjectId: true });
    const feature = createFeatureFixture(fixture);
    const projects = fixture.foundation.local.projects;
    const cut = jest.spyOn(projects, 'removeProjectDocument').mockRejectedValueOnce(new Error('Injected pending-removal cut'));
    try {
      const created = await feature.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      });
      expect(created).toMatchObject({ status: 'recovery-required' });
      if (created.status !== 'recovery-required') throw created;
      cut.mockRestore();
      const [projectId] = await projects.listPendingOperationProjectIds();
      if (missing === 'index') {
        const current = await projects.loadIndex();
        await writeFile(path.join(fixture.vaultRoot, '.claudian/collab/index.json'), JSON.stringify({ ...current, projects: [], selectedProjectId: null }));
      } else {
        await rm(path.join(fixture.vaultRoot, `.claudian/collab/projects/${projectId}/${missing}.json`));
      }
      await expect(feature.resumeSetup({ operationId: created.operationId })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await projects.listPendingOperationProjectIds()).toEqual([projectId]);
    } finally { cut.mockRestore(); await feature.close(); await fixture.close(); }
  });

  it('rejects a foreign local Project identity after a rename-before-checkpoint interruption', async () => {
    const fixture = await createFixture();
    const projects = fixture.foundation.local.projects;
    const save = projects.saveProjectDocument.bind(projects);
    const cut = jest.spyOn(projects, 'saveProjectDocument').mockImplementation(async (...args) => {
      await save(...args);
      if ((args[2] as { phase?: string }).phase === 'clone-validated') throw new Error('Injected clone checkpoint interruption');
    });
    try {
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      })).resolves.toMatchObject({ status: 'recovery-required' });
      cut.mockRestore();
      const folder = path.join(fixture.vaultRoot, 'Shared/Projects');
      const destination = path.join(folder, 'cloud-notes');
      await rename(path.join(folder, `.claudian-clone-${PROJECT_ID}`), destination);
      await git(destination, ['config', '--local', 'claudian.projectId', 'project-foreign']);
      await expect(fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID })).resolves.toMatchObject({ status: 'recovery-required' });
      expect(await projects.loadMembership(PROJECT_ID)).toBeNull();
      expect(await git(destination, ['config', '--local', '--get', 'claudian.projectId'])).toBe('project-foreign');
      expect(await projects.listPendingOperationProjectIds()).toEqual([PROJECT_ID]);
    } finally { cut.mockRestore(); await fixture.close(); }
  });

  it('keeps ordinary feature admission closed while local finalization is incomplete', async () => {
    const fixture = await createFixture({ generatedProjectId: true });
    const feature = createFeatureFixture(fixture);
    const save = fixture.foundation.local.projects.saveMembership.bind(fixture.foundation.local.projects);
    const cut = jest.spyOn(fixture.foundation.local.projects, 'saveMembership').mockImplementationOnce(async membership => {
      await save(membership);
      throw new Error('Injected finalization interruption');
    });
    try {
      const created = await feature.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      });
      expect(created).toMatchObject({ status: 'recovery-required' });
      if (created.status !== 'recovery-required') throw created;
      const [projectId] = await fixture.foundation.local.projects.listPendingOperationProjectIds();
      expect(await feature.listPendingSetupOperationIds()).toEqual([created.operationId]);
      await expect(feature.readSnapshot(projectId)).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
      await expect(feature.resumeSetup({ operationId: created.operationId })).resolves.toMatchObject({ status: 'success' });
      await expect(feature.readSnapshot(projectId)).resolves.toMatchObject({ status: 'success' });
      expect(fixture.failures).toEqual([]);
    } finally {
      cut.mockRestore();
      await feature.close();
      await fixture.close();
    }
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
        authority: { authorityGeneration: 7, bindingVersion: 5, kind: 'cloud', serverUrl, wireVersion: 9 },
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

  it.each(['create', 'join'].flatMap(entry => ['intent', 'admitted', 'clone-validated', 'placed', 'locally-finalized', 'membership', 'publication', 'index'].map(cut => ({ entry, cut }))))(
    'resumes the same $entry after a durable $cut write without resetting publication progress', async ({ entry, cut }) => {
      const fixture = await createFixture({ join: entry === 'join' });
      const projects = fixture.foundation.local.projects;
      let interrupted = false;
      const interrupt = (point: string) => {
        if (!interrupted && point === cut) { interrupted = true; throw new Error('Injected durable cut'); }
      };
      const saveDocument = projects.saveProjectDocument.bind(projects);
      const saveMembership = projects.saveMembership.bind(projects);
      const upsert = projects.upsertProject.bind(projects);
      const spies = [
        jest.spyOn(projects, 'saveProjectDocument').mockImplementation(async (...args) => {
          await saveDocument(...args);
          interrupt(args[1] === 'publication-state' ? 'publication' : (args[2] as { phase?: string }).phase ?? 'other');
        }),
        jest.spyOn(projects, 'saveMembership').mockImplementation(async membership => { await saveMembership(membership); interrupt('membership'); }),
        jest.spyOn(projects, 'upsertProject').mockImplementation(async project => { await upsert(project); interrupt('index'); }),
      ];
      try {
        await expect(entry === 'join' ? fixture.coordinator.joinProject({
          invitation: decodeCloudProjectInvitation(fixture.encodedInvitation), memberDisplayName: 'Bob', projectSlug: 'cloud-notes',
        }) : fixture.coordinator.createProject({
          authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
        })).resolves.toMatchObject({ status: 'recovery-required', operationId: OPERATION_ID });
        expect(interrupted).toBe(true);
        const pending = await projects.loadProjectDocument(PROJECT_ID, 'pending-operation', decodeCloudProjectEntryRecord);
        expect(pending?.operationId).toBe(OPERATION_ID);
        spies.forEach(spy => spy.mockRestore());
        const publication = await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord);
        if (publication) {
          await projects.saveProjectDocument(PROJECT_ID, 'publication-state', {
            ...publication, updatedAt: '2026-09-01T01:00:00.000Z',
          });
          await writeFile(path.join(fixture.vaultRoot, 'Shared/Projects/cloud-notes/local.md'), 'Preserved after partial finalization\n');
        }
        const before = await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord);
        const resumed = await fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID });
        if (resumed.status !== 'success') throw resumed;
        expect(entry === 'join' ? fixture.joinRequests : fixture.admittedRequests).toHaveLength(1);
        expect(await projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord)).toEqual(before ?? {
          baseMainOid: fixture.mainOid, operation: null, projectId: PROJECT_ID, schemaVersion: 1, updatedAt: CREATED_AT,
        });
        const localContent = await readFile(path.join(fixture.vaultRoot, 'Shared/Projects/cloud-notes/local.md'), 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        expect(localContent).toBe(before ? 'Preserved after partial finalization\n' : null);
        expect(await projects.listPendingOperationProjectIds()).toEqual([]);
        expect(fixture.failures).toEqual([]);
      } finally {
        spies.forEach(spy => spy.mockRestore());
        await fixture.close();
      }
    },
  );

  it('preserves a surviving working tree and publication operation when activation must be retried', async () => {
    const fixture = await createFixture();
    try {
      fixture.failNextActivation();
      await expect(fixture.coordinator.createProject({
        authority: { kind: 'cloud', serverUrl: fixture.serverUrl }, memberDisplayName: 'Alice', name: 'Cloud Notes',
      })).resolves.toMatchObject({ status: 'recovery-required' });
      const workingCopy = path.join(fixture.vaultRoot, 'Shared/Projects/cloud-notes');
      await writeFile(path.join(workingCopy, 'local.md'), 'Unsaved local work\n');
      const publication = {
        baseMainOid: fixture.mainOid,
        operation: { contributionHeadOid: fixture.mainOid, createdAt: CREATED_AT, operationId: 'publish-existing', phase: 'captured', updatedAt: CREATED_AT, candidateOid: null, currentMainOid: null },
        projectId: PROJECT_ID, schemaVersion: 1, updatedAt: CREATED_AT,
      };
      await fixture.foundation.local.projects.saveProjectDocument(PROJECT_ID, 'publication-state', publication);
      const resumed = await fixture.createCoordinator().resumeSetup({ operationId: OPERATION_ID });
      expect(resumed).toMatchObject({ status: 'success' });
      expect(await readFile(path.join(workingCopy, 'local.md'), 'utf8')).toBe('Unsaved local work\n');
      expect(await fixture.foundation.local.projects.loadProjectDocument(PROJECT_ID, 'publication-state', decodeCollabPublicationStateRecord)).toEqual(publication);
    } finally { await fixture.close(); }
  });
});

function createFeatureFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const setup = new CollabProjectSetupService(fixture.foundation, {
    installationKey: TEST_INSTALLATION_A, vaultRoot: fixture.vaultRoot,
  });
  return createCollabFeatureSubcomposition({
    cloudAuthority: fixture.adapter,
    foundation: fixture.foundation,
    getProjectsFolder: () => 'Shared/Projects',
    projectSetup: setup,
    vaultRoot: fixture.vaultRoot,
  }).feature;
}

async function createFixture(options: {
  projectName?: string;
  nonempty?: boolean; generatedProjectId?: boolean; join?: boolean; alreadyBound?: boolean; remoteContribution?: boolean;
  snapshotFailure?: 'authorization' | 'transport' | 'malformed' | 'settled'; joinFailure?: 'rejected' | 'wrong-member' | 'expired' | 'revoked' | 'wrong-secret';
} = {}) {
  let projectId = PROJECT_ID;
  let projectsFolder = 'Shared/Projects';
  const root = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-entry-'));
  const vaultRoot = path.join(root, 'vault');
  const seed = path.join(root, 'seed');
  const barePath = path.join(root, 'authority.git');
  await mkdir(vaultRoot);
  await mkdir(seed);
  await git(seed, ['init', '--initial-branch=main']);
  if (options.nonempty) {
    await writeFile(path.join(seed, 'unexpected.md'), 'Unexpected remote content\n');
    await git(seed, ['add', 'unexpected.md']);
  }
  await git(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Empty Project']);
  const mainOid = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['branch', `members/${MEMBER_ID}`]);
  if (options.remoteContribution) {
    await git(seed, ['checkout', `members/${MEMBER_ID}`]);
    await writeFile(path.join(seed, 'personal.md'), 'Remote personal contribution\n');
    await git(seed, ['add', 'personal.md']);
    await git(seed, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Personal contribution']);
  }
  await git(root, ['clone', '--bare', seed, barePath]);

  const foundation = new ClaudianCollabService({
    getConfiguredGitPath: () => '',
    installationKey: TEST_INSTALLATION_A,
    obsidianConfigDirectory: '.obsidian',
    vaultRoot,
  });
  const sessions = new CollabProjectWorkSessionRegistry();
  const member = {
    activatedAt: CREATED_AT,
    createdAt: CREATED_AT,
    displayName: options.join ? 'Bob' : 'Alice',
    id: MEMBER_ID,
    personalRef: `refs/heads/members/${MEMBER_ID}`,
    role: options.join ? 'member' : 'manager',
    status: 'active',
  };
  const snapshot = {
    currentMember: member,
    eventSequence: 7,
    members: [member],
    openRequests: [],
    openTicketCount: 0,
    project: {
      authorityGeneration: 7,
      createdAt: CREATED_AT,
      expectedMainOid: mainOid,
      id: projectId,
      mainRef: 'refs/heads/main',
      name: options.projectName ?? 'Cloud Notes',
    },
    ticketHighlights: [],
  };
  const admittedRequests: unknown[] = [];
  const joinRequests: unknown[] = [];
  let bound = !options.join || options.alreadyBound === true;
  let loseNextReply = false;
  let failActivation = false;
  let onCapabilities = () => {};
  let onCreate: () => void | Promise<void> = () => {};
  let onSnapshot: (projectId: string) => void | Promise<void> = () => {};
  const failures: unknown[] = [];
  const transportRequests: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const target = request.url ?? '';
      transportRequests.push(`${request.method} ${target}`);
      assert.match(target, /^\/operator\/cloud\//);
      assert.equal(request.headers['x-claudian-development-actor'], undefined);
      const routeTarget = target.slice('/operator/cloud'.length);
      const route = matchCollabCloudRoute(request.method ?? '', routeTarget);
      if (route?.kind === 'git-info-refs' || route?.kind === 'git-upload-pack') {
        return runGitHttpBackendFixture(request, response, {
          barePath,
          executablePath: 'git',
          remoteUser: MEMBER_ID,
        }, new URL(routeTarget, 'http://localhost').pathname.slice(`/v5/projects/${projectId}/repository.git`.length));
      }
      response.setHeader('content-type', 'application/json');
      if (route?.kind === 'capabilities') {
        onCapabilities();
        response.end(JSON.stringify(collabCloudCapabilityDocument([
          'cloud-project-create', 'cloud-project-join', 'git-upload-pack', 'project-snapshot', 'project-events',
        ], {
          maxCheckpointCoordinationBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes,
          maxCheckpointManifestUtf8Bytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes,
          maxCheckpointRepositoryBundleBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes,
          maxCheckpointStagingBytes: COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxStagingBytes,
          maxDevelopmentBootstrapGitBundleBytes: 1_024,
          maxDevelopmentBootstrapManifestUtf8Bytes: 1_024,
          maxDevelopmentBootstrapReportUtf8Bytes: 1_024,
          maxEventReplay: 100,
          maxGitReceivePackBytes: 1_024,
          maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
          maxRepositoryBytes: 1_024 * 1_024,
        })));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const envelope = decodeCollabProtocolEnvelope(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (envelope.status !== 'ok') throw envelope.error;
      if (routeTarget === collabCloudProjectOperationRoute(projectId, 'getProjectSnapshot').target) {
        await onSnapshot(projectId);
        if (options.snapshotFailure === 'transport') { request.socket.destroy(); return; }
        if (options.snapshotFailure === 'malformed') { response.end('{"invalid":true}'); return; }
        if (options.snapshotFailure === 'authorization') {
          response.writeHead(403).end(JSON.stringify(collabCloudErrorEnvelope(envelope.value.requestId, new CollabError({ code: 'authorization-denied' }))));
          return;
        }
        if (options.snapshotFailure === 'settled') {
          response.writeHead(403).end(JSON.stringify({
            ...collabCloudErrorEnvelope(envelope.value.requestId, new CollabError({ code: 'authorization-denied' })),
            mutationOutcome: 'rejected',
          }));
          return;
        }
        if (!bound) {
          response.writeHead(404).end(JSON.stringify(collabCloudErrorEnvelope(envelope.value.requestId, new CollabError({ code: 'project-not-found' }))));
          return;
        }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, snapshot)));
        return;
      }
      if (routeTarget === collabCloudProjectOperationRoute(projectId, 'joinCloudProject').target) {
        const decoded = collabControlOperationCodec('joinCloudProject').decodeRequest(envelope.value.data);
        if (decoded.status !== 'ok') throw decoded.error;
        const intent = await foundation.local.projects.loadProjectDocument(projectId, 'pending-operation', decodeCloudProjectEntryRecord);
        assert.equal(intent?.phase, 'intent');
        assert.equal(intent?.operationKind, 'cloud-join-project');
        assert.deepEqual(intent?.request, decoded.value);
        joinRequests.push(decoded.value);
        if (options.joinFailure === 'rejected') {
          response.writeHead(403).end(JSON.stringify(collabCloudErrorEnvelope(envelope.value.requestId, new CollabError({ code: 'authorization-denied' }))));
          return;
        }
        if (options.joinFailure === 'expired' || options.joinFailure === 'revoked' || options.joinFailure === 'wrong-secret') {
          response.writeHead(403).end(JSON.stringify({
            ...collabCloudErrorEnvelope(envelope.value.requestId, new CollabError({ code: 'authorization-denied' })),
            mutationOutcome: 'rejected',
          }));
          return;
        }
        bound = true;
        if (loseNextReply) {
          loseNextReply = false;
          request.socket.destroy();
          return;
        }
        response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
          joinedAt: CREATED_AT, mainOid, managerSetGeneration: 1, memberId: options.joinFailure === 'wrong-member' ? 'member-wrong' : MEMBER_ID,
          membershipRevision: 2, personalRef: `refs/heads/members/${options.joinFailure === 'wrong-member' ? 'member-wrong' : MEMBER_ID}`, projectId, role: 'member',
        })));
        return;
      }
      const decoded = collabControlOperationCodec('createCloudProject').decodeRequest(envelope.value.data);
      if (decoded.status !== 'ok') throw decoded.error;
      if (options.generatedProjectId) {
        projectId = decoded.value.projectId;
        snapshot.project.id = projectId;
      }
      admittedRequests.push(decoded.value);
      await onCreate();
      const intent = await foundation.local.projects.loadProjectDocument(
        projectId, 'pending-operation', decodeCloudProjectEntryRecord,
      );
      assert.deepEqual({
        operationId: intent?.operationId, phase: intent?.phase, projectId: intent?.projectId,
        projectsFolder: intent?.projectsFolder, request: intent?.request,
      }, {
        operationId: decoded.value.idempotencyKey,
        phase: 'intent',
        projectId: projectId,
        projectsFolder: 'Shared/Projects',
        request: {
          idempotencyKey: decoded.value.idempotencyKey,
          managerDisplayName: 'Alice',
          projectId: projectId,
          projectName: options.projectName ?? 'Cloud Notes',
        },
      });
      if (loseNextReply) {
        loseNextReply = false;
        request.socket.destroy();
        return;
      }
      response.end(JSON.stringify(collabCloudSuccessEnvelope(envelope.value.requestId, {
        createdAt: CREATED_AT,
        mainOid,
        managerSetGeneration: 1,
        memberId: MEMBER_ID,
        membershipRevision: 2,
        personalRef: `refs/heads/members/${MEMBER_ID}`,
        projectId: projectId,
        role: 'manager',
      })));
    })().catch(error => {
      failures.push(error);
      response.writeHead(500).end();
    });
  });
  const sockets = new WebSocketServer({ server });
  server.on('upgrade', request => transportRequests.push(`UPGRADE ${request.url}`));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
  const serverUrl = `http://127.0.0.1:${address.port}/operator/cloud`;
  const encodedInvitation = `claudian-cloud:v1:${Buffer.from(JSON.stringify({ serverUrl, invitation: {
    createdAt: CREATED_AT, expiresAt: '2026-09-02T00:00:00.000Z', invitationId: 'invitation-entry',
    issuedState: 'active', projectId, secret: 'A'.repeat(43), secretReplayExpiresAt: '2026-10-01T00:00:00.000Z',
  } })).toString('base64url')}`;
  const adapter = new CloudAuthorityAdapter();
  const createCoordinator = () => new CloudProjectEntryCoordinator(foundation, {
    activateProject: async membership => {
      if (failActivation) { failActivation = false; throw new Error('Injected activation cut'); }
      expect(await foundation.local.projects.loadMembership(projectId)).toEqual(membership);
      expect(await foundation.local.projects.loadProjectDocument(
        projectId, 'publication-state', decodeCollabPublicationStateRecord,
      )).toMatchObject({ baseMainOid: mainOid });
      expect((await foundation.local.projects.loadIndex()).projects)
        .toEqual([expect.objectContaining({ authorityKind: 'cloud', id: projectId })]);
      const session = await sessions.acquire(projectId).ensureAuthoritySession<CollabAuthoritySession>(
        () => adapter.create(membership),
      );
      await session.control.readSnapshot(projectId);
    },
    cloudAuthority: adapter,
    createId: kind => kind === 'project' ? projectId : OPERATION_ID,
    getProjectsFolder: () => projectsFolder,
    now: () => new Date(CREATED_AT),
    vaultRoot,
  });

  return {
    adapter, admittedRequests, joinRequests, encodedInvitation, coordinator: createCoordinator(), createCoordinator, failures, foundation, mainOid, serverUrl, vaultRoot, transportRequests,
    loseNextReply: () => { loseNextReply = true; },
    setProjectsFolder: (folder: string) => { projectsFolder = folder; },
    failNextActivation: () => { failActivation = true; },
    onCapabilities: (callback: () => void) => { onCapabilities = callback; },
    onCreate: (callback: () => void | Promise<void>) => { onCreate = callback; },
    onSnapshot: (callback: (projectId: string) => void | Promise<void>) => { onSnapshot = callback; },
    driftIdentity: (kind: 'member' | 'generation') => {
      if (kind === 'generation') snapshot.project.authorityGeneration = 8;
      else { member.id = 'member-other'; member.personalRef = 'refs/heads/members/member-other'; }
    },
    close: async () => {
      await sessions.close();
      await foundation.close();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
