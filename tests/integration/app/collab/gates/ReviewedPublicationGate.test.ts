import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CollabFixtureSnapshot } from '@test/helpers/collab/CollabFixtureSnapshot';
import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { SQLJSProjectDatabase } from '@/app/collab/authority/SQLJSProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import type { CollabFeatureService } from '@/app/collab/CollabFeatureService';
import { createCollabFeatureSubcomposition } from '@/app/collab/CollabFeatureSubcomposition';
import { type GitCommandRequest,GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { decodeCollabPublicationStateRecord } from '@/app/collab/publish/CollabPublicationStateRecord';
import type { CollabResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

jest.setTimeout(90_000);

describe('Reviewed publication boundary', () => {
  let SQL: SqlJsStatic;
  let root = '';
  let snapshot: CollabFixtureSnapshot;
  let projectBaseline: Awaited<ReturnType<CollabFeatureService['createProject']>> & { status: 'success' };
  const foundations: ClaudianCollabService[] = [];
  const features: CollabFeatureService[] = [];

  beforeAll(async () => {
    SQL = await initSqlJs();
    root = await mkdtemp(path.join(tmpdir(), 'claudian-reviewed-publish-'));
    const hostRoot = path.join(root, 'host');
    await mkdir(hostRoot);
    const codec = new InvitationCodec({ isAddressAllowed: address => address === '127.0.0.1' });
    const host = createFoundation(hostRoot, codec, await availablePort());
    const feature = createFeature(host, hostRoot, TEST_INSTALLATION_A);
    try {
      unwrap(await feature.initialize());
      const created = await feature.createProject({ memberDisplayName: 'Manager', name: 'Reviewed Publish' });
      if (created.status !== 'success') throw new Error('Fixture Project creation failed');
      projectBaseline = created;
    } finally {
      await closeParticipants();
    }
    snapshot = await CollabFixtureSnapshot.capture(root);
  });
  afterAll(async () => {
    await closeParticipants();
    await snapshot?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function closeParticipants() {
    await Promise.all(features.splice(0).map(feature => feature.close()));
    await Promise.all(foundations.splice(0).map(foundation => foundation.close()));
  }
  afterEach(async () => {
    jest.restoreAllMocks();
    await closeParticipants();
  });

  async function setup() {
    await snapshot.restore();
    const hostRoot = path.join(root, 'host');
    const codec = new InvitationCodec({ isAddressAllowed: address => address === '127.0.0.1' });
    const host = createFoundation(hostRoot, codec, await availablePort());
    const feature = createFeature(host, hostRoot, TEST_INSTALLATION_A);
    unwrap(await feature.initialize());
    const { value: project } = projectBaseline;
    unwrap(await feature.startHost(project.id));
    // Establish fetched refs before edits; background synchronization may not have run yet.
    unwrap(await feature.updateProject(project.id));
    const repo = path.join(hostRoot, project.workspacePath);
    await writeFile(path.join(repo, 'reviewed.md'), 'reviewed content\n');
    const before = unwrap(await feature.inspectProject(project.id));
    expect(before.gitStatus!.personalRemoteOid).toBe(before.gitStatus!.headOid);
    const preview = before.personalChanges!.unpublishedReview;
    const input = {
      projectId: project.id, description: 'Publish reviewed change',
      expectedWorkingTree: { baseOid: preview.baseOid, headOid: preview.headOid, snapshotId: preview.snapshotId },
    };
    return { hostRoot, codec, host, feature, project, repo, before, input };
  }

  it('publishes an unchanged reviewed working tree without a second confirmation', async () => {
    const { feature, project, input } = await setup();
    const published = unwrap(await feature.publish(input));
    expect(published.state).toBe('request-synchronized');
    const request = unwrap(await feature.prepareReview(project.id, published.request!.id));
    expect(request.files.map(file => file.path)).toEqual(['reviewed.md']);
  });

  it.each(['new-file', 'changed-content'] as const)('rejects a stale preview before capture: %s', async scenario => {
    const { feature, project, repo, before, input } = await setup();
    await writeFile(path.join(repo, scenario === 'new-file' ? 'later.md' : 'reviewed.md'), 'unreviewed text!\n');
    const result = await feature.publish(input);
    expect(result).toMatchObject({ status: 'stale', staleKind: 'working-copy' });
    const after = unwrap(await feature.inspectProject(project.id));
    expect(after.gitStatus!.headOid).toBe(before.gitStatus!.headOid);
    expect(after.gitStatus!.personalRemoteOid).toBe(before.gitStatus!.personalRemoteOid);
    expect(after.coordination!.snapshot.openRequests).toEqual([]);
    expect(after.gitStatus!.workingTreeClean).toBe(false);
  });

  it.each(['new-file', 'changed-content', 'restart'] as const)('requires immutable review of edits made during capture: %s', async scenario => {
    const fixture = await setup();
    const { project, repo, before, input } = fixture;
    let { feature, host } = fixture;
    const run = GitCommandRunner.prototype.run;
    let injected = false;
    const commands = jest.spyOn(GitCommandRunner.prototype, 'run').mockImplementation(async function (this: GitCommandRunner, command: GitCommandRequest) {
      if (command.cwd === repo && command.args[0] === 'add' && !injected) {
        injected = true;
        await writeFile(path.join(repo, scenario === 'changed-content' ? 'reviewed.md' : 'later.md'), 'unreviewed text!\n');
      }
      if (injected && scenario === 'restart' && command.args[0] === 'ls-tree') {
        const state = await host.local.projects.loadProjectDocument(project.id, 'publication-state', decodeCollabPublicationStateRecord);
        if (state?.operation?.phase === 'captured' && state.operation.requiresReview) throw new CollabError({ code: 'operation-failed' });
      }
      return run.call(this, command);
    });
    let result = await feature.publish(input);
    commands.mockRestore();
    expect(injected).toBe(true);
    expect(result.status).toBe(scenario === 'restart' ? 'recovery-required' : 'success');
    if (scenario === 'restart') {
      await feature.close();
      await host.close();
      host = createFoundation(fixture.hostRoot, fixture.codec, await availablePort());
      feature = createFeature(host, fixture.hostRoot, TEST_INSTALLATION_A);
      unwrap(await feature.initialize());
      unwrap(await feature.startHost(project.id));
      result = await feature.publish({ projectId: project.id, description: input.description });
    }
    const prepared = unwrap(result);
    expect(prepared.state).toBe('review-required');
    expect(prepared.review).toBeDefined();
    const pending = unwrap(await feature.inspectProject(project.id));
    expect(pending.projectUpdate).toMatchObject({
      freshness: 'fresh', operation: { kind: 'publish' }, action: { kind: 'complete-publish', enabled: true },
    });
    expect(pending.gitStatus!.personalRemoteOid).toBe(before.gitStatus!.personalRemoteOid);
    expect(pending.coordination!.snapshot.openRequests).toEqual([]);
    const review = prepared.review!;
    const published = unwrap(await feature.confirmPublish({
      projectId: project.id, description: input.description, operationId: review.operationId,
      expectedMainOid: review.currentMainOid, expectedCandidateOid: review.candidateOid,
    }));
    expect(published.state).toBe('request-synchronized');
  });

  function createFoundation(vaultRoot: string, invitationCodec: InvitationCodec, hostPort?: number): ClaudianCollabService {
    const installationKey = hostPort === undefined ? TEST_INSTALLATION_B : TEST_INSTALLATION_A;
    const foundation = new ClaudianCollabService({
      installationKey,
      ...(hostPort === undefined ? {} : {
        createAuthorityDatabase: (directory: string, resourceAdmission?: <T>(operation: () => Promise<T>) => Promise<T>) => (
          new SQLJSProjectDatabase(directory, { resourceAdmission, loadSqlJs: async () => SQL })
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

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
