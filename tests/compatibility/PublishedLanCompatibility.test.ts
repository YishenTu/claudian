import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { collabCloudProjectOperationRoute } from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { ProjectEventClient } from '@/app/collab/client/ProjectEventClient';
import type { CollabFeatureService } from '@/app/collab/CollabFeatureService';
import { createCollabFeatureSubcomposition } from '@/app/collab/CollabFeatureSubcomposition';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import { HostTransferTargetTransport } from '@/app/collab/lan/HostTransferTargetTransport';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { CloudAuthorityAdapter, type CloudAuthorityAdapterOptions } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudProjectCredentialStore } from '@/app/collab/remote-authority/CloudProjectCredentialStore';
import { NodeCloudAuthorityHttpTransport } from '@/app/collab/remote-authority/NodeCloudAuthorityHttpTransport';
import type { CollabResult } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const current = {
  ClaudianCollabService, CollabProjectSetupService, InvitationCodec, ProjectEventClient,
  SqlJsProjectDatabase, createCollabFeatureSubcomposition,
};
// Only common, public owners are used. This module is built from the pinned
// published source and its integrity-checked registry protocol, never this tree.
const published = jest.requireActual<typeof current>('@lan226');
const cloudServerUrl = process.env.CLAUDIAN_AUTHORITY_TRANSFER_SERVER_URL;
const describeWithCloud = cloudServerUrl ? describe : describe.skip;

interface Participant {
  readonly api: typeof current;
  readonly foundation: ClaudianCollabService;
  readonly feature: CollabFeatureService;
  readonly root: string;
}

jest.setTimeout(90_000);

