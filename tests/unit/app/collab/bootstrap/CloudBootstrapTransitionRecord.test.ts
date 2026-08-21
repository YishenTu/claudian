import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
} from '@claudian/collab-protocol';

import {
  createCloudBootstrapTransitionRecord,
  decodeCloudBootstrapTransitionRecord,
  markCloudBootstrapTerminalCleanupCompleted,
  observeCloudBootstrapAttemptStatus,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';

import {
  ATTEMPT_ID,
  bootstrapManifest,
  HOST_MEMBER_ID,
  HOST_OID,
  MANIFEST_SHA256,
  OTHER_MEMBER_ID,
  PROJECT_ID,
} from './fixtures';

describe('CloudBootstrapTransitionRecord', () => {
  it('stores only exact safe transition identity while binding remains pending', () => {
    const record = createCloudBootstrapTransitionRecord({
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-one',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'https://cloud.example.test',
      timestamp: '2026-08-21T00:00:01.000Z',
    });

    expect(record).toEqual({
      activationResult: null,
      attemptId: ATTEMPT_ID,
      attemptState: 'pending',
      createdAt: '2026-08-21T00:00:01.000Z',
      developmentActorId: HOST_MEMBER_ID,
      fence: {
        fenceId: 'bootstrap-fence-one',
        state: 'active',
        stoppedAt: null,
      },
      kind: 'cloud-bootstrap-transition',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      newAuthority: {
        bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
        gitRemoteUrl: `https://cloud.example.test/v1/projects/${PROJECT_ID}/repository.git`,
        serverUrl: 'https://cloud.example.test/',
        wireVersion: COLLAB_PROTOCOL_VERSION,
      },
      oldAuthority: {
        caFingerprint: 'b'.repeat(64),
        endpoint: 'https://192.168.1.20:54545/',
        gitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
        sourceHostMemberId: HOST_MEMBER_ID,
      },
      phase: 'intent',
      projectId: PROJECT_ID,
      repositoryIdentity: {
        mainOid: '1'.repeat(40),
        objectFormat: 'sha1',
        personalRef: 'refs/heads/members/member-alice',
        personalRefOid: HOST_OID,
      },
      schemaVersion: 1,
      terminalCleanupCompleted: false,
      updatedAt: '2026-08-21T00:00:01.000Z',
    });
    expect(JSON.stringify(record)).not.toContain('credential');
    expect(JSON.stringify(record)).not.toContain('CERTIFICATE');
    expect(decodeCloudBootstrapTransitionRecord(record)).toEqual(record);
  });

  it('rejects a persisted development actor that differs from the Member', () => {
    const input = {
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-one',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'https://cloud.example.test',
      timestamp: '2026-08-21T00:00:01.000Z' as const,
    };
    const record = createCloudBootstrapTransitionRecord(input);

    expect(() => createCloudBootstrapTransitionRecord({
      ...input,
      developmentActorId: OTHER_MEMBER_ID,
    })).toThrow(TypeError);
    expect(() => decodeCloudBootstrapTransitionRecord({
      ...record,
      developmentActorId: OTHER_MEMBER_ID,
    })).toThrow(TypeError);
  });

  it('permits only loopback HTTP for the local development Cloud composition', () => {
    const record = createCloudBootstrapTransitionRecord({
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-loopback',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'http://127.0.0.1:8787',
      timestamp: '2026-08-21T00:00:01.000Z',
    });

    expect(record.newAuthority).toMatchObject({
      gitRemoteUrl: `http://127.0.0.1:8787/v1/projects/${PROJECT_ID}/repository.git`,
      serverUrl: 'http://127.0.0.1:8787/',
    });
    expect(() => createCloudBootstrapTransitionRecord({
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-public-http',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'http://cloud.example.test',
      timestamp: '2026-08-21T00:00:01.000Z',
    })).toThrow(TypeError);
  });

  it.each([
    { phase: 'completed' },
    { attemptId: '../attempt' },
    { developmentActorId: 'actor with spaces' },
    { newAuthority: { bindingVersion: 1, gitRemoteUrl: 'https://evil.test/repository.git', serverUrl: 'https://cloud.example.test/', wireVersion: 4 } },
    { memberCredential: 'secret' },
    { fence: { fenceId: 'bootstrap-fence-one', state: 'released-before-activation', stoppedAt: null } },
  ])('rejects impossible, noncanonical, or secret-bearing pending state', override => {
    const record = createCloudBootstrapTransitionRecord({
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-one',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'https://cloud.example.test',
      timestamp: '2026-08-21T00:00:01.000Z',
    });
    expect(() => decodeCloudBootstrapTransitionRecord({
      ...record,
      ...override,
    })).toThrow(TypeError);
  });

  it('releases a durable pre-stop fence only after Cloud confirms cancellation', () => {
    const record = createCloudBootstrapTransitionRecord({
      developmentActorId: HOST_MEMBER_ID,
      fenceId: 'bootstrap-fence-one',
      manifest: bootstrapManifest(),
      manifestSha256: MANIFEST_SHA256,
      memberId: HOST_MEMBER_ID,
      oldEndpoint: 'https://192.168.1.20:54545',
      oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
      serverUrl: 'https://cloud.example.test',
      timestamp: '2026-08-21T00:00:01.000Z',
    });

    const cancelled = observeCloudBootstrapAttemptStatus(record, {
      attemptId: ATTEMPT_ID,
      bundleState: 'missing',
      cancellationPhase: 'cancelled',
      createdAt: '2026-08-21T00:00:00.000Z',
      expiresAt: '2026-08-22T00:00:00.000Z',
      manifestSha256: MANIFEST_SHA256,
      projectId: PROJECT_ID,
      reporterMemberIds: [],
      state: 'cancelled',
    }, '2026-08-21T00:00:02.000Z');
    expect(cancelled).toMatchObject({
      attemptState: 'cancelled',
      fence: {
        fenceId: 'bootstrap-fence-one',
        state: 'released-before-activation',
        stoppedAt: null,
      },
      terminalCleanupCompleted: false,
    });
    expect(markCloudBootstrapTerminalCleanupCompleted(
      cancelled,
      '2026-08-21T00:00:03.000Z',
    )).toMatchObject({ terminalCleanupCompleted: true });
    expect(() => markCloudBootstrapTerminalCleanupCompleted(
      record,
      '2026-08-21T00:00:03.000Z',
    )).toThrow(TypeError);
  });
});
