import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TEST_INSTALLATION_A, TEST_INSTALLATION_B } from '@test/helpers/installations';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { SQLJSProjectDatabase } from '@/app/collab/authority/SQLJSProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import type { CollabFeatureService } from '@/app/collab/CollabFeatureService';
import { createCollabFeatureSubcomposition } from '@/app/collab/CollabFeatureSubcomposition';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import type { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import type { CollabResult } from '@/core/collab';

export function projectUpdateMilestoneFixture() {
  // All participants use the same executable. Reuse its real capability probe,
  // while every participant still owns fresh repositories, processes and state.
  const gitRuntimeResolver = new GitRuntimeResolver();
  let SQL: SqlJsStatic;
  let root = '';
  const foundations: ClaudianCollabService[] = [];
  const features: CollabFeatureService[] = [];

  beforeAll(async () => { SQL = await initSqlJs(); });
  const closing = new Set<string>();
  async function traceClose(label: string, operation: () => Promise<void>): Promise<void> {
    closing.add(label);
    try { await operation(); } finally { closing.delete(label); }
  }
  async function closeParticipants(): Promise<void> {
    await Promise.all(features.splice(0).map((feature, index) => traceClose(`feature-${index}`, () => feature.close())));
    await Promise.all(foundations.splice(0).map((foundation, index) => traceClose(`foundation-${index}`, () => foundation.close())));
  }

  async function cleanup(): Promise<void> {
    // Identify the pending owner before Jest reports its teardown timeout.
    // Keep awaiting the real close operations; never replace their settlement.
    const diagnostic = setTimeout(() => {
      process.stderr.write(`Fixture cleanup pending: ${[...closing].join(',')}\n`);
    }, 60_000);
    try {
      await closeParticipants();
      if (root) await traceClose('remove-root', () => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    } finally { clearTimeout(diagnostic); }
  }
  afterEach(cleanup);
  afterAll(cleanup);

  function createFoundation(vaultRoot: string, invitationCodec: InvitationCodec, hostPort?: number): ClaudianCollabService {
    const installationKey = hostPort === undefined ? TEST_INSTALLATION_B : TEST_INSTALLATION_A;
    const foundation = new ClaudianCollabService({
      installationKey,
      gitRuntimeResolver,
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

  return {
    closeParticipants,
    createFoundation,
    createFeature,
    async createRoot(prefix: string): Promise<string> {
      root = await mkdtemp(path.join(tmpdir(), prefix));
      return root;
    },
  };
}

export function unwrap<T>(result: CollabResult<T>): T {
  if (result.status !== 'success') throw new Error(`Operation failed: ${JSON.stringify(result)}`);
  return result.value;
}

export async function publishFully(feature: CollabFeatureService, projectId: string) {
  const description = 'Review this contribution';
  const published = unwrap(await feature.publish({ description, projectId }));
  if (published.state !== 'review-required' || !published.review) return published;
  return unwrap(await feature.confirmPublish({
    description, projectId, operationId: published.review.operationId,
    expectedMainOid: published.review.currentMainOid, expectedCandidateOid: published.review.candidateOid,
  }));
}

export async function accept(feature: CollabFeatureService, projectId: string, requestId: string): Promise<void> {
  const review = unwrap(await feature.prepareReview(projectId, requestId));
  unwrap(await feature.acceptRequest({
    projectId, requestId, expectedHeadOid: review.detail.reviewedHeadOid, expectedMainOid: review.detail.currentMainOid,
    expectedRequestRevision: review.detail.request.revision, expectedResolvingTickets: [],
  }));
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for update');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