describe('published 2.2.6 LAN compatibility', () => {
  let root: string;
  let SQL: SqlJsStatic;
  const participants: Participant[] = [];
  const events: ProjectEventClient[] = [];
  beforeAll(async () => { SQL = await initSqlJs(); });
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'claudian-published-lan-')); });
  afterEach(async () => {
    jest.useRealTimers();
    for (const connection of events.splice(0)) connection.dispose();
    for (const participant of participants.splice(0).reverse()) {
      await participant.feature.close();
      await participant.foundation.close();
    }
    await rm(root, { recursive: true, force: true });
  });

  it.each(['published-host', 'current-host', 'current-pair'] as const)(
    'preserves Join, identity, role enforcement, events and Git publication with %s', async direction => {
      const host = await participant(direction === 'published-host' ? published : current, 'host', TEST_INSTALLATION_A);
      const peer = await participant(direction === 'current-host' ? published : current, 'member', TEST_INSTALLATION_B);
      const project = unwrap(await host.feature.createProject({ memberDisplayName: 'Host', name: 'Compatible LAN' }));
      const projectId = project.id;
      const hostIdentity = unwrap(await host.feature.readSnapshot(projectId)).snapshot.currentMember.id;
      const invitation = unwrap(await host.feature.createInvitation(projectId));
      const joined = unwrap(await peer.feature.joinProject({
        encodedInvitation: invitation.encodedInvitation, memberDisplayName: 'Member',
      }));
      const peerPath = path.join(peer.root, joined.workspacePath);
      const snapshot = unwrap(await peer.feature.readSnapshot(projectId)).snapshot;
      expect(snapshot).toMatchObject({
        currentMember: { role: 'member', status: 'active' },
        project: { id: projectId, hostMemberId: hostIdentity, mainRef: 'refs/heads/main' },
      });
      expect(await peer.feature.createInvitation(projectId)).toMatchObject({
        status: 'failure', error: { code: 'authorization-denied' },
      });

      const membership = await peer.foundation.local.projects.loadMembership(projectId);
      if (!membership || !isCollabLocalLanMembership(membership)) throw new Error('Missing LAN membership');
      let observedSequence = -1;
      const connection = new peer.api.ProjectEventClient({
        caCertificatePem: membership.authority.hostCaCertificatePem!,
        endpoint: membership.authority.endpoint!,
        lastSequence: snapshot.eventSequence,
        memberCredential: membership.member.credential,
        projectId,
      }, async invalidation => {
        observedSequence = invalidation.sequence;
        return invalidation.sequence;
      });
      events.push(connection);
      connection.start();
      await waitFor(async () => observedSequence >= snapshot.eventSequence);
      const beforeTicket = observedSequence;
      const ticket = unwrap(await host.feature.createTicket({ projectId, title: 'Shared ticket', body: 'Original LAN operation' }));
      await waitFor(async () => observedSequence > beforeTicket);
      expect(unwrap(await peer.feature.readSnapshot(projectId)).snapshot.openTicketCount).toBe(1);

      let lookupResult: unknown = null;
      if (peer.api === current) {
        const lookup = await peer.feature.resolveTicketNumber({ projectId, ticketNumber: 1 });
        lookupResult = lookup.status === 'success'
          ? { status: 'success', ticketId: lookup.value.ticketId }
          : { status: lookup.status, reason: lookup.status === 'failure' ? lookup.error.safeContext.reason : null };
      }
      expect(lookupResult).toEqual(direction === 'published-host'
        ? { status: 'failure', reason: 'lan-capability-unavailable' }
        : direction === 'current-pair' ? { status: 'success', ticketId: ticket.ticket.id } : null);
      expect(unwrap(await peer.feature.readSnapshot(projectId)).snapshot.currentMember.id).toBe(snapshot.currentMember.id);

      await writeFile(path.join(peerPath, 'contribution.md'), 'Contribution across client versions\n');
      const publication = await publishFully(peer.feature, projectId);
      expect(publication.state).toBe('request-synchronized');
      if (!publication.request) throw new Error('Missing published request');
      const review = unwrap(await host.feature.prepareReview(projectId, publication.request.id));
      const accept = {
        projectId, requestId: publication.request.id,
        expectedHeadOid: review.detail.reviewedHeadOid,
        expectedMainOid: review.detail.currentMainOid,
        expectedRequestRevision: review.detail.request.revision,
        expectedResolvingTickets: [],
      };
      expect(await peer.feature.acceptRequest(accept)).toMatchObject({
        status: 'failure', error: { code: 'authorization-denied' },
      });
      const accepted = unwrap(await host.feature.acceptRequest(accept));
      expect(accepted.request.status).toBe('merged');
      expect(unwrap(await peer.feature.readSnapshot(projectId)).snapshot.project.mainOid).toBe(accepted.mainOid);
      await waitFor(async () => {
        unwrap(await host.feature.inspectProject(projectId));
        return await readFile(path.join(host.root, project.workspacePath, 'contribution.md'), 'utf8').catch(() => null)
          === 'Contribution across client versions\n';
      });

      const offer = unwrap(await host.feature.createManagerResponsibilityOffer({
        projectId, purpose: 'manager-promotion', targetMemberId: snapshot.currentMember.id,
      }));
      await waitFor(async () => {
        const observed = unwrap(await peer.feature.readSnapshot(projectId)).snapshot;
        return 'managerResponsibilityOffer' in observed && observed.managerResponsibilityOffer?.status === 'acknowledged';
      });
      unwrap(await host.feature.promoteManager({
        projectId, targetMemberId: snapshot.currentMember.id, managerResponsibilityOfferId: offer.offerId,
      }));
      expect(unwrap(await peer.feature.readSnapshot(projectId)).snapshot.currentMember.role).toBe('manager');
      unwrap(await peer.feature.demoteManager({ projectId, targetMemberId: hostIdentity }));
      expect(unwrap(await host.feature.readSnapshot(projectId)).snapshot).toMatchObject({
        currentMember: { id: hostIdentity, role: 'member' },
        project: { hostMemberId: hostIdentity },
      });

      await writeFile(path.join(peerPath, 'private-draft.md'), 'Keep local work\n');
      unwrap(await host.feature.stopHost(projectId));
      unwrap(await host.feature.startHost(projectId));
      expect(unwrap(await peer.feature.readSnapshot(projectId)).snapshot).toMatchObject({
        currentMember: { id: snapshot.currentMember.id, role: 'manager' },
        project: { hostMemberId: hostIdentity },
      });
      expect(await readFile(path.join(peerPath, 'private-draft.md'), 'utf8')).toBe('Keep local work\n');


    },
  );

  it('upgrades a published Host while its existing published Member stays connected', async () => {
    const oldHost = await participant(published, 'host', TEST_INSTALLATION_A);
    const peer = await participant(published, 'member', TEST_INSTALLATION_B);
    const project = unwrap(await oldHost.feature.createProject({ memberDisplayName: 'Host', name: 'Existing LAN' }));
    const invitation = unwrap(await oldHost.feature.createInvitation(project.id));
    const joined = unwrap(await peer.feature.joinProject({ encodedInvitation: invitation.encodedInvitation, memberDisplayName: 'Member' }));
    const before = await peer.foundation.local.projects.loadMembership(project.id);
    const hostPath = path.join(oldHost.root, project.workspacePath);
    const peerPath = path.join(peer.root, joined.workspacePath);
    await writeFile(path.join(hostPath, 'host-draft.md'), 'Host unpublished work\n');
    await writeFile(path.join(peerPath, 'peer-draft.md'), 'Member unpublished work\n');
    await oldHost.feature.close();
    await oldHost.foundation.close();
    const upgraded = await participant(current, 'host', TEST_INSTALLATION_A);
    await upgraded.feature.restoreLifecycle();
    await upgraded.feature.restoreHosts();
    // A new mutation proves live connectivity; a cached snapshot is insufficient.
    unwrap(await peer.feature.createTicket({ projectId: project.id, title: 'After Host upgrade', body: 'Live old Member write' }));
    expect(unwrap(await upgraded.feature.readSnapshot(project.id)).snapshot.openTicketCount).toBe(1);
    const after = await peer.foundation.local.projects.loadMembership(project.id);
    expect(after?.member).toEqual(before?.member);
    expect(after?.project).toEqual(before?.project);
    expect(await readFile(path.join(hostPath, 'host-draft.md'), 'utf8')).toBe('Host unpublished work\n');
    expect(await readFile(path.join(peerPath, 'peer-draft.md'), 'utf8')).toBe('Member unpublished work\n');
  });

  describeWithCloud('LAN-to-Cloud member migration', () => {
    it.each([[true, false, false], [false, false, false], [false, true, false], [false, true, true]])('reconnects an upgraded 2.2.6 Member to Cloud (Host is Manager: %s, lost claim response: %s, expired: %s)', async (hostIsManager, loseClaimResponse, expired) => {
      if (!cloudServerUrl) throw new Error('Missing real Cloud server');
      const oldHost = await participant(published, 'host', TEST_INSTALLATION_A);
      const oldPeer = await participant(published, 'member', TEST_INSTALLATION_B);
      const project = unwrap(await oldHost.feature.createProject({ memberDisplayName: 'Host', name: 'Published Cloud migration' }));
      const projectId = project.id;
      const invitation = unwrap(await oldHost.feature.createInvitation(projectId));
      const joined = unwrap(await oldPeer.feature.joinProject({ encodedInvitation: invitation.encodedInvitation, memberDisplayName: 'Member' }));
      const peerBefore = await oldPeer.foundation.local.projects.loadMembership(projectId);
      if (!peerBefore || !isCollabLocalLanMembership(peerBefore)) throw new Error('Missing published Member');
      const hostId = unwrap(await oldHost.feature.readSnapshot(projectId)).snapshot.currentMember.id;
      const peerId = peerBefore.member.id;
      let sequence = -1;
      const connection = new published.ProjectEventClient({
        caCertificatePem: peerBefore.authority.hostCaCertificatePem!,
        endpoint: peerBefore.authority.endpoint!,
        lastSequence: peerBefore.lastEventSequence,
        memberCredential: peerBefore.member.credential,
        projectId,
      }, async invalidation => { sequence = invalidation.sequence; return sequence; });
      events.push(connection);
      connection.start();
      await waitFor(async () => sequence >= peerBefore.lastEventSequence);
      if (!hostIsManager) {
        const offer = unwrap(await oldHost.feature.createManagerResponsibilityOffer({
          projectId, purpose: 'manager-promotion', targetMemberId: peerId,
        }));
        await waitFor(async () => {
          const snapshot = unwrap(await oldPeer.feature.readSnapshot(projectId)).snapshot;
          return 'managerResponsibilityOffer' in snapshot && snapshot.managerResponsibilityOffer?.status === 'acknowledged';
        });
        unwrap(await oldHost.feature.promoteManager({ projectId, targetMemberId: peerId, managerResponsibilityOfferId: offer.offerId }));
        unwrap(await oldPeer.feature.demoteManager({ projectId, targetMemberId: hostId }));
      }
      unwrap(await oldHost.feature.createTicket({ projectId, title: 'Preserved ticket', body: 'Published LAN content' }));
      const hostPath = path.join(oldHost.root, project.workspacePath);
      const peerPath = path.join(oldPeer.root, joined.workspacePath);
      await writeFile(path.join(hostPath, 'host-private.md'), 'Host unpublished work\n');
      await writeFile(path.join(peerPath, 'peer-private.md'), 'Member unpublished work\n');
      const hostHead = unwrap(await oldHost.feature.inspectProject(projectId)).gitStatus?.headOid;
      const peerHead = unwrap(await oldPeer.feature.inspectProject(projectId)).gitStatus?.headOid;
      connection.dispose();
      await oldPeer.feature.close();
      await oldPeer.foundation.close();
      await oldHost.feature.close();
      await oldHost.foundation.close();

      const host = await participant(current, 'host', TEST_INSTALLATION_A);
      await host.feature.restoreLifecycle();
      await host.feature.restoreHosts();
      let responseLost = false;
      const transport = new NodeCloudAuthorityHttpTransport();
      let peer = await participant(current, 'member', TEST_INSTALLATION_B, {
        request: async input => {
          const response = await transport.request(input);
          if (loseClaimResponse && !responseLost && response.status === 200
            && input.url.endsWith(collabCloudProjectOperationRoute(projectId, 'claimTransferredMembership').target)) {
            responseLost = true;
            throw new CollabError({ code: 'endpoint-unreachable' });
          }
          return response;
        },
      });
      await peer.feature.restoreLifecycle();
      const moved = unwrap(await host.feature.moveLanToCloud({ projectId, serverUrl: cloudServerUrl }));
      expect(moved).toMatchObject({ state: 'completed', targetAuthority: { kind: 'cloud', generation: 2 } });
      const credentials = new CloudProjectCredentialStore(peer.root);
      expect(await peer.feature.reconnectProject({ projectId, authority: { kind: 'cloud', serverUrl: `${cloudServerUrl}/wrong-target` } }))
        .toMatchObject({ status: 'failure', error: { safeContext: { reason: 'authority-transfer-claimant-source-mismatch' } } });
      await expect(credentials.require(projectId)).rejects.toBeDefined();
      const attempted = await peer.feature.reconnectProject({
        projectId, authority: { kind: 'cloud', serverUrl: cloudServerUrl },
      });
      expect(responseLost).toBe(loseClaimResponse);
      expect(attempted).toMatchObject(loseClaimResponse
        ? { status: 'recovery-required', durableProgress: true } : { status: 'success' });
      const pending = unwrap(await peer.feature.readPendingReconnect(projectId));
      expect(pending && { projectId: pending.projectId, serverUrl: pending.serverUrl })
        .toEqual(loseClaimResponse ? { projectId, serverUrl: cloudServerUrl } : null);
      const principal = await credentials.require(projectId);
      expect(unwrap(await host.feature.readSnapshot(projectId)).snapshot.currentMember)
        .toMatchObject({ id: hostId, role: hostIsManager ? 'manager' : 'member' });
      expect(unwrap(await host.feature.inspectProject(projectId)).gitStatus?.headOid).toBe(hostHead);
      let observedPending = pending;
      let reconnected;
      if (loseClaimResponse) {
        await peer.feature.close();
        await peer.foundation.close();
        peer = await participant(current, 'member', TEST_INSTALLATION_B);
        observedPending = unwrap(await peer.feature.readPendingReconnect(projectId));
        if (expired) {
          await host.feature.close();
          await host.foundation.close();
          jest.useFakeTimers({
            now: Date.parse(moved.expiresAt) + 1,
            doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'hrtime', 'performance', 'queueMicrotask'],
          });
        }
        reconnected = unwrap(await peer.feature.resumeReconnect(projectId));
        jest.useRealTimers();
      } else reconnected = unwrap(attempted);
      expect(observedPending).toEqual(pending);
      expect(await credentials.require(projectId)).toEqual(principal);
      expect(unwrap(await peer.feature.readPendingReconnect(projectId))).toBeNull();
      expect(reconnected).toMatchObject({ id: projectId, authorityKind: 'cloud', workspacePath: joined.workspacePath });
      expect(unwrap(await peer.feature.readSnapshot(projectId)).snapshot).toMatchObject({
        currentMember: { id: peerId, role: hostIsManager ? 'member' : 'manager', personalRef: peerBefore.member.personalRef },
        openTicketCount: 1,
        project: { id: projectId, authorityKind: 'cloud', authorityGeneration: 2 },
      });
      expect(unwrap(await peer.feature.inspectProject(projectId)).gitStatus?.headOid).toBe(peerHead);
      expect(await readFile(path.join(hostPath, 'host-private.md'), 'utf8')).toBe('Host unpublished work\n');
      expect(await readFile(path.join(peerPath, 'peer-private.md'), 'utf8')).toBe('Member unpublished work\n');
    });

  });

  it('hands a published Host to an upgraded Member while preserving Host trust and roles', async () => {
    const host = await participant(published, 'host', TEST_INSTALLATION_A);
    const peer = await participant(current, 'member', TEST_INSTALLATION_B);
    const project = unwrap(await host.feature.createProject({ memberDisplayName: 'Host', name: 'Host upgrade' }));
    const invitation = unwrap(await host.feature.createInvitation(project.id));
    unwrap(await peer.feature.joinProject({ encodedInvitation: invitation.encodedInvitation, memberDisplayName: 'New Host' }));
    const before = unwrap(await peer.feature.readSnapshot(project.id)).snapshot;
    unwrap(await host.feature.createHostTransfer({ projectId: project.id, targetMemberId: before.currentMember.id }));
    const offered = unwrap(await peer.feature.readSnapshot(project.id)).snapshot;
    if (!('hostTransfer' in offered) || !offered.hostTransfer) throw new Error('Missing Host offer');
    unwrap(await peer.feature.acceptHostTransfer({ projectId: project.id, transferId: offered.hostTransfer.transferId }));
    try {
      await waitFor(async () => {
        const membership = await peer.foundation.local.projects.loadMembership(project.id);
        return Boolean(membership && isCollabLocalLanMembership(membership) && membership.hostOwnership.ownsAuthority);
      });
    } catch {
      const outgoing = await host.foundation.local.projects.hostTransferRecovery.load(project.id, 'outgoing');
      const incoming = await peer.foundation.local.projects.hostTransferRecovery.load(project.id, 'incoming');
      const retried = await host.feature.startHost(project.id);
      throw new Error(`Host handoff did not converge: source=${outgoing?.phase}, target=${incoming?.phase}, retry=${retried.status === 'failure' ? retried.error.safeContext.reason : retried.status}`);
    }
    await waitFor(async () => {
      const result = await host.feature.readSnapshot(project.id);
      return result.status === 'success' && 'hostMemberId' in result.value.snapshot.project
        && result.value.snapshot.project.hostMemberId === before.currentMember.id;
    });
    expect(unwrap(await peer.feature.readSnapshot(project.id)).snapshot).toMatchObject({
      currentMember: { id: before.currentMember.id, role: 'member' },
      project: { hostMemberId: before.currentMember.id },
    });
    expect(unwrap(await host.feature.readSnapshot(project.id)).snapshot.currentMember.role).toBe('manager');
    unwrap(await host.feature.createTicket({ projectId: project.id, title: 'After Host handoff', body: 'Old Manager still participates' }));
    expect(unwrap(await peer.feature.readSnapshot(project.id)).snapshot.openTicketCount).toBe(1);
  });

  it('requires an upgraded physical receiver before quiescing a current Host', async () => {
    const host = await participant(current, 'host', TEST_INSTALLATION_A);
    const peer = await participant(published, 'member', TEST_INSTALLATION_B);
    const project = unwrap(await host.feature.createProject({ memberDisplayName: 'Host', name: 'Receiver compatibility' }));
    const invitation = unwrap(await host.feature.createInvitation(project.id));
    unwrap(await peer.feature.joinProject({ encodedInvitation: invitation.encodedInvitation, memberDisplayName: 'Old receiver' }));
    const member = unwrap(await peer.feature.readSnapshot(project.id)).snapshot.currentMember;
    unwrap(await host.feature.createHostTransfer({ projectId: project.id, targetMemberId: member.id }));
    const offered = unwrap(await peer.feature.readSnapshot(project.id)).snapshot;
    if (!('hostTransfer' in offered) || !offered.hostTransfer) throw new Error('Missing Host offer');
    const transferId = offered.hostTransfer.transferId;
    unwrap(await peer.feature.acceptHostTransfer({ projectId: project.id, transferId }));
    const record = await host.foundation.local.projects.hostTransferRecovery.load(project.id, 'outgoing');
    if (!record) throw new Error('Missing accepted Host handoff');
    await expect(new HostTransferTargetTransport().probe({
      endpoint: record.targetEndpoint!, receiverCredential: record.receiverCredential!,
      targetCaCertificatePem: record.targetCaCertificatePem!, targetCaFingerprint: record.targetCaFingerprint!, transferId,
    })).rejects.toMatchObject({ safeContext: { reason: 'host-transfer-target-schema-unsupported' } });
    expect((await host.foundation.local.projects.hostTransferRecovery.load(project.id, 'outgoing'))?.phase).toBe('accepted');
    unwrap(await host.feature.cancelHostTransfer({ projectId: project.id, transferId }));
    unwrap(await peer.feature.createTicket({ projectId: project.id, title: 'Still active', body: 'Receiver upgrade only affects handoff' }));
    await waitFor(async () => unwrap(await host.feature.readSnapshot(project.id)).snapshot.openTicketCount === 1);
  });

  it('recovers retirement records written by the published LAN implementation', async () => {
    const host = await participant(published, 'host', TEST_INSTALLATION_A);
    const project = unwrap(await host.feature.createProject({ memberDisplayName: 'Host', name: 'Retired LAN' }));
    const repositoryPath = path.join(host.root, project.workspacePath);
    await writeFile(path.join(repositoryPath, 'kept.md'), 'Keep retired Project files\n');
    const snapshot = unwrap(await host.feature.readSnapshot(project.id)).snapshot;
    if (!('hostMemberId' in snapshot.project)) throw new Error('Missing LAN Host');
    const retirePublished = host.feature.retireProject as unknown as (request: {
      projectId: string; managerActorMemberId: string; expectedHostMemberId: string;
    }) => Promise<CollabResult<void>>;
    unwrap(await retirePublished.call(host.feature, {
      projectId: project.id, managerActorMemberId: snapshot.currentMember.id,
      expectedHostMemberId: snapshot.project.hostMemberId,
    }));
    await host.feature.close();
    await host.foundation.close();
    const upgraded = await participant(current, 'host', TEST_INSTALLATION_A);
    const retirement = await upgraded.foundation.local.projects.loadRetirementRecord(project.id);
    expect(retirement?.projectId).toBe(project.id);
    await upgraded.feature.restoreLifecycle();
    expect(unwrap(await upgraded.feature.listProjects()).find(value => value.id === project.id)?.lifecycle).toBe('retired');
    expect(await readFile(path.join(repositoryPath, 'kept.md'), 'utf8')).toBe('Keep retired Project files\n');
  });

  async function participant(api: typeof current, name: string, installationKey: typeof TEST_INSTALLATION_A, cloudOptions?: CloudAuthorityAdapterOptions): Promise<Participant> {
    const vaultRoot = path.join(root, name);
    await mkdir(vaultRoot, { recursive: true });
    const invitationCodec = new api.InvitationCodec({ isAddressAllowed: address => address === '127.0.0.1' });
    const foundation = new api.ClaudianCollabService({
      createAuthorityDatabase: (directory, resourceAdmission) => new api.SqlJsProjectDatabase(directory, { resourceAdmission, loadSqlJs: async () => SQL }),
      getConfiguredGitPath: () => '', installationKey, invitationCodec,
      lanHost: { createInvitationCodec: () => invitationCodec, getPrivateIpv4Addresses: () => ['127.0.0.1'], portCandidates: [await availablePort()] },
      obsidianConfigDirectory: '.obsidian', vaultRoot,
    });
    const { feature } = api.createCollabFeatureSubcomposition({
      ...(cloudOptions ? { cloudAuthority: new CloudAuthorityAdapter(vaultRoot, cloudOptions) } : {}),
      foundation, projectSetup: new api.CollabProjectSetupService(foundation, { installationKey, vaultRoot }), vaultRoot,
    });
    const result = { api, feature, foundation, root: vaultRoot };
    participants.push(result);
    unwrap(await feature.initialize());
    return result;
  }
});

function unwrap<T>(result: CollabResult<T>): T {
  if (result.status !== 'success') {
    const failure = result.status === 'failure' ? result.error : null;
    throw new Error(`LAN operation failed: ${failure?.code ?? result.status} (${failure?.safeContext.reason ?? ''})`);
  }
  return result.value;
}

async function publishFully(feature: CollabFeatureService, projectId: string) {
  const description = 'Review this contribution';
  const publication = unwrap(await feature.publish({ description, projectId }));
  if (publication.state !== 'review-required' || !publication.review) return publication;
  return unwrap(await feature.confirmPublish({
    description, projectId, operationId: publication.review.operationId,
    expectedMainOid: publication.review.currentMainOid, expectedCandidateOid: publication.review.candidateOid,
  }));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for LAN convergence');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
