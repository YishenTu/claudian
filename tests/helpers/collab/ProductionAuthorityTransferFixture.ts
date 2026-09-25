import { spawnSync } from 'node:child_process';
import { constants, createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { COLLAB_CLOUD_BINDING_VERSION, COLLAB_PROTOCOL_VERSION, type CollabAuthorityRelinquishmentProof, type CollabAuthorityRelinquishmentProofSigningPayload, type CollabAuthorityTransferStatus, type CollabCloudAuthorityTransferArtifact, decodeCollabProjectCheckpointManifest, encodeCollabAuthorityRelinquishmentProofSigningInput, encodeCollabProjectCheckpointManifestCanonicalJson } from '@claudian-collab/protocol';
import { CollabFixtureSnapshot } from '@test/helpers/collab/CollabFixtureSnapshot';
import type { TEST_INSTALLATION_B } from '@test/helpers/installations';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import { advancingTestClock, testClock, testDate, testTime } from '@test/helpers/testClock';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { ClaudianCollabService, CollabProjectSetupService, createCollabFeatureSubcomposition as createProductionFeatureSubcomposition } from '@/app/collab';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { AuthorityTransferLocalConvergence } from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import { authorityTransferChildIdempotencyKey } from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import { createAuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import { createAuthorityTransferCheckpointManifest } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointManifest';
import { createCloudToLanTargetEntry, handoffCloudToLanTargetEntry, publishCloudToLanTargetEntry } from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
import { ProductionCloudToLanTargetEffects } from '@/app/collab/authority-transfer/cloud-to-lan/ProductionCloudToLanTargetEffects';
import { ProductionLanToCloudSourceEffects } from '@/app/collab/authority-transfer/lan-to-cloud/ProductionLanToCloudSourceEffects';
import { rotateAuthorityTransferOrigin } from '@/app/collab/git/CollabGitOriginPolicy';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import { LanAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import { listPrivateIpv4Addresses } from '@/app/collab/lan/LanHostCoordinator';
import type { CloudAuthorityConnection } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { cloudProjectGitRemoteUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';

export const PROJECT_ID = 'project-production-effects';

export const MEMBER_ID = 'member-production-host';

export const TRANSFER_ID = 'transfer-production-effects';

export const OPERATION_ID = 'intent-production-effects';

export const HOST_CREDENTIAL = Buffer.alloc(32, 7).toString('base64url');

export const CLOUD_RECEIPT_KEYS = generateKeyPairSync('ed25519');

export const CLOUD_RECEIPT_PUBLIC_KEY = (
  CLOUD_RECEIPT_KEYS.publicKey.export({ format: 'jwk' }) as JsonWebKey
).x!;

export function cloudReceiptVerifier() {
  return {
    projectId: PROJECT_ID,
    receiptKeyId: 'receipt-key-production-cloud',
    receiptPublicKey: CLOUD_RECEIPT_PUBLIC_KEY,
    receiptPublicKeyEncoding: 'base64url-raw' as const,
    signatureAlgorithm: 'ed25519' as const,
    transferId: TRANSFER_ID,
  };
}

export function signCloudRelinquishmentProof(
  payload: CollabAuthorityRelinquishmentProofSigningPayload,
): CollabAuthorityRelinquishmentProof {
  return {
    ...payload,
    certificate: sign(
      null,
      Buffer.from(encodeCollabAuthorityRelinquishmentProofSigningInput(payload), 'utf8'),
      CLOUD_RECEIPT_KEYS.privateKey,
    ).toString('base64url'),
  };
}

export function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

export function status(
  direction: 'cloud-to-lan' | 'lan-to-cloud',
  phase: CollabAuthorityTransferStatus['phase'],
  targetUrl: string,
  checkpointSha256: string | null = null,
  cloudGeneration = 2,
): CollabAuthorityTransferStatus {
  return {
    batchRevision: null,
    batchSha256: null,
    checkpointSha256,
    createdAt: testTime({ days: 1 }),
    direction,
    expiresAt: testTime({ days: 31 }),
    phase,
    projectId: PROJECT_ID,
    relinquishmentProof: null,
    sourceAuthority: direction === 'lan-to-cloud'
      ? { generation: 1, kind: 'lan' }
      : { generation: cloudGeneration, kind: 'cloud' },
    state: 'active',
    targetAuthority: direction === 'lan-to-cloud'
      ? { generation: 2, kind: 'cloud' }
      : { generation: cloudGeneration + 1, kind: 'lan' },
    targetUrl,
    transferId: TRANSFER_ID,
    updatedAt: phase === 'collecting-readiness'
      ? testTime({ days: 1 })
      : testTime({ days: 1, minutes: 1 }),
  };
}

export function productionAuthorityTransferFixture() {
  // All participants use the same executable. Reuse its real capability probe,
  // while every participant still owns fresh repositories, processes and state.
  const gitRuntimeResolver = new GitRuntimeResolver();
  let SQL: SqlJsStatic;
  let sourceRoot: string;
  let sourceSnapshot: CollabFixtureSnapshot;
  let targetRoot: string;
  let cloudSourceSnapshot: CollabFixtureSnapshot | undefined;
  let cloudSource: Omit<Awaited<ReturnType<typeof prepareCloudSource>>, 'sourceFeature' | 'sourceFoundation'> | undefined;
  const foundations = new Set<ClaudianCollabService>();
  const features = new Set<ReturnType<typeof createProductionFeatureSubcomposition>['feature']>();

  beforeAll(async () => {
    SQL = await initSqlJs();
    sourceRoot = await mkdtemp(path.join(tmpdir(), 'claudian-transfer-source-'));
    targetRoot = await mkdtemp(path.join(tmpdir(), 'claudian-transfer-target-'));
    await rm(targetRoot, { recursive: true });
    const { sourceFoundation, sourceFeature } = sourceParticipant();
    try {
      await sourceFeature.initialize();
      const created = await sourceFeature.createProject({ memberDisplayName: 'Alice', name: 'Portable' });
      if (created.status !== 'success') throw new Error(`Source fixture creation failed: ${created.status}`);
    } finally {
      await sourceFeature.close();
      features.delete(sourceFeature);
      await sourceFoundation.close();
      foundations.delete(sourceFoundation);
    }
    sourceSnapshot = await CollabFixtureSnapshot.capture(sourceRoot);
    await rm(sourceRoot, { force: true, recursive: true });
  });

  beforeEach(async () => {
    await mkdir(sourceRoot);
    await mkdir(targetRoot);
  });

  async function closeParticipants() {
    const closedFeatures = await Promise.allSettled([...features].map(feature => feature.close()));
    features.clear();
    const closedFoundations = await Promise.allSettled([...foundations].map(service => service.close()));
    foundations.clear();
    const errors = [...closedFeatures, ...closedFoundations]
      .filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Transfer fixture cleanup failed');
  }

  afterEach(async () => {
    try {
      await closeParticipants();
    } finally {
      jest.restoreAllMocks();
      await Promise.all([
        rm(sourceRoot, { force: true, recursive: true }),
        rm(targetRoot, { force: true, recursive: true }),
      ]);
    }
  });

  afterAll(async () => {
    await sourceSnapshot?.dispose();
    await cloudSourceSnapshot?.dispose();
    if (sourceRoot) await rm(sourceRoot, { force: true, recursive: true });
    if (targetRoot) await rm(targetRoot, { force: true, recursive: true });
  });

  function sourceParticipant() {
    const sourceFoundation = foundation(sourceRoot);
    const sourceSetup = new CollabProjectSetupService(sourceFoundation, {
      installationKey: TEST_INSTALLATION_A,
      createCredential: () => HOST_CREDENTIAL,
      createId: kind => {
        if (kind === 'member') return MEMBER_ID;
        if (kind === 'operation') return 'create-production-effects';
        return PROJECT_ID;
      },
      now: testClock({ days: -19 }),
      vaultRoot: sourceRoot,
    });
    const sourceFeature = createCollabFeatureSubcomposition({
      foundation: sourceFoundation,
      projectSetup: sourceSetup,
      vaultRoot: sourceRoot,
    }).feature;
    return { sourceFoundation, sourceFeature };
  }

  async function captureSource(includePeer = true, departedStatus?: 'left' | 'revoked') {
    // Reuse project creation, not transfer effects or recovery state. Keep the
    // same path/installation identity and construct fresh owners after restore.
    await sourceSnapshot.restore();
    const { sourceFoundation, sourceFeature } = sourceParticipant();
    await sourceFeature.initialize();
    const sourceAuthority = await sourceFoundation.openAuthority(PROJECT_ID);
    if (includePeer) {
      await sourceAuthority.database.mutate(connection => {
        connection.run(`
          INSERT INTO members (
            member_id, display_name, personal_ref, role, status, credential_hash,
            join_attempt_id, created_at, activated_at, revoked_at
          ) VALUES (
            'member-production-peer', 'Bob',
            'refs/heads/members/member-production-peer', 'member', 'active', ?,
            NULL, '${testTime({ days: -19 })}', '${testTime({ days: -19 })}', NULL
          )
        `, [Buffer.alloc(32, 8)]);
      });
      const sourceAuthorityRepository = path.join(sourceAuthority.authorityDirectory, 'repository.git');
      const authorityMainOid = git(sourceAuthorityRepository, ['rev-parse', 'refs/heads/main']);
      git(sourceAuthorityRepository, [
        'update-ref',
        'refs/heads/members/member-production-peer',
        authorityMainOid,
      ]);
    }
    if (departedStatus) {
      await sourceAuthority.database.mutate(connection => {
        connection.run(`
          INSERT INTO members (
            member_id, display_name, personal_ref, role, status, credential_hash,
            join_attempt_id, created_at, activated_at, revoked_at
          ) VALUES (
            'member-departed', 'Departed', 'refs/heads/members/member-departed',
            'member', ?, ?, NULL, '${testTime({ days: -19 })}',
            '${testTime({ days: -19 })}', '${testTime({ days: -19 })}'
          )
        `, [departedStatus, Buffer.alloc(32, 9)]);
      });
      const repository = path.join(sourceAuthority.authorityDirectory, 'repository.git');
      git(repository, ['update-ref', 'refs/heads/members/member-departed',
        git(repository, ['rev-parse', 'refs/heads/main'])]);
    }
    const sourceMembership = await sourceFoundation.local.projects.loadMembership(PROJECT_ID);
    if (!sourceMembership || sourceMembership.authority.kind !== 'lan') {
      throw new Error('Missing source LAN membership');
    }
    const sourceRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('lan-to-cloud', 'collecting-readiness', 'https://cloud.example.test/'),
    });
    const noopSession = {
      principalId: 'vault-source-credential',
      projectId: PROJECT_ID,
    } as unknown as CloudAuthorityConnection;
    const sourceEffects = new ProductionLanToCloudSourceEffects({
      cloudSession: noopSession,
      convergence: {} as AuthorityTransferLocalConvergence,
      foundation: sourceFoundation,
      persistence: sourceFoundation.authorityTransfers,
      projectId: PROJECT_ID,
    });
    const sourceStaging = await sourceFoundation.local.workspace.reserveProjectsFolderChild(
      'workspace',
      {
        childName: sourceRecord.stagingDirectoryName,
        operationId: sourceRecord.transferId,
        projectId: sourceRecord.projectId,
        purpose: 'authority-transfer-staging',
      },
    );
    const interruptedPromotions = [
      'checkpoint.json.partial',
      'source-proof-key.json.partial',
      'source-proof.json.partial',
      'relinquishment-proof.json.partial',
    ];
    await mkdir(sourceStaging.absolutePath, { mode: 0o700 });
    await Promise.all(interruptedPromotions.map(fileName => writeFile(
      path.join(sourceStaging.absolutePath, fileName),
      '{"truncated":',
      { mode: 0o600 },
    )));
    const captured = await sourceEffects.capture(sourceRecord);
    const sourceProofEnvelope = JSON.parse(Buffer.from(
      captured.sourceProof,
      'base64url',
    ).toString('utf8')) as {
      readonly caCertificatePem: string;
      readonly certificate: string;
      readonly payload: { readonly sourcePrincipalId: string };
      readonly receiptKeyId: string;
      readonly receiptPublicKey: string;
      readonly schemaVersion: number;
    };
    expect(sourceProofEnvelope).toMatchObject({
      payload: { sourcePrincipalId: 'vault-source-credential' },
      schemaVersion: 2,
    });
    const { caCertificatePem, certificate, ...sourceProofSigningPayload } = sourceProofEnvelope;
    expect(verify(
      'sha256',
      Buffer.from(JSON.stringify(sourceProofSigningPayload), 'utf8'),
      {
        key: caCertificatePem,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      Buffer.from(certificate, 'base64url'),
    )).toBe(true);
    await Promise.all(interruptedPromotions.slice(0, 3).map(fileName => expect(
      access(path.join(sourceStaging.absolutePath, fileName)),
    ).rejects.toMatchObject({ code: 'ENOENT' })));
    const artifactBytes = new Map<CollabCloudAuthorityTransferArtifact, Buffer>();
    for (const artifact of captured.artifacts) {
      const chunks: Buffer[] = [];
      for await (const chunk of artifact.body) chunks.push(Buffer.from(chunk as Uint8Array));
      artifactBytes.set(artifact.artifact, Buffer.concat(chunks));
    }
    const sourceManifestBytes = artifactBytes.get('checkpoint.json');
    const sourceCoordinationBytes = artifactBytes.get('coordination.ndjson');
    const repositoryBytes = artifactBytes.get('repository.bundle');
    if (!sourceManifestBytes || !sourceCoordinationBytes || !repositoryBytes) {
      throw new Error('Incomplete source checkpoint');
    }
    await sourceFoundation.lanHost.relinquishProjectForAuthorityTransfer(PROJECT_ID);
    const recoveryRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('lan-to-cloud', 'source-quiesced', 'https://cloud.example.test/'),
    });
    return {
      artifactBytes,
      recoveryRecord,
      repositoryBytes,
      sourceCoordinationBytes,
      sourceEffects,
      sourceFeature,
      sourceFoundation,
      sourceManifestBytes,
      sourceMembership,
      sourceRecord,
      sourceStaging,
    };
  }

  async function prepareCloudSource() {
    const {
      artifactBytes,
      recoveryRecord,
      repositoryBytes,
      sourceCoordinationBytes,
      sourceEffects,
      sourceFeature,
      sourceFoundation,
      sourceManifestBytes,
      sourceMembership,
      sourceRecord,
      sourceStaging,
    } = await captureSource();
    const recoveredCapture = await sourceEffects.capture(recoveryRecord);
    const recoveredManifestChunks: Buffer[] = [];
    for await (const chunk of recoveredCapture.artifacts[0].body) {
      recoveredManifestChunks.push(Buffer.from(chunk as Uint8Array));
    }
    recoveredCapture.artifacts.slice(1).forEach(artifact => artifact.body.destroy());
    expect(Buffer.concat(recoveredManifestChunks)).toEqual(sourceManifestBytes);
    const sourceManifest = decodeCollabProjectCheckpointManifest(
      JSON.parse(sourceManifestBytes.toString('utf8')),
    );
    const fenceStatus: CollabAuthorityTransferStatus = {
      ...status(
        'lan-to-cloud',
        'claims-retained',
        'https://cloud.example.test/',
        sourceManifest.manifestSha256,
      ),
      batchRevision: 1,
      batchSha256: 'b'.repeat(64),
    };
    await sourceEffects.commitRelinquishmentFence(createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'source',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: sourceRecord.stagingDirectoryName,
      status: fenceStatus,
    }));
    await expect(access(path.join(
      sourceStaging.absolutePath,
      'relinquishment-proof.json.partial',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    return {
      artifactBytes, repositoryBytes, sourceCoordinationBytes, sourceManifest,
      sourceMembership, sourceFeature, sourceFoundation,
    };
  }

  async function restoreCloudSource() {
    // Target scenarios consume the same committed checkpoint. Source scenarios
    // still call captureSource directly and exercise fresh capture/recovery.
    if (!cloudSource) {
      const { sourceFeature, sourceFoundation, ...prepared } = await prepareCloudSource();
      await sourceFeature.close();
      features.delete(sourceFeature);
      await sourceFoundation.close();
      foundations.delete(sourceFoundation);
      cloudSourceSnapshot = await CollabFixtureSnapshot.capture(sourceRoot);
      cloudSource = prepared;
    } else {
      await cloudSourceSnapshot!.restore();
    }
    const participant = sourceParticipant();
    await participant.sourceFeature.initialize();
    return {
      ...cloudSource,
      ...participant,
      artifactBytes: new Map([...cloudSource.artifactBytes].map(([name, bytes]) => [name, Buffer.from(bytes)])),
    };
  }

  async function prepareCloudToLanTarget(moveAddress = false, cloudGeneration = 2) {
    const {
      artifactBytes, repositoryBytes, sourceCoordinationBytes, sourceManifest,
      sourceMembership, sourceFeature, sourceFoundation,
    } = await restoreCloudSource();
    const records = sourceCoordinationBytes.toString('utf8').trimEnd().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const project = records[0] as { value: Record<string, unknown> };
    project.value.authorityGeneration = cloudGeneration;
    const targetCoordinationBytes = Buffer.from(
      `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
    const targetManifest = createAuthorityTransferCheckpointManifest({
      artifacts: [
        {
          byteCount: targetCoordinationBytes.byteLength,
          name: 'coordination.ndjson',
          sha256: createHash('sha256').update(targetCoordinationBytes).digest('hex'),
        },
        {
          byteCount: repositoryBytes.byteLength,
          name: 'repository.bundle',
          sha256: createHash('sha256').update(repositoryBytes).digest('hex'),
        },
      ],
      createdAt: sourceManifest.createdAt,
      expectedMainOid: sourceManifest.expectedMainOid,
      gitObjectFormat: sourceManifest.gitObjectFormat,
      operationId: TRANSFER_ID,
      projectId: PROJECT_ID,
      refs: sourceManifest.refs,
      sourceAuthority: { generation: cloudGeneration, kind: 'cloud' },
      targetAuthority: { generation: cloudGeneration + 1, kind: 'lan' },
    });
    artifactBytes.set('coordination.ndjson', targetCoordinationBytes);
    artifactBytes.set(
      'checkpoint.json',
      Buffer.from(encodeCollabProjectCheckpointManifestCanonicalJson(targetManifest), 'utf8'),
    );

    const environment = {
      addresses: moveAddress ? ['127.0.0.1'] : listPrivateIpv4Addresses(),
      beforeConvergence: null as (() => Promise<void>) | null,
      now: testDate({ days: 1, minutes: 3 }),
    };
    let checkTargetAddress: () => Promise<void> = async () => undefined;
    const createTargetFoundation = () => foundation(targetRoot, TEST_INSTALLATION_A, {
      createAddressMonitor: check => { checkTargetAddress = check; return { close: () => undefined }; },
      getPrivateIpv4Addresses: () => environment.addresses,
    });
    let targetFoundation = createTargetFoundation();
    await targetFoundation.local.workspace.claimProjectsFolder('workspace');
    const cloudServerUrl = 'https://cloud.example.test/';
    git(targetRoot, [
      'clone',
      '--quiet',
      path.join(sourceRoot, 'workspace', 'portable'),
      path.join(targetRoot, 'workspace', 'portable'),
    ]);
    git(path.join(targetRoot, 'workspace', 'portable'), [
      'remote',
      'set-url',
      'origin',
      cloudProjectGitRemoteUrl(cloudServerUrl, PROJECT_ID),
    ]);
    await targetFoundation.local.projects.saveMembership({
      authority: {
        authorityGeneration: cloudGeneration,
        bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
        gitRemoteUrl: cloudProjectGitRemoteUrl(cloudServerUrl, PROJECT_ID),
        kind: 'cloud',
        serverUrl: cloudServerUrl,
        wireVersion: COLLAB_PROTOCOL_VERSION,
      },
      createdAt: sourceMembership.createdAt,
      lastEventSequence: 0,
      member: {
        displayName: 'Bob',
        id: 'member-production-peer',
        personalRef: 'refs/heads/members/member-production-peer',
        role: 'member',
      },
      project: sourceMembership.project,
      schemaVersion: sourceMembership.schemaVersion,
      updatedAt: sourceMembership.updatedAt,
    });
    const cloudSession = {
      dispose: jest.fn(),
      projectId: PROJECT_ID,
      readSnapshot: jest.fn(async () => {
        throw new Error('post-begin ordinary Cloud snapshot must stay closed');
      }),
      serverUrl: cloudServerUrl,
    } as unknown as CloudAuthorityConnection;
    const initialGitFoundation = await targetFoundation.requireGitFoundation();
    await initialGitFoundation.repositories.configureLocalRepository(
      path.join(targetRoot, 'workspace', 'portable'),
      {
        memberId: 'member-production-peer',
        personalRef: 'refs/heads/members/member-production-peer',
        projectId: PROJECT_ID,
        userDisplayName: 'Bob',
      },
    );
    const createRecoveryConvergence = async () => {
      const gitFoundation = await targetFoundation.requireGitFoundation();
      return new AuthorityTransferLocalConvergence({
      settleLocalAuthorityAdvance: identity => targetFoundation.authorityTransfers.settleLocalAuthorityAdvance(identity),
        activity: { transitionProject: async (_projectId, operation) => {
          await environment.beforeConvergence?.();
          await operation();
        } },
        authorityProjectionTransitions: {
          run: (projectId, operation) => targetFoundation.runAuthorityProjectionTransition(
            projectId,
            operation,
          ),
        },
        git: {
          rotate: input => rotateAuthorityTransferOrigin(gitFoundation.repositories, input),
        },
        projects: targetFoundation.local.projects,
        workspace: targetFoundation.local.workspace,
      });
    };
    const convergence = await createRecoveryConvergence();
    let recoveryConvergence = convergence;
    const activeRouteTransition = jest.spyOn(
      targetFoundation.lanHost,
      'transitionAuthorityTransferRoute',
    );
    const targetEffects = new ProductionCloudToLanTargetEffects({
      cloudSession,
      convergence,
      foundation: targetFoundation,
      now: () => environment.now,
      persistence: targetFoundation.authorityTransfers,
      projectId: PROJECT_ID,
    });
    const prepared = await targetEffects.prepareTarget();
    if (moveAddress) {
      environment.addresses = listPrivateIpv4Addresses();
      if (environment.addresses.length === 0) throw new Error('A private address is required for transfer recovery');
      await checkTargetAddress();
    }
    const proposed = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: `.claudian-authority-transfer-${TRANSFER_ID}`,
      status: status('cloud-to-lan', 'collecting-readiness', prepared.targetUrl, null, cloudGeneration),
    });
    const targetStaging = await targetFoundation.local.workspace.reserveProjectsFolderChild(
      'workspace',
      {
        childName: proposed.stagingDirectoryName,
        operationId: proposed.transferId,
        projectId: proposed.projectId,
        purpose: 'authority-transfer-staging',
      },
    );
    const interruptedTargetState = path.join(
      targetStaging.absolutePath,
      'target-private.json.partial',
    );
    await mkdir(targetStaging.absolutePath, { mode: 0o700 });
    await writeFile(interruptedTargetState, '{"truncated":', { mode: 0o600 });
    const acceptance = await targetEffects.acceptanceRequest(proposed);
    expect(acceptance.targetHostMemberId).toBe('member-production-peer');
    await expect(access(interruptedTargetState)).rejects.toMatchObject({ code: 'ENOENT' });
    const stagedRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_ID,
      stagingDirectoryName: proposed.stagingDirectoryName,
      status: status(
        'cloud-to-lan',
        'checkpoint-captured',
        prepared.targetUrl,
        targetManifest.manifestSha256,
        cloudGeneration,
      ),
    });
    const stageArtifacts = () => [
      'checkpoint.json',
      'coordination.ndjson',
      'repository.bundle',
    ].map((artifact) => {
      const typed = artifact as CollabCloudAuthorityTransferArtifact;
      const bytes = artifactBytes.get(typed);
      if (!bytes) throw new Error(`Missing ${artifact}`);
      return { artifact: typed, body: Readable.from([bytes]), byteCount: bytes.byteLength };
    });
    return {
      createRecoveryConvergence,
      prepared,
      activeRouteTransition,
      checkAddress: () => checkTargetAddress(),
      cloudSession,
      environment,
      get foundation() { return targetFoundation; },
      recoveringEffects: () => new ProductionCloudToLanTargetEffects({
        cloudSession: null,
        convergence: recoveryConvergence,
        foundation: targetFoundation,
        now: () => environment.now,
        persistence: targetFoundation.authorityTransfers,
        projectId: PROJECT_ID,
      }),
      restart: async () => {
        await targetFoundation.close();
        targetFoundation = createTargetFoundation();
        recoveryConvergence = await createRecoveryConvergence();
      },
      requireAuthority: async () => {
        const authority = await targetFoundation.inspectAuthority(PROJECT_ID);
        if (!authority) throw new Error('Missing imported target authority');
        return authority;
      },
      sourceFeature,
      sourceFoundation,
      stageArtifacts,
      stagedRecord,
      targetEffects,
      targetManifest,
      targetStaging,
    };
  }

  async function stageCloudToLanTarget(preparedTarget?: Awaited<ReturnType<typeof prepareCloudToLanTarget>>) {
    const target = preparedTarget ?? await prepareCloudToLanTarget();
    const {
      foundation: targetFoundation, prepared, stageArtifacts, stagedRecord,
      targetEffects, targetManifest,
    } = target;
    const staged = await targetEffects.stage(stagedRecord, stageArtifacts());

    expect(staged.checkpointSha256).toBe(targetManifest.manifestSha256);
    expect(staged.claimBatch.claims).toEqual([
      expect.objectContaining({ memberId: MEMBER_ID }),
    ]);
    await targetFoundation.local.projects.authorityTransferRecords.save(stagedRecord);
    const targetStageOperationIntentId = authorityTransferChildIdempotencyKey(
      OPERATION_ID,
      'stage',
    );
    const retainedTargetClaims = await targetFoundation.authorityTransfers.retainClaimBatch({
      batch: staged.claimBatch,
      operationIntentId: targetStageOperationIntentId,
      purpose: 'target-delivery',
    });
    await targetFoundation.authorityTransfers.acknowledgeClaimBatch({
      batchRevision: staged.claimBatch.batchRevision,
      batchSha256: staged.claimBatch.batchSha256,
      checkpointSha256: staged.claimBatch.checkpointSha256,
      committedAt: retainedTargetClaims.createdAt,
      custodyAuthority: { generation: 2, kind: 'cloud' },
      operationIntentId: targetStageOperationIntentId,
      projectId: PROJECT_ID,
      receiptId: 'custody-receipt-production-target',
      submittedByMemberId: 'member-production-peer',
      targetAuthorityGeneration: 3,
      transferId: TRANSFER_ID,
    });
    const targetAuthority = await targetFoundation.inspectAuthority(PROJECT_ID);
    expect(targetAuthority).toBeNull();
    await expect(access(path.join(
      targetRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
      '.claudian-authority.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    const relinquishmentProof = signCloudRelinquishmentProof({
      batchRevision: staged.claimBatch.batchRevision,
      batchSha256: staged.claimBatch.batchSha256,
      certificateAlgorithm: 'ed25519' as const,
      checkpointSha256: staged.checkpointSha256,
      committedAt: testTime({ days: 1, minutes: 2 }),
      operationIntentId: 'intent-cloud-relinquishment',
      projectId: PROJECT_ID,
      sourceAuthority: { generation: 2, kind: 'cloud' as const },
      sourceHostMemberId: null,
      targetAuthority: { generation: 3, kind: 'lan' as const },
      transferId: TRANSFER_ID,
    });
    const completedStatus: CollabAuthorityTransferStatus = {
      ...status(
        'cloud-to-lan',
        'completed',
        stagedRecord.status.targetUrl,
        staged.checkpointSha256,
      ),
      batchRevision: staged.claimBatch.batchRevision,
      batchSha256: staged.claimBatch.batchSha256,
      phase: 'completed',
      relinquishmentProof,
      state: 'completed',
      updatedAt: testTime({ days: 1, minutes: 3 }),
    };
    const completedRecord = createAuthorityTransferRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
      lifecycleOwnership: 'owned',
      localRole: 'target',
      operationIntentId: OPERATION_ID,
      receiptVerifier: cloudReceiptVerifier(),
      stagingDirectoryName: stagedRecord.stagingDirectoryName,
      status: completedStatus,
    });
    await targetFoundation.local.projects.authorityTransferRecords.save(completedRecord);
    const targetEntry = publishCloudToLanTargetEntry(createCloudToLanTargetEntry({
      createdAt: testTime({ days: 1 }),
      expiresAt: completedStatus.expiresAt,
      operationIntentId: 'intent-production-target-preparation',
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      selectedTargetMemberId: 'member-production-peer',
      selectedTargetPersonalRef: 'refs/heads/members/member-production-peer',
      sourceAuthorityGeneration: 2,
      sourceCloudUrl: 'https://cloud.example.test/',
    }), {
      caCertificatePem: prepared.caCertificatePem,
      caFingerprint: prepared.caFingerprint,
      publishedAt: testTime({ days: 1, seconds: 30 }),
      targetUrl: stagedRecord.status.targetUrl,
    });
    await targetFoundation.local.projects.authorityTransferEntries.saveTarget(
      handoffCloudToLanTargetEntry(targetEntry, completedRecord),
    );
    return Object.assign(target, {
      completedRecord, relinquishmentProof, staged, targetEntry,
      targetStatePath: path.join(target.targetStaging.absolutePath, 'target-private.json'),
    });
  }

  async function activateCloudToLanTarget(stagedTarget?: Awaited<ReturnType<typeof stageCloudToLanTarget>>) {
    const target = stagedTarget ?? await stageCloudToLanTarget();
    await target.targetEffects.activate(target.completedRecord, target.relinquishmentProof);
    const targetAuthority = await target.requireAuthority();
    expect(JSON.parse(await readFile(path.join(
      targetRoot,
      '.claudian',
      'collab',
      'authorities',
      PROJECT_ID,
      '.claudian-authority.json',
    ), 'utf8'))).toEqual({
      ownerInstallationKey: TEST_INSTALLATION_A,
      projectId: PROJECT_ID,
      resourceId: expect.any(String),
      operation: { kind: 'authority-transfer', operationId: OPERATION_ID, transferId: TRANSFER_ID, sourceGeneration: 2, targetGeneration: 3 },
      schemaVersion: 3,
    });
    return Object.assign(target, { targetAuthority });
  }

  async function restoreStoppedCloudToLanTarget(moveAddress = false) {
    const target = await activateCloudToLanTarget(
      await stageCloudToLanTarget(await prepareCloudToLanTarget(moveAddress)),
    );
    await target.recoveringEffects().restoreCompleted(target.completedRecord);
    await target.foundation.lanHost.stopProject(PROJECT_ID);
    const exactTargetState = await readFile(target.targetStatePath, 'utf8');
    if (moveAddress) target.environment.addresses = ['127.0.0.1'];
    await target.restart();
    const preRecoveryMembership = await target.foundation.local.projects.loadMembership(PROJECT_ID);
    if (!preRecoveryMembership || preRecoveryMembership.authority.kind !== 'lan') {
      throw new Error('Missing pre-recovery target membership');
    }
    await expect(target.foundation.lanHost.hostCaSigner()).resolves.toMatchObject({
      caCertificatePem: preRecoveryMembership.authority.hostCaCertificatePem,
      caFingerprint: preRecoveryMembership.authority.hostCaFingerprint,
    });
    await expect(readFile(target.targetStatePath, 'utf8')).resolves.toBe(exactTargetState);
    const recoveredRouteStart = jest.spyOn(
      target.foundation.lanHost,
      'startAuthorityTransferRoute',
    );
    const restartedComposition = createCollabFeatureSubcomposition({
      foundation: target.foundation,
      projectSetup: new CollabProjectSetupService(target.foundation, {
        installationKey: TEST_INSTALLATION_A,
        vaultRoot: targetRoot,
      }),
      vaultRoot: targetRoot,
    });
    await restartedComposition.feature.initialize();
    await expect(restartedComposition.feature.restoreLifecycle()).resolves.toBeUndefined();
    target.targetAuthority = await target.requireAuthority();
    const recoveredRegistration = recoveredRouteStart.mock.calls.find(
      ([registration]) => registration.state === 'target-active',
    )?.[0];
    if (recoveredRegistration?.state !== 'target-active') {
      throw new Error('Missing recovered Cloud-to-LAN target route');
    }

    expect(target.foundation.lanHost.isProjectRunning(PROJECT_ID)).toBe(false);
    await expect(target.foundation.local.projects.loadMembership(PROJECT_ID))
      .resolves.toMatchObject({
        hostOwnership: { autoStart: false, ownsAuthority: true },
      });
    const claimantCredential = Buffer.alloc(32, 9).toString('base64url');
    const claim = target.staged.claimBatch.claims[0];
    if (!claim) throw new Error('Missing transferred Member claim');
    const recoveredRoute = await target.foundation.lanHost.startAuthorityTransferRoute(recoveredRegistration);
    if (moveAddress) {
      expect(new URL(recoveredRoute.endpoint).hostname).toBe('127.0.0.1');
      expect(recoveredRoute.endpoint).not.toBe(preRecoveryMembership.authority.endpoint);
    }
    const claimClient = new LanAuthorityTransferClient({
      authorityGeneration: 3,
      caCertificatePem: preRecoveryMembership.authority.hostCaCertificatePem!,
      caFingerprint: preRecoveryMembership.authority.hostCaFingerprint!,
      endpoint: preRecoveryMembership.authority.endpoint!,
      projectId: PROJECT_ID,
    }, {
      discovery: { discoverProjectCandidates: async () => [recoveredRoute] },
    });
    const claimRequest = {
      claim: claim.claim,
      credentialHash: createHash('sha256')
        .update(claimantCredential, 'utf8')
        .digest('hex'),
      idempotencyKey: 'claim-production-manager',
      projectId: PROJECT_ID,
      transferId: TRANSFER_ID,
    };
    const firstReceipt = await claimClient.claimTransferredMembership(claimRequest);
    const replayedReceipt = await claimClient.claimTransferredMembership(claimRequest);
    expect(replayedReceipt).toEqual(firstReceipt);
    expect(firstReceipt.memberId).toBe(MEMBER_ID);
    expect(await target.targetAuthority?.database.read(connection => connection.get(`
      SELECT access_state, credential_hash
      FROM members
      WHERE member_id = '${MEMBER_ID}'
    `))).toEqual({
      access_state: 'bound',
      credential_hash: createHash('sha256')
        .update(claimantCredential, 'utf8')
        .digest(),
    });
    return Object.assign(target, {
      claimClient, claimRequest, firstReceipt, recoveredRegistration, restartedComposition,
    });
  }

  function createCollabFeatureSubcomposition(
    options: Parameters<typeof createProductionFeatureSubcomposition>[0],
  ): ReturnType<typeof createProductionFeatureSubcomposition> {
    const composition = createProductionFeatureSubcomposition(options);
    features.add(composition.feature);
    return composition;
  }

  function foundation(
    vaultRoot: string,
    installationKey: typeof TEST_INSTALLATION_A | typeof TEST_INSTALLATION_B = TEST_INSTALLATION_A,
    lanHost?: ConstructorParameters<typeof ClaudianCollabService>[0]['lanHost'],
  ): ClaudianCollabService {
    const service = new ClaudianCollabService({
      createAuthorityDatabase: (authorityDirectory, resourceAdmission) => (
        new SqlJsProjectDatabase(authorityDirectory, { resourceAdmission, loadSqlJs: async () => SQL })
      ),
      getConfiguredGitPath: () => '',
      gitRuntimeResolver,
      installationKey,
      ...(lanHost ? { lanHost } : {}),
      now: advancingTestClock({ days: 1, minutes: 3 }),
      obsidianConfigDirectory: '.obsidian',
      vaultRoot,
    });
    foundations.add(service);
    return service;
  }

  return {
    get sourceRoot() { return sourceRoot; },
    get targetRoot() { return targetRoot; },
    captureSource,
    closeParticipants,
    prepareCloudToLanTarget,
    stageCloudToLanTarget,
    activateCloudToLanTarget,
    restoreStoppedCloudToLanTarget,
    createCollabFeatureSubcomposition,
    foundation,
  };
}
