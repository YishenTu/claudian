import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  completeCollabPublicationOptions,
} from '@test/helpers/collab/CollabFeatureTestHarness';
import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { CollabPublicationService } from '@/app/collab/publish/CollabPublicationService';

jest.setTimeout(90_000);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  return address.port;
}

describe('M4 resumable publication gate', () => {
  let SQL: SqlJsStatic;
  let host: ClaudianCollabService;
  let member: ClaudianCollabService;
  const publications: CollabPublicationService[] = [];
  let root: string;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  afterEach(async () => {
    await Promise.all(publications.splice(0).map(publication => publication.close()));
    await member?.close();
    await host?.close();
    await rm(root, { force: true, recursive: true });
  });

  it.each(['unchanged', 'later edits', 'later commit'] as const)(
    'resumes offline publication with %s after reconstruction and ensures one request',
    async laterWork => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-m4-gate-'));
    const hostRoot = path.join(root, 'host-vault');
    const memberRoot = path.join(root, 'member-vault');
    await Promise.all([mkdir(hostRoot), mkdir(memberRoot)]);
    const invitationCodec = new InvitationCodec({
      isAddressAllowed: address => address === '127.0.0.1',
    });
    const hostPort = await availablePort();
    host = new ClaudianCollabService({
      installationKey: TEST_INSTALLATION_A,
      createAuthorityDatabase: (authorityDirectory, resourceAdmission) => new SqlJsProjectDatabase(
        authorityDirectory,
        { resourceAdmission, loadSqlJs: async () => SQL },
      ),
      getConfiguredGitPath: () => '',
      lanHost: {
        createInvitationCodec: () => invitationCodec,
        getPrivateIpv4Addresses: () => ['127.0.0.1'],
        portCandidates: [hostPort],
      },
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: hostRoot,
    });
    member = new ClaudianCollabService({
      installationKey: TEST_INSTALLATION_B,
      getConfiguredGitPath: () => '',
      invitationCodec,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: memberRoot,
    });

    const setup = new CollabProjectSetupService(host, { installationKey: TEST_INSTALLATION_A, vaultRoot: hostRoot });
    const created = await setup.createProject({
      memberDisplayName: 'Host',
      name: 'Alpha',
    });
    if (created.status !== 'success') throw new Error('Project setup failed');
    const projectId = created.value.id;
    await host.lanHost.startProject(projectId);
    const invitation = await host.lanHost.createInvitation(projectId);
    const joined = await member.join.joinProject({
      encodedInvitation: invitation.encodedInvitation,
      memberDisplayName: 'Member',
    });
    if (joined.status !== 'success') throw new Error('Project Join failed');
    const membership = await member.local.projects.loadMembership(projectId);
    if (!membership) throw new Error('Member membership missing');
    const workingCopy = path.join(memberRoot, joined.value.workspacePath);
    const memberGit = await member.requireGitFoundation();
    const initialOid = await memberGit.repositories.resolveRef(
      workingCopy,
      membership.member.personalRef,
    );
    if (!initialOid) throw new Error('Initial personal ref missing');

    await host.lanHost.stopProject(projectId);
    await writeFile(path.join(workingCopy, 'offline-note.md'), 'offline change\n');
    const publicationOptions = completeCollabPublicationOptions({
      discovery: member.discovery,
      reconnect: member.reconnect,
      vaultRoot: memberRoot,
    });
    const offline = new CollabPublicationService(member, publicationOptions);
    publications.push(offline);
    await expect(offline.readGitStatus(projectId)).resolves.toMatchObject({
      changedFiles: [{
        binary: false,
        kind: 'added',
        largeForReview: false,
        path: 'offline-note.md',
      }],
      workingTreeClean: false,
    });
    const publishRequest = { description: 'Offline note', projectId };
    const committed = await offline.publish(publishRequest);
    if (committed.status !== 'success') {
      throw new Error(`Offline Publish failed: ${JSON.stringify(committed)}`);
    }
    expect(committed).toMatchObject({
      status: 'success',
      value: { state: 'committed-locally' },
    });
    await expect(offline.readPublishDescription(projectId)).resolves.toBe('Offline note');
    const capturedOid = committed.value.localHeadOid;
    expect(capturedOid).not.toBe(initialOid);

    if (laterWork !== 'unchanged') {
      await writeFile(path.join(workingCopy, 'offline-note.md'), 'offline change\ncontinued work\n');
      await writeFile(path.join(workingCopy, 'later-note.md'), 'another unpublished note\n');
      if (laterWork === 'later commit') {
        await memberGit.repositories.stageAll(workingCopy);
        await memberGit.repositories.createCommitFromIndex(workingCopy, {
          expectedRefOid: capturedOid,
          message: 'Continue offline work',
          parents: [capturedOid],
          ref: membership.member.personalRef,
        });
      }
    }

    await offline.close();
    await host.lanHost.startProject(projectId);
    const resumed = new CollabPublicationService(member, publicationOptions);
    publications.push(resumed);
    const published = await resumed.publish(publishRequest);
    expect(published).toMatchObject({ status: 'success', value: { state: 'request-synchronized' } });
    if (published.status !== 'success' || !published.value.request) {
      throw new Error('Resumed Publish did not create a request');
    }
    const committedOid = published.value.localHeadOid;
    expect(committedOid === capturedOid).toBe(laterWork === 'unchanged');
    await expect(readFile(path.join(workingCopy, 'offline-note.md'), 'utf8'))
      .resolves.toBe(laterWork === 'unchanged' ? 'offline change\n' : 'offline change\ncontinued work\n');
    await expect(readFile(path.join(workingCopy, 'later-note.md'), 'utf8').catch(() => null))
      .resolves.toBe(laterWork === 'unchanged' ? null : 'another unpublished note\n');
    expect(published).toMatchObject({
      status: 'success',
      value: {
        localHeadOid: committedOid,
        remoteHeadOid: committedOid,
        request: {
          latestHeadOid: committedOid,
          memberId: membership.member.id,
          status: 'open',
        },
        state: 'request-synchronized',
      },
    });
    await expect(resumed.readPublishDescription(projectId)).resolves.toBeNull();
    const repeated = await resumed.publish(publishRequest);
    expect(repeated).toMatchObject({
      status: 'success',
      value: {
        localHeadOid: committedOid,
        request: { id: published.value.request.id },
        state: 'request-synchronized',
      },
    });

    const snapshot = await resumed.readSnapshot(projectId);
    expect(snapshot.openRequests).toEqual([
      expect.objectContaining({
        id: published.value.request.id,
        latestHeadOid: committedOid,
        memberId: membership.member.id,
      }),
    ]);
    const hostGit = await host.requireGitFoundation();
    const bareRepository = path.join(
      hostRoot,
      '.claudian',
      'collab',
      'authorities',
      projectId,
      'repository.git',
    );
    expect(await hostGit.repositories.resolveRef(
      bareRepository,
      membership.member.personalRef,
    )).toBe(committedOid);
    expect(await memberGit.repositories.countDivergence(
      workingCopy,
      initialOid,
      committedOid,
    )).toEqual({ leftOnly: 0, rightOnly: laterWork === 'unchanged' ? 1 : 2 });
    await expect(hostGit.repositories.assertHealthy(bareRepository)).resolves.toBeUndefined();
    expect(hostGit.runner.activeProcessCount).toBe(0);
    expect(memberGit.runner.activeProcessCount).toBe(0);
    },
  );
});
