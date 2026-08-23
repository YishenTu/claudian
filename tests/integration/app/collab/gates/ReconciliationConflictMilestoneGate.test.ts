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

import type { CollabProjectId } from '@claudian-collab/protocol';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import type { CollabFeatureService } from '@/app/collab/CollabFeatureService';
import { createCollabFeatureSubcomposition } from '@/app/collab/CollabFeatureSubcomposition';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import type { CollabAcceptOutcome, CollabResult } from '@/core/collab';

jest.setTimeout(120_000);

describe('M6 publish conflict gate', () => {
  let SQL: SqlJsStatic;
  const foundations: ClaudianCollabService[] = [];
  const features: CollabFeatureService[] = [];
  let root = '';

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  afterEach(async () => {
    await Promise.all(features.splice(0).map(feature => feature.close()));
    await Promise.all(foundations.splice(0).map(foundation => foundation.close()));
    if (root) await rm(root, { force: true, recursive: true });
    root = '';
  });

  it('auto-syncs contribution-free work and exposes open-request conflicts', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-m6-gate-'));
    const hostRoot = path.join(root, 'host-vault');
    const memberARoot = path.join(root, 'member-a-vault');
    const memberBRoot = path.join(root, 'member-b-vault');
    await Promise.all([mkdir(hostRoot), mkdir(memberARoot), mkdir(memberBRoot)]);

    const invitationCodec = new InvitationCodec({
      isAddressAllowed: address => address === '127.0.0.1',
    });
    const host = createFoundation(hostRoot, invitationCodec, await availablePort(), true);
    const memberA = createFoundation(memberARoot, invitationCodec);
    const memberB = createFoundation(memberBRoot, invitationCodec);
    const hostFeature = createFeature(host, hostRoot);
    const memberAFeature = createFeature(memberA, memberARoot);
    const memberBFeature = createFeature(memberB, memberBRoot);

    unwrap(await hostFeature.initialize(), 'Host initialization');
    unwrap(await memberAFeature.initialize(), 'Member A initialization');
    unwrap(await memberBFeature.initialize(), 'Member B initialization');
    const project = unwrap(await hostFeature.createProject({
      memberDisplayName: 'Host Manager',
      name: 'Alpha',
    }), 'Project creation');
    const projectId = project.id;
    unwrap(await hostFeature.startHost(projectId), 'Host start');
    const invitation = unwrap(
      await hostFeature.createInvitation(projectId),
      'Invitation',
    ).encodedInvitation;
    const joinedA = unwrap(await memberAFeature.joinProject({
      encodedInvitation: invitation,
      memberDisplayName: 'Member A',
    }), 'Member A Join');
    const joinedB = unwrap(await memberBFeature.joinProject({
      encodedInvitation: invitation,
      memberDisplayName: 'Member B',
    }), 'Member B Join');
    const memberAPath = path.join(memberARoot, joinedA.workspacePath);
    const memberBPath = path.join(memberBRoot, joinedB.workspacePath);

    // Reading coordination installs accepted-state event handling for this clone.
    unwrap(await memberBFeature.inspectProject(projectId), 'Member B inspection');
    await Promise.all([
      writeFile(path.join(memberAPath, 'agent.md'), 'base agent\n'),
      writeFile(path.join(memberAPath, 'manual.md'), 'base manual\n'),
      writeFile(path.join(memberAPath, 'image.bin'), Buffer.from([0x00, 0x01])),
    ]);
    const initial = await publishFully(memberAFeature, projectId, 'Initial Publish');
    if (!initial.request) throw new Error('Initial request missing');
    await accept(hostFeature, projectId, initial.request.id);

    await waitFor(async () => {
      try {
        const inspection = await memberBFeature.inspectProject(projectId);
        return inspection.status === 'success'
          && inspection.value.personalChanges?.action === 'none'
          && inspection.value.gitStatus?.headOid
            === inspection.value.gitStatus?.personalRemoteOid
          && await readFile(path.join(memberBPath, 'agent.md'), 'utf8') === 'base agent\n';
      } catch {
        return false;
      }
    });

    await Promise.all([
      writeFile(path.join(memberBPath, 'agent.md'), 'personal agent\n'),
      writeFile(path.join(memberBPath, 'manual.md'), 'personal manual\n'),
      writeFile(path.join(memberBPath, 'image.bin'), Buffer.from([0x10, 0x11])),
    ]);
    const memberBRequest = (await publishFully(
      memberBFeature,
      projectId,
      'Member B Publish',
    )).request;
    if (!memberBRequest) throw new Error('Member B request missing');

    await waitFor(async () => {
      try {
        return await readFile(path.join(memberAPath, 'agent.md'), 'utf8') === 'base agent\n';
      } catch {
        return false;
      }
    });
    await Promise.all([
      writeFile(path.join(memberAPath, 'agent.md'), 'accepted agent\n'),
      writeFile(path.join(memberAPath, 'manual.md'), 'accepted manual\n'),
      writeFile(path.join(memberAPath, 'image.bin'), Buffer.from([0x20, 0x21])),
    ]);
    const acceptedUpdate = await publishFully(
      memberAFeature,
      projectId,
      'Accepted update Publish',
    );
    if (!acceptedUpdate.request) throw new Error('Accepted update request missing');
    await accept(hostFeature, projectId, acceptedUpdate.request.id);

    let operationId = '';
    await waitFor(async () => {
      const inspection = await memberBFeature.inspectProject(projectId);
      if (
        inspection.status !== 'success'
        || inspection.value.personalChanges?.action !== 'resolve-changes'
        || !inspection.value.personalChanges.conflictOperationId
      ) return false;
      operationId = inspection.value.personalChanges.conflictOperationId;
      return true;
    });
    const session = unwrap(
      await memberBFeature.readConflict(operationId),
      'Conflict session',
    );
    expect(session.descriptor.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'text', path: 'agent.md' }),
      expect.objectContaining({ kind: 'text', path: 'manual.md' }),
      expect.objectContaining({ kind: 'binary', path: 'image.bin' }),
    ]));

    const unchangedPublish = await memberBFeature.publish({
      description: memberBRequest.description,
      projectId,
    });
    expect(unchangedPublish).toMatchObject({
      conflict: { operationId },
      status: 'conflict',
    });

    await Promise.all([
      writeFile(path.join(memberBPath, 'agent.md'), 'reviewed agent file\n'),
      writeFile(path.join(memberBPath, 'manual.md'), 'manual reviewed\n'),
    ]);
    const prepared = unwrap(await memberBFeature.publish({
      description: memberBRequest.description,
      projectId,
    }), 'Publish local conflict resolution');
    expect(prepared.state).toBe('review-required');
    const review = prepared.review;
    if (!review) throw new Error('Resolved publication review missing');
    await expect(readFile(path.join(memberBPath, 'agent.md'), 'utf8'))
      .resolves.toBe('reviewed agent file\n');
    await expect(readFile(path.join(memberBPath, 'manual.md'), 'utf8'))
      .resolves.toBe('manual reviewed\n');
    await expect(readFile(path.join(memberBPath, 'image.bin')))
      .resolves.toEqual(Buffer.from([0x10, 0x11]));

    const resumedPublish = unwrap(await memberBFeature.confirmPublish({
      description: memberBRequest.description,
      expectedCandidateOid: review.candidateOid,
      expectedMainOid: review.currentMainOid,
      operationId: review.operationId,
      projectId,
    }), 'Confirm resolved publication');
    expect(resumedPublish).toMatchObject({
      request: { id: memberBRequest.id, status: 'open' },
      state: 'request-synchronized',
    });
    await expect(readFile(path.join(memberBPath, 'agent.md'), 'utf8'))
      .resolves.toBe('reviewed agent file\n');
    await expect(readFile(path.join(memberBPath, 'manual.md'), 'utf8'))
      .resolves.toBe('manual reviewed\n');

    const memberBGit = await memberB.requireGitFoundation();
    expect(await memberBGit.repositories.getWorkingTreeStatus(memberBPath)).toEqual([]);
    expect(memberBGit.runner.activeProcessCount).toBe(0);
  });

  function createFoundation(
    vaultRoot: string,
    invitationCodec: InvitationCodec,
    hostPort?: number,
    ownsAuthority = false,
  ): ClaudianCollabService {
    const foundation = new ClaudianCollabService({
      ...(ownsAuthority
        ? {
          createAuthorityDatabase: (authorityDirectory: string) => (
            new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs: async () => SQL })
          ),
          lanHost: {
            createInvitationCodec: () => invitationCodec,
            getPrivateIpv4Addresses: () => ['127.0.0.1'],
            portCandidates: [hostPort!],
          },
        }
        : {}),
      getConfiguredGitPath: () => '',
      invitationCodec,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });
    foundations.push(foundation);
    return foundation;
  }

  function createFeature(
    foundation: ClaudianCollabService,
    vaultRoot: string,
  ): CollabFeatureService {
    const feature = createCollabFeatureSubcomposition({
      foundation,
      projectSetup: new CollabProjectSetupService(foundation, { vaultRoot }),
      vaultRoot,
    }).feature;
    features.push(feature);
    return feature;
  }
});

