import fs, { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CollabFixtureSnapshot } from '@test/helpers/collab/CollabFixtureSnapshot';
import {
  accept,
  availablePort,
  projectUpdateMilestoneFixture,
  publishFully,
  unwrap,
  waitFor,
} from '@test/helpers/collab/ProjectUpdateMilestoneFixture';
import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';

import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { publicationCandidateRef } from '@/app/collab/publish/NativeGitPublicationCandidateRepository';

jest.setTimeout(90_000);

describe('Project Update recovery milestone gate', () => {
  const { closeParticipants, createRoot, createFoundation, createFeature } = projectUpdateMilestoneFixture();
  const codec = new InvitationCodec({ isAddressAllowed: address => address === '127.0.0.1' });
  let root: string;
  let snapshot: CollabFixtureSnapshot;
  let hostRoot: string;
  let memberRoot: string;
  let hostPath: string;
  let memberPath: string;
  let projectId: string;
  let hostPort: number;

  beforeAll(async () => {
    root = await createRoot('claudian-project-update-');
    hostRoot = path.join(root, 'host');
    memberRoot = path.join(root, 'member');
    await Promise.all([mkdir(hostRoot), mkdir(memberRoot)]);
    hostPort = await availablePort();
    const host = createFoundation(hostRoot, codec, hostPort);
    const member = createFoundation(memberRoot, codec);
    const hostFeature = createFeature(host, hostRoot, TEST_INSTALLATION_A);
    const memberFeature = createFeature(member, memberRoot, TEST_INSTALLATION_B);
    try {
      unwrap(await hostFeature.initialize());
      unwrap(await memberFeature.initialize());
      const project = unwrap(await hostFeature.createProject({ memberDisplayName: 'Manager', name: 'Project Update' }));
      projectId = project.id;
      unwrap(await hostFeature.startHost(projectId));
      const invitation = unwrap(await hostFeature.createInvitation(projectId));
      const joined = unwrap(await memberFeature.joinProject({ encodedInvitation: invitation.encodedInvitation, memberDisplayName: 'Member' }));
      hostPath = path.join(hostRoot, project.workspacePath);
      memberPath = path.join(memberRoot, joined.workspacePath);
      await writeFile(path.join(hostPath, 'shared.md'), 'base\n');
      await accept(hostFeature, projectId, (await publishFully(hostFeature, projectId)).request!.id);
      await waitFor(async () => {
        unwrap(await memberFeature.inspectProject(projectId));
        return await readFile(path.join(memberPath, 'shared.md'), 'utf8').catch(() => null) === 'base\n';
      });
    } finally {
      await closeParticipants();
    }
    // Capture only settled files. Each scenario restores a fresh mutable copy at
    // the original paths, preserving installation identity and captured origins.
    snapshot = await CollabFixtureSnapshot.capture(root);
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await snapshot.restore();
  });

  afterAll(async () => {
    await snapshot?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(['unpublished', 'open-request', 'unchanged-request', 'conflict', 'conflict-cleanup-edit', 'conflict-cleanup-commit', 'cleanup-restart', 'state-save-restart', 'state-save-new-main', 'state-save-later-commit'] as const)(
    'updates %s work locally across restart without publishing it',
    async scenario => {
      const host = createFoundation(hostRoot, codec, hostPort);
      let member = createFoundation(memberRoot, codec);
      const hostFeature = createFeature(host, hostRoot, TEST_INSTALLATION_A);
      let memberFeature = createFeature(member, memberRoot, TEST_INSTALLATION_B);
      unwrap(await hostFeature.initialize());
      unwrap(await hostFeature.startHost(projectId));
      unwrap(await memberFeature.initialize());

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
        conflictObservation = { state: conflicted.projectUpdate?.operation.kind, intent: conflicted.conflict?.intent, oppositeStatus: opposite.status, retainedIntent: afterOpposite.conflict?.intent };
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
      expect(conflictObservation).toEqual(hasConflict ? { state: 'update-conflict', intent: 'update', oppositeStatus: 'stale', retainedIntent: 'update' } : null);
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
        if (!saveFailed && String(target).startsWith(memberRoot) && path.basename(String(target)) === 'publication-state.json') {
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
      expect(after.projectUpdate).toMatchObject({ incoming: scenario === 'state-save-new-main' ? 'available' : 'current' });
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
});
