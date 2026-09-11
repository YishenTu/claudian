import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import type { CollabFeatureService } from '@/app/collab/CollabFeatureService';
import { createCollabFeatureSubcomposition } from '@/app/collab/CollabFeatureSubcomposition';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { publicationCandidateRef } from '@/app/collab/publish/NativeGitPublicationCandidateRepository';
import type { CollabResult } from '@/core/collab';

jest.setTimeout(90_000);

describe('Project Update milestone gate', () => {
  let SQL: SqlJsStatic;
  let root = '';
  const foundations: ClaudianCollabService[] = [];
  const features: CollabFeatureService[] = [];

  beforeAll(async () => { SQL = await initSqlJs(); });
  afterEach(async () => {
    await Promise.all(features.splice(0).map(feature => feature.close()));
    await Promise.all(foundations.splice(0).map(foundation => foundation.close()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(['unpublished', 'open-request', 'unchanged-request', 'conflict', 'conflict-cleanup-edit', 'conflict-cleanup-commit', 'cleanup-restart', 'state-save-restart', 'state-save-new-main', 'state-save-later-commit'] as const)(
    'updates %s work locally across restart without publishing it',
    async scenario => {
      root = await mkdtemp(path.join(tmpdir(), 'claudian-project-update-'));
      const hostRoot = path.join(root, 'host');
      const memberRoot = path.join(root, 'member');
      await Promise.all([mkdir(hostRoot), mkdir(memberRoot)]);
      const codec = new InvitationCodec({ isAddressAllowed: address => address === '127.0.0.1' });
      const host = createFoundation(hostRoot, codec, await availablePort());
      let member = createFoundation(memberRoot, codec);
      const hostFeature = createFeature(host, hostRoot, TEST_INSTALLATION_A);
      let memberFeature = createFeature(member, memberRoot, TEST_INSTALLATION_B);
      unwrap(await hostFeature.initialize());
      unwrap(await memberFeature.initialize());
      const project = unwrap(await hostFeature.createProject({ memberDisplayName: 'Manager', name: 'Project Update' }));
      const projectId = project.id;
      unwrap(await hostFeature.startHost(projectId));
      const invitation = unwrap(await hostFeature.createInvitation(projectId));
      const joined = unwrap(await memberFeature.joinProject({ encodedInvitation: invitation.encodedInvitation, memberDisplayName: 'Member' }));
      const hostPath = path.join(hostRoot, project.workspacePath);
      const memberPath = path.join(memberRoot, joined.workspacePath);
      await writeFile(path.join(hostPath, 'shared.md'), 'base\n');
      await accept(hostFeature, projectId, (await publishFully(hostFeature, projectId)).request!.id);
      await waitFor(async () => {
        unwrap(await memberFeature.inspectProject(projectId));
        return await readFile(path.join(memberPath, 'shared.md'), 'utf8').catch(() => null) === 'base\n';
      });

      const hasRequest = scenario === 'open-request' || scenario === 'unchanged-request';
      let requestHead: string | undefined;
      if (hasRequest) {
        await writeFile(path.join(memberPath, 'published.md'), 'already published\n');
        requestHead = (await publishFully(memberFeature, projectId)).request!.latestHeadOid;
      }
      if (requestHead) await waitFor(async () => {
        const inspection = unwrap(await memberFeature.inspectProject(projectId));
        return inspection.coordination?.snapshot.openRequests.some(request => request.latestHeadOid === requestHead) === true;
      });
      const before = unwrap(await memberFeature.inspectProject(projectId));
      const personalRemoteOid = before.gitStatus!.personalRemoteOid;
      const previousRequests = before.coordination!.snapshot.openRequests;
      if (scenario !== 'unchanged-request') {
        await writeFile(path.join(memberPath, 'draft.md'), 'unfinished work\n');
      }
      const hasConflict = scenario === 'conflict' || scenario === 'conflict-cleanup-edit' || scenario === 'conflict-cleanup-commit';
      const conflictCleanupFailure = scenario === 'conflict-cleanup-edit' || scenario === 'conflict-cleanup-commit';
      if (hasConflict) await writeFile(path.join(memberPath, 'shared.md'), 'personal\n');
      await writeFile(path.join(hostPath, 'team.md'), 'accepted team update\n');
      if (hasConflict) await writeFile(path.join(hostPath, 'shared.md'), 'accepted\n');
      await accept(hostFeature, projectId, (await publishFully(hostFeature, projectId)).request!.id);

      let result = await memberFeature.updateProject(projectId);
      expect(result.status).toBe(hasConflict ? 'conflict' : 'success');
      let conflictObservation: unknown = null;
      let conflictCleanupStatus: string | null = null;
      let conflictCleanupInjected = false;
      if (hasConflict) {
        const conflicted = unwrap(await memberFeature.inspectProject(projectId));
        const opposite = await memberFeature.publish({ projectId, description: 'Do not change the pending Update' });
        const afterOpposite = unwrap(await memberFeature.inspectProject(projectId));
        conflictObservation = { state: conflicted.projectUpdate?.state, intent: conflicted.conflict?.intent, oppositeStatus: opposite.status, retainedIntent: afterOpposite.conflict?.intent };
        await writeFile(path.join(memberPath, 'shared.md'), 'resolved locally\n');
        if (conflictCleanupFailure && result.status === 'conflict') {
          const operationPath = path.join(memberRoot, member.local.projects.getConflictDirectoryPath(), result.conflict.operationId);
          const realRm = fs.rm;
          const fault = jest.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
            if (!conflictCleanupInjected && String(target) === operationPath) {
              conflictCleanupInjected = true;
              throw Object.assign(new Error('Conflict cleanup interrupted'), { code: 'EBUSY' });
            }
            return realRm(target, options);
          });
          try { conflictCleanupStatus = (await memberFeature.updateProject(projectId)).status; }
          finally { fault.mockRestore(); }
          await writeFile(path.join(memberPath, 'later.md'), 'editing after applied update\n');
          if (scenario === 'conflict-cleanup-commit') {
            const git = await member.requireGitFoundation();
            const membership = await member.local.projects.loadMembership(projectId);
            if (!membership) throw new Error('Membership required');
            const head = await git.repositories.resolveRef(memberPath, membership.member.personalRef);
            if (!head) throw new Error('Head required');
            await git.repositories.stageAll(memberPath);
            await git.repositories.createCommitFromIndex(memberPath, { expectedRefOid: head, message: 'Continue local work', parents: [head], ref: membership.member.personalRef });
          }
          await memberFeature.close();
          await member.close();
          member = createFoundation(memberRoot, codec);
          memberFeature = createFeature(member, memberRoot, TEST_INSTALLATION_B);
          unwrap(await memberFeature.initialize());
        }
        result = await memberFeature.updateProject(projectId);
      }
      expect(conflictObservation).toEqual(hasConflict ? { state: 'conflict', intent: 'update', oppositeStatus: 'stale', retainedIntent: 'update' } : null);
      expect(conflictCleanupStatus).toBe(conflictCleanupFailure ? 'recovery-required' : null);
      expect(conflictCleanupInjected).toBe(conflictCleanupFailure);
      const prepared = unwrap(result);
      expect(prepared.state).toBe('review-required');
      expect(prepared.review).toMatchObject({ intent: 'update' });
      await expect(readFile(path.join(memberPath, 'team.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await memberFeature.close();
      await member.close();
      member = createFoundation(memberRoot, codec);
      memberFeature = createFeature(member, memberRoot, TEST_INSTALLATION_B);
      unwrap(await memberFeature.initialize());
      const resumed = unwrap(await memberFeature.updateProject(projectId));
      expect(resumed.review).toMatchObject({ candidateOid: prepared.review!.candidateOid, intent: 'update' });
      const review = resumed.review!;
      const stateSaveFailure = scenario === 'state-save-restart' || scenario === 'state-save-new-main' || scenario === 'state-save-later-commit';
      const interruptedUpdate = scenario === 'cleanup-restart' || stateSaveFailure;
      let saveFailed = false;
      const realRename = fs.rename;
      const stateFault = stateSaveFailure ? jest.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
        if (!saveFailed && String(target).startsWith(memberRoot) && String(target).endsWith('/publication-state.json')) {
          const record = JSON.parse(await readFile(source, 'utf8'));
          if (record.operation?.intent === 'update' && record.operation.phase === 'applied') {
            saveFailed = true;
            throw Object.assign(new Error('Applied state save interrupted'), { code: 'EIO' });
          }
        }
        return realRename(source, target);
      }) : null;
      const candidateLock = path.join(memberPath, '.git', `${publicationCandidateRef(review.operationId)}.lock`);
      if (scenario === 'cleanup-restart') await writeFile(candidateLock, 'held by another Git operation');
      let confirmation;
      try {
        confirmation = await memberFeature.confirmUpdate({
        expectedCandidateOid: review.candidateOid,
        expectedMainOid: review.currentMainOid,
        operationId: review.operationId,
        projectId,
      });
      } finally { stateFault?.mockRestore(); }
      expect(saveFailed).toBe(stateSaveFailure);
      expect(confirmation.status).toBe(interruptedUpdate ? 'recovery-required' : 'success');
      await expect(readFile(path.join(memberPath, 'team.md'), 'utf8')).resolves.toBe('accepted team update\n');
      if (scenario === 'cleanup-restart') await rm(candidateLock);
      let pendingFiles: readonly string[] | null = null;
      if (interruptedUpdate) {
        await writeFile(path.join(memberPath, 'later.md'), 'editing after applied update\n');
        if (scenario === 'state-save-later-commit') {
          const git = await member.requireGitFoundation();
          const membership = await member.local.projects.loadMembership(projectId);
          if (!membership) throw new Error('Membership required');
          await git.repositories.stageAll(memberPath);
          await git.repositories.createCommitFromIndex(memberPath, { expectedRefOid: review.candidateOid, message: 'Continue local work', parents: [review.candidateOid], ref: membership.member.personalRef });
        }
        await memberFeature.close();
        await member.close();
        if (scenario === 'state-save-new-main') {
          await writeFile(path.join(hostPath, 'newer-team.md'), 'newer accepted update\n');
          await accept(hostFeature, projectId, (await publishFully(hostFeature, projectId)).request!.id);
        }
        member = createFoundation(memberRoot, codec);
        memberFeature = createFeature(member, memberRoot, TEST_INSTALLATION_B);
        unwrap(await memberFeature.initialize());
        pendingFiles = unwrap(await memberFeature.inspectProject(projectId)).personalChanges!.unpublishedReview.files.map(file => file.path).sort();
        confirmation = await memberFeature.updateProject(projectId);
      }
      await expect(readFile(path.join(memberPath, 'later.md'), 'utf8').catch(() => null)).resolves.toBe(interruptedUpdate || conflictCleanupFailure ? 'editing after applied update\n' : null);
      expect(pendingFiles).toEqual(interruptedUpdate ? ['draft.md', 'later.md'] : null);
      const updated = unwrap(confirmation);
      expect(updated.state).toBe('updated');
      const after = unwrap(await memberFeature.inspectProject(projectId));
      expect(after.coordination!.snapshot.openRequests).toEqual(previousRequests);
      expect(after.gitStatus!.personalRemoteOid).toBe(personalRemoteOid);
      expect(after.projectUpdate).toMatchObject({ state: scenario === 'state-save-new-main' ? 'available' : 'current' });
      await expect(readFile(path.join(memberPath, 'team.md'), 'utf8')).resolves.toBe('accepted team update\n');
      const expectedPaths = scenario === 'unchanged-request' ? [] : conflictCleanupFailure ? ['draft.md', 'later.md', 'shared.md'] : hasConflict ? ['draft.md', 'shared.md'] : interruptedUpdate ? ['draft.md', 'later.md'] : ['draft.md'];
      expect(after.personalChanges!.unpublishedReview.files.map(file => file.path).sort()).toEqual(expectedPaths);
      await expect(readFile(path.join(memberPath, 'draft.md'), 'utf8').catch(() => null))
        .resolves.toBe(scenario === 'unchanged-request' ? null : 'unfinished work\n');
      expect(after.coordination!.snapshot.openRequests[0]?.latestHeadOid).toBe(requestHead);
      const nextUpdate = unwrap(await memberFeature.updateProject(projectId));
      expect(nextUpdate.state).toBe(scenario === 'state-save-new-main' ? 'review-required' : 'already-current');
      if (nextUpdate.review) unwrap(await memberFeature.confirmUpdate({ projectId, operationId: nextUpdate.review.operationId, expectedMainOid: nextUpdate.review.currentMainOid, expectedCandidateOid: nextUpdate.review.candidateOid }));
      const published = scenario === 'unchanged-request' ? null : await publishFully(memberFeature, projectId);
      expect(published?.state ?? null).toBe(scenario === 'unchanged-request' ? null : 'request-synchronized');
      expect(hasRequest && published ? published.request!.id : null).toBe(scenario === 'open-request' ? previousRequests[0].id : null);
      await waitFor(async () => unwrap(await memberFeature.inspectProject(projectId)).personalChanges!.unpublishedReview.files.length === 0);
    },
  );

  function createFoundation(vaultRoot: string, invitationCodec: InvitationCodec, hostPort?: number): ClaudianCollabService {
    const installationKey = hostPort === undefined ? TEST_INSTALLATION_B : TEST_INSTALLATION_A;
    const foundation = new ClaudianCollabService({
      installationKey,
      ...(hostPort === undefined ? {} : {
        createAuthorityDatabase: (directory: string, resourceAdmission?: <T>(operation: () => Promise<T>) => Promise<T>) => (
          new SqlJsProjectDatabase(directory, { resourceAdmission, loadSqlJs: async () => SQL })
        ),
        lanHost: { createInvitationCodec: () => invitationCodec, getPrivateIpv4Addresses: () => ['127.0.0.1'], portCandidates: [hostPort] },
      }),
      getConfiguredGitPath: () => '', invitationCodec, obsidianConfigDirectory: '.obsidian', vaultRoot,
    });
    foundations.push(foundation);
    return foundation;
  }

  function createFeature(foundation: ClaudianCollabService, vaultRoot: string, installationKey: typeof TEST_INSTALLATION_A): CollabFeatureService {
    const feature = createCollabFeatureSubcomposition({
      foundation, projectSetup: new CollabProjectSetupService(foundation, { installationKey, vaultRoot }), vaultRoot,
    }).feature;
    features.push(feature);
    return feature;
  }
});

function unwrap<T>(result: CollabResult<T>): T {
  if (result.status !== 'success') throw new Error(`Operation failed: ${JSON.stringify(result)}`);
  return result.value;
}

async function publishFully(feature: CollabFeatureService, projectId: string) {
  const description = 'Review this contribution';
  const published = unwrap(await feature.publish({ description, projectId }));
  if (published.state !== 'review-required' || !published.review) return published;
  return unwrap(await feature.confirmPublish({
    description, projectId, operationId: published.review.operationId,
    expectedMainOid: published.review.currentMainOid, expectedCandidateOid: published.review.candidateOid,
  }));
}

async function accept(feature: CollabFeatureService, projectId: string, requestId: string): Promise<void> {
  const review = unwrap(await feature.prepareReview(projectId, requestId));
  unwrap(await feature.acceptRequest({
    projectId, requestId, expectedHeadOid: review.detail.reviewedHeadOid, expectedMainOid: review.detail.currentMainOid,
    expectedRequestRevision: review.detail.request.revision, expectedResolvingTickets: [],
  }));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for update');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