async function accept(
  feature: CollabFeatureService,
  projectId: CollabProjectId,
  requestId: string,
): Promise<CollabAcceptOutcome> {
  const review = unwrap(
    await feature.prepareReview(projectId, requestId),
    `Review ${requestId}`,
  );
  return unwrap(await feature.acceptRequest({
    expectedHeadOid: review.detail.reviewedHeadOid,
    expectedMainOid: review.detail.currentMainOid,
    expectedRequestRevision: review.detail.request.revision,
    expectedResolvingTickets: review.detail.request.ticketRelations
      .filter(relation => relation.kind === 'resolves')
      .map(relation => ({
        revision: relation.ticketRevision,
        ticketId: relation.ticketId,
      })),
    projectId,
    requestId,
  }), `Accept ${requestId}`);
}

async function publishFully(
  feature: CollabFeatureService,
  projectId: CollabProjectId,
  label: string,
) {
  const description = `${label} description`;
  const prepared = unwrap(await feature.publish({ description, projectId }), label);
  if (prepared.state !== 'review-required' || !prepared.review) return prepared;
  return unwrap(await feature.confirmPublish({
    description,
    expectedCandidateOid: prepared.review.candidateOid,
    expectedMainOid: prepared.review.currentMainOid,
    operationId: prepared.review.operationId,
    projectId,
  }), `${label} confirmation`);
}

function unwrap<T>(result: CollabResult<T>, label: string): T {
  if (result.status === 'success') return result.value;
  throw new Error(`${label} failed: ${JSON.stringify(result)}`);
}

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

async function waitFor(
  predicate: () => boolean | Promise<boolean | void>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for reconciliation');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
