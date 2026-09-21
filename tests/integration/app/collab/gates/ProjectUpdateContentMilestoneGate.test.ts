import fs, { mkdir, readFile, writeFile } from 'node:fs/promises';
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

jest.setTimeout(90_000);

describe('Project Update content milestone gate', () => {
  const { closeParticipants, createRoot, createFoundation, createFeature } = projectUpdateMilestoneFixture();

  let prepared: Awaited<ReturnType<typeof prepare>>;
  let snapshot: CollabFixtureSnapshot;

  beforeAll(async () => {
    try {
      prepared = await prepare();
    } finally {
      await closeParticipants();
    }
    snapshot = await CollabFixtureSnapshot.capture(prepared.root);
  });

  beforeEach(async () => { await snapshot.restore(); });
  afterAll(async () => { await snapshot?.dispose(); });

  async function prepare() {
    const root = await createRoot('claudian-update-content-');
    const hostRoot = path.join(root, 'host');
    const memberRoot = path.join(root, 'member');
    await Promise.all([mkdir(hostRoot), mkdir(memberRoot)]);
    const codec = new InvitationCodec({ isAddressAllowed: address => address === '127.0.0.1' });
    const hostPort = await availablePort();
    const host = createFoundation(hostRoot, codec, hostPort);
    const member = createFoundation(memberRoot, codec);
    const hostFeature = createFeature(host, hostRoot, TEST_INSTALLATION_A);
    const memberFeature = createFeature(member, memberRoot, TEST_INSTALLATION_B);
    unwrap(await hostFeature.initialize());
    unwrap(await memberFeature.initialize());
    const project = unwrap(await hostFeature.createProject({ memberDisplayName: 'Manager', name: 'Own request' }));
    const projectId = project.id;
    const invitation = unwrap(await hostFeature.createInvitation(projectId));
    const joined = unwrap(await memberFeature.joinProject({ encodedInvitation: invitation.encodedInvitation, memberDisplayName: 'Member' }));
    const memberPath = path.join(memberRoot, joined.workspacePath);
    const hostPath = path.join(hostRoot, project.workspacePath);
    return { root, hostRoot, memberRoot, hostPath, memberPath, codec, hostPort, projectId };
  }

  it.each(['own-merge', 'publish-without-sync', 'later-local-commit', 'other-team-changes', 'resume-empty-review'] as const)('classifies an accepted own request by incoming content: %s', async scenario => {
    const otherTeamChanges = scenario === 'other-team-changes';
    const { hostRoot, memberRoot, hostPath, memberPath, codec, hostPort, projectId } = prepared;
    const host = createFoundation(hostRoot, codec, hostPort);
    let member = createFoundation(memberRoot, codec);
    const hostFeature = createFeature(host, hostRoot, TEST_INSTALLATION_A);
    let memberFeature = createFeature(member, memberRoot, TEST_INSTALLATION_B);
    unwrap(await hostFeature.initialize());
    unwrap(await hostFeature.startHost(projectId));
    unwrap(await memberFeature.initialize());
    await writeFile(path.join(memberPath, 'published.md'), 'my submitted change\n');
    const request = (await publishFully(memberFeature, projectId)).request!;
    const git = await member.requireGitFoundation();
    if (scenario === 'later-local-commit') {
      await writeFile(path.join(memberPath, 'local-commit.md'), 'unpublished commit\n');
      const membership = await member.local.projects.loadMembership(projectId);
      if (!membership) throw new Error('Membership required');
      await git.repositories.stageAll(memberPath);
      await git.repositories.createCommitFromIndex(memberPath, {
        expectedRefOid: request.latestHeadOid, message: 'Continue local work',
        parents: [request.latestHeadOid], ref: membership.member.personalRef,
      });
    }
    await writeFile(path.join(memberPath, 'draft.md'), 'staged draft\n');
    await git.repositories.stageAll(memberPath);
    await writeFile(path.join(memberPath, 'draft.md'), 'staged draft\nmore local work\n');
    const headBefore = await git.repositories.resolveRef(memberPath, 'HEAD');
    const indexBefore = await git.runner.run({ args: ['diff', '--cached', '--binary'], cwd: memberPath });
    if (otherTeamChanges) {
      await writeFile(path.join(hostPath, 'team.md'), 'another member change\n');
      await accept(hostFeature, projectId, (await publishFully(hostFeature, projectId)).request!.id);
    }
    await accept(hostFeature, projectId, request.id);
    await waitFor(async () => {
      const inspected = unwrap(await memberFeature.inspectProject(projectId));
      return inspected.projectUpdate?.incoming !== 'unknown'
        && inspected.coordination?.snapshot.openRequests.length === 0;
    });
    const inspected = unwrap(await memberFeature.inspectProject(projectId));
    expect(inspected.projectUpdate).toMatchObject({
      incoming: otherTeamChanges ? 'available' : 'included',
      action: { kind: otherTeamChanges ? 'update' : 'none', enabled: otherTeamChanges },
    });
    expect(inspected.personalChanges!.updateAvailable).toBe(otherTeamChanges);
    expect(await git.repositories.resolveRef(memberPath, 'HEAD')).toBe(headBefore);
    expect((await git.runner.run({ args: ['diff', '--cached', '--binary'], cwd: memberPath })).stdout).toEqual(indexBefore.stdout);
    expect(await readFile(path.join(memberPath, 'draft.md'), 'utf8')).toBe('staged draft\nmore local work\n');
    let publicationWithoutSync: {
      newRequest: boolean; incoming: string | undefined; operation: string | undefined;
      files: string[]; draft: string;
    } | undefined;
    if (scenario === 'publish-without-sync') {
      const published = await publishFully(memberFeature, projectId);
      const after = unwrap(await memberFeature.inspectProject(projectId));
      const newReview = unwrap(await memberFeature.prepareReview(projectId, published.request!.id));
      publicationWithoutSync = {
        newRequest: !!published.request && published.request.id !== request.id,
        incoming: after.projectUpdate?.incoming, operation: after.projectUpdate?.operation.kind,
        files: newReview.files.map(file => file.path),
        draft: await readFile(path.join(memberPath, 'draft.md'), 'utf8'),
      };
    }
    expect(publicationWithoutSync).toEqual(scenario === 'publish-without-sync' ? {
      newRequest: true, incoming: 'current', operation: 'none', files: ['draft.md'],
      draft: 'staged draft\nmore local work\n',
    } : undefined);
    if (scenario === 'publish-without-sync') return;
    const remoteBefore = inspected.gitStatus!.personalRemoteOid;
    let interruption: { status: string; injected: boolean; resumedState: string | undefined } | undefined;
    if (scenario === 'resume-empty-review') {
      let interrupted = false;
      const realRename = fs.rename;
      const fault = jest.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
        if (!interrupted && String(target).startsWith(memberRoot) && path.basename(String(target)) === 'publication-state.json') {
          const record = JSON.parse(await readFile(source, 'utf8'));
          if (record.operation?.intent === 'update' && record.operation.phase === 'confirmed') {
            interrupted = true;
            throw Object.assign(new Error('Status sync interrupted'), { code: 'EIO' });
          }
        }
        return realRename(source, target);
      });
      let interruptedStatus: string;
      try { interruptedStatus = (await memberFeature.updateProject(projectId)).status; }
      finally { fault.mockRestore(); }
      await memberFeature.close();
      await member.close();
      member = createFoundation(memberRoot, codec);
      memberFeature = createFeature(member, memberRoot, TEST_INSTALLATION_B);
      unwrap(await memberFeature.initialize());
      await waitFor(async () => unwrap(await memberFeature.inspectProject(projectId)).projectUpdate?.incoming !== 'unknown');
      interruption = { status: interruptedStatus, injected: interrupted,
        resumedState: unwrap(await memberFeature.inspectProject(projectId)).projectUpdate?.operation.kind };
    }
    expect(interruption).toEqual(scenario === 'resume-empty-review'
      ? { status: 'recovery-required', injected: true, resumedState: 'update-recovery' } : undefined);
    const result = unwrap(await memberFeature.updateProject(projectId));
    expect(result.state).toBe(otherTeamChanges ? 'review-required' : 'updated');
    expect(result.review?.files.map(file => file.path)).toEqual(otherTeamChanges ? ['team.md'] : undefined);
    if (otherTeamChanges) {
      unwrap(await memberFeature.confirmUpdate({ projectId, operationId: result.review!.operationId,
        expectedMainOid: result.review!.currentMainOid, expectedCandidateOid: result.review!.candidateOid }));
    }
    const after = unwrap(await memberFeature.inspectProject(projectId));
    expect(after.projectUpdate).toMatchObject({ incoming: 'current', operation: { kind: 'none' } });
    expect(after.personalChanges!.unpublishedReview.files.map(file => file.path).sort()).toEqual(
      scenario === 'later-local-commit' ? ['draft.md', 'local-commit.md'] : ['draft.md']);
    expect(after.gitStatus!.personalRemoteOid).toBe(remoteBefore);
    expect(after.coordination!.snapshot.openRequests).toEqual([]);
    expect(await readFile(path.join(memberPath, 'draft.md'), 'utf8')).toBe('staged draft\nmore local work\n');
  });
});
