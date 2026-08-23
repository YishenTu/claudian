import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { COLLAB_MAIN_REF } from '@claudian-collab/protocol';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import type { CollabFeatureService } from '@/app/collab/CollabFeatureService';
import { createCollabFeatureSubcomposition } from '@/app/collab/CollabFeatureSubcomposition';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { type CollabResult } from '@/core/collab';

jest.setTimeout(120_000);

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

function unwrap<T>(result: CollabResult<T>, label: string): T {
  if (result.status === 'success') return result.value;
  throw new Error(`${label} failed: ${JSON.stringify(result)}`);
}

describe('M5 review and Accept gate', () => {
  let SQL: SqlJsStatic;
  const foundations: ClaudianCollabService[] = [];
  const features: CollabFeatureService[] = [];
  let root: string;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  afterEach(async () => {
    await Promise.all(features.splice(0).map(feature => feature.close()));
    await Promise.all(foundations.splice(0).map(foundation => foundation.close()));
    if (root) await rm(root, { force: true, recursive: true });
  });

  it('binds Tickets to the latest Publish and guards a remote Manager Accept across three Vaults', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-m5-gate-'));
    const hostRoot = path.join(root, 'host-vault');
    const memberARoot = path.join(root, 'member-a-vault');
    const memberBRoot = path.join(root, 'member-b-vault');
    await Promise.all([mkdir(hostRoot), mkdir(memberARoot), mkdir(memberBRoot)]);

    const invitationCodec = new InvitationCodec({
      isAddressAllowed: address => address === '127.0.0.1',
    });
    const host = createFoundation(hostRoot, invitationCodec, await availablePort(), true);
    const memberA = createFoundation(memberARoot, invitationCodec);
    let memberB = createFoundation(memberBRoot, invitationCodec);
    const hostFeature = createFeature(host, hostRoot);
    const memberAFeature = createFeature(memberA, memberARoot);
    let managerFeature = createFeature(memberB, memberBRoot);

    unwrap(await hostFeature.initialize(), 'Host initialization');
    unwrap(await memberAFeature.initialize(), 'Member A initialization');
    unwrap(await managerFeature.initialize(), 'Member B initialization');
    const project = unwrap(await hostFeature.createProject({
      memberDisplayName: 'Host Manager',
      name: 'Alpha',
    }), 'Project creation');
    const projectId = project.id;
    unwrap(await hostFeature.startHost(projectId), 'Host start');

    const joinedA = unwrap(await memberAFeature.joinProject({
      encodedInvitation: unwrap(
        await hostFeature.createInvitation(projectId),
        'Member A invitation',
      ).encodedInvitation,
      memberDisplayName: 'Member A',
    }), 'Member A Join');
    const joinedB = unwrap(await managerFeature.joinProject({
      encodedInvitation: unwrap(
        await hostFeature.createInvitation(projectId),
        'Member B invitation',
      ).encodedInvitation,
      memberDisplayName: 'Member B',
    }), 'Member B Join');

    const memberAMembership = await memberA.local.projects.loadMembership(projectId);
    const managerMembership = await memberB.local.projects.loadMembership(projectId);
    if (!memberAMembership || !managerMembership) {
      throw new Error('Test membership missing');
    }
    expect(unwrap(await hostFeature.listTickets({
      projectId,
      status: 'open',
    }), 'Initial Ticket list')).toMatchObject({
      page: { tickets: [] },
      source: 'online',
      stale: false,
    });
    const referenceTicket = unwrap(await hostFeature.createTicket({
      body: 'Track the referenced follow-up.',
      projectId,
      title: 'Referenced follow-up',
    }), 'Reference Ticket');
    const resolvingTicket = unwrap(await hostFeature.createTicket({
      body: 'Track the resolved change.',
      projectId,
      title: 'Resolved change',
    }), 'Resolving Ticket');
    const memberAWorkingCopy = path.join(memberARoot, joinedA.workspacePath);
    await writeFile(path.join(memberAWorkingCopy, 'shared-note.md'), '# First version\n');
    const firstDescription = [
      'Update shared note',
      `#${referenceTicket.ticket.number}`,
      `#${resolvingTicket.ticket.number}`,
    ].join('\n\n');
    const firstPublish = unwrap(
      await memberAFeature.publish({ description: firstDescription, projectId }),
      'First Publish',
    );
    if (!firstPublish.request) throw new Error('First request missing');
    const requestId = firstPublish.request.id;
    expect(firstPublish.request.ticketRelations).toEqual([
      expect.objectContaining({
        commitOid: firstPublish.localHeadOid,
        kind: 'references',
        ticketId: referenceTicket.ticket.id,
      }),
      expect.objectContaining({
        commitOid: firstPublish.localHeadOid,
        kind: 'references',
        ticketId: resolvingTicket.ticket.id,
      }),
    ]);

    const memberBOnline = unwrap(
      await managerFeature.readSnapshot(projectId),
      'Member B online snapshot',
    );
    expect(memberBOnline).toMatchObject({
      source: 'online',
      stale: false,
      snapshot: {
        currentMember: { displayName: 'Member B' },
        openTicketCount: 2,
        openRequests: [{ id: requestId, memberId: memberAMembership.member.id }],
      },
    });

    const commentInput = {
      body: 'Please keep the heading concise.',
      intentId: 'member-b-feedback-1',
      projectId,
      requestId,
    };
    const comment = unwrap(await managerFeature.addComment(commentInput), 'Comment');
    const repeatedComment = unwrap(
      await managerFeature.addComment(commentInput),
      'Repeated comment',
    );
    expect(repeatedComment.id).toBe(comment.id);

    const memberReview = unwrap(
      await managerFeature.prepareReview(projectId, requestId),
      'Member review',
    );
    expect(memberReview).toMatchObject({
      canAccept: false,
      files: [{ kind: 'added', path: 'shared-note.md' }],
    });
    const responsibility = unwrap(await hostFeature.createManagerResponsibilityOffer({
      projectId,
      purpose: 'manager-promotion',
      targetMemberId: managerMembership.member.id,
    }), 'Manager responsibility offer');
    unwrap(
      await managerFeature.readSnapshot(projectId),
      'Automatic Manager responsibility reconciliation',
    );
    unwrap(await hostFeature.promoteManager({
      managerResponsibilityOfferId: responsibility.offerId,
      projectId,
      targetMemberId: managerMembership.member.id,
    }), 'Manager promotion');
    unwrap(await managerFeature.listMembers(projectId), 'Manager role synchronization');
    expect(unwrap(
      await managerFeature.readSnapshot(projectId),
      'Manager snapshot',
    ).snapshot.currentMember).toMatchObject({
      id: managerMembership.member.id,
      role: 'manager',
    });
    const firstManagerReview = unwrap(
      await managerFeature.prepareReview(projectId, requestId),
      'Manager review',
    );
    expect(firstManagerReview).toMatchObject({
      canAccept: true,
      detail: {
        comments: { comments: [{ id: comment.id }] },
        request: { commentCount: 1 },
        reviewCondition: 'clean',
      },
    });
    const reviewedFile = unwrap(await managerFeature.readReviewFile({
      comparisonBaseOid: firstManagerReview.comparisonBaseOid,
      comparisonTargetOid: firstManagerReview.comparisonTargetOid,
      file: firstManagerReview.files[0]!,
      projectId,
      requestId,
    }), 'Review file');
    expect(reviewedFile).toMatchObject({
      kind: 'text',
      newText: '# First version\n',
      oldText: null,
    });

    unwrap(await hostFeature.stopHost(projectId), 'Host stop');
    await expect(readEventuallyCached(managerFeature, projectId)).resolves.toMatchObject({
      status: 'success',
      value: { source: 'cache', stale: true },
    });
    await expect(managerFeature.acceptRequest({
      expectedHeadOid: firstManagerReview.detail.reviewedHeadOid,
      expectedMainOid: firstManagerReview.detail.currentMainOid,
      expectedRequestRevision: firstManagerReview.detail.request.revision,
      expectedResolvingTickets: [],
      projectId,
      requestId,
    })).resolves.toMatchObject({
      error: { code: 'authority-not-synchronized' },
      status: 'failure',
    });
    await managerFeature.close();
    await memberB.close();
    unwrap(await hostFeature.startHost(projectId), 'Host restart');

    await writeFile(path.join(memberAWorkingCopy, 'shared-note.md'), '# Second version\n');
    const secondDescription = [
      'Update shared note with final intent',
      `#${referenceTicket.ticket.number}`,
      `Resolves #${resolvingTicket.ticket.number}`,
    ].join('\n\n');
    const secondPublish = unwrap(
      await memberAFeature.publish({ description: secondDescription, projectId }),
      'Second Publish',
    );
    expect(secondPublish.request?.id).toBe(requestId);
    expect(secondPublish.request?.ticketRelations).toEqual([
      expect.objectContaining({
        commitOid: secondPublish.localHeadOid,
        kind: 'references',
        ticketId: referenceTicket.ticket.id,
      }),
      expect.objectContaining({
        commitOid: secondPublish.localHeadOid,
        kind: 'resolves',
        ticketId: resolvingTicket.ticket.id,
      }),
    ]);

    memberB = createFoundation(memberBRoot, invitationCodec);
    managerFeature = createFeature(memberB, memberBRoot);
    unwrap(await managerFeature.initialize(), 'Manager reconnect initialization');
    await expect(managerFeature.readSnapshot(projectId)).resolves.toMatchObject({
      status: 'success',
      value: {
        source: 'online',
        stale: false,
        syncState: { status: 'synchronized' },
      },
    });
    const staleAccept = await managerFeature.acceptRequest({
      expectedHeadOid: firstManagerReview.detail.reviewedHeadOid,
      expectedMainOid: firstManagerReview.detail.currentMainOid,
      expectedRequestRevision: firstManagerReview.detail.request.revision,
      expectedResolvingTickets: [],
      projectId,
      requestId,
    });
    expect(staleAccept).toMatchObject({
      error: { code: 'stale-request-head' },
      status: 'failure',
    });

    const currentReview = unwrap(
      await managerFeature.prepareReview(projectId, requestId),
      'Current manager review',
    );
    const expectedResolvingTickets = currentReview.detail.request.ticketRelations
      .filter(relation => relation.kind === 'resolves')
      .map(relation => ({ revision: relation.ticketRevision, ticketId: relation.ticketId }));
    const accepted = unwrap(await managerFeature.acceptRequest({
      expectedHeadOid: currentReview.detail.reviewedHeadOid,
      expectedMainOid: currentReview.detail.currentMainOid,
      expectedRequestRevision: currentReview.detail.request.revision,
      expectedResolvingTickets,
      projectId,
      requestId,
    }), 'Accept');
    expect(accepted.request).toMatchObject({
      id: requestId,
      latestHeadOid: secondPublish.localHeadOid,
      status: 'merged',
    });

    const afterAccept = unwrap(
      await managerFeature.readSnapshot(projectId),
      'Post-Accept snapshot',
    );
    expect(afterAccept.snapshot.openRequests).toEqual([]);
    expect(unwrap(
      await managerFeature.readRequest(projectId, requestId),
      'Merged request',
    )).toMatchObject({
      comments: { comments: [{ id: comment.id }] },
      request: {
        commentCount: 1,
        description: secondDescription,
        status: 'merged',
      },
    });
    expect(unwrap(
      await managerFeature.readTicket(projectId, referenceTicket.ticket.id),
      'Referenced Ticket after Accept',
    )).toMatchObject({
      detail: {
        acceptedRelations: {
          acceptedRelations: [{
            commitOid: secondPublish.localHeadOid,
            kind: 'references',
          }],
        },
        ticket: { status: 'open' },
      },
      source: 'online',
    });
    expect(unwrap(
      await managerFeature.readTicket(projectId, resolvingTicket.ticket.id),
      'Resolved Ticket after Accept',
    )).toMatchObject({
      detail: {
        acceptedRelations: {
          acceptedRelations: [{
            commitOid: secondPublish.localHeadOid,
            kind: 'resolves',
          }],
        },
        ticket: { status: 'closed' },
      },
      source: 'online',
    });

    const hostGit = await host.requireGitFoundation();
    const bareRepository = path.join(
      hostRoot,
      '.claudian',
      'collab',
      'authorities',
      projectId,
      'repository.git',
    );
    expect(await hostGit.repositories.resolveRef(bareRepository, COLLAB_MAIN_REF))
      .toBe(accepted.mainOid);
    expect(await hostGit.repositories.resolveRef(
      bareRepository,
      memberAMembership.member.personalRef,
    )).toBe(secondPublish.localHeadOid);
    const merge = await hostGit.runner.run({
      args: ['show', '-s', '--format=%P', accepted.mainOid],
      cwd: bareRepository,
    });
    expect(merge.stdout.toString('utf8').trim()).toBe(
      `${currentReview.detail.currentMainOid} ${currentReview.detail.reviewedHeadOid}`,
    );
    await expect(hostGit.repositories.assertHealthy(bareRepository)).resolves.toBeUndefined();
    expect(hostGit.runner.activeProcessCount).toBe(0);
    expect(joinedB.id).toBe(projectId);
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

  async function readEventuallyCached(
    feature: CollabFeatureService,
    projectId: string,
  ) {
    let latest = await feature.readSnapshot(projectId);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (latest.status === 'success' && latest.value.source === 'cache') return latest;
      await new Promise(resolve => setTimeout(resolve, 25));
      latest = await feature.readSnapshot(projectId);
    }
    return latest;
  }
});
