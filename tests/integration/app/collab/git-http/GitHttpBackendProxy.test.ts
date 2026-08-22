import { createHash, randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { ClientRequest } from 'node:http';
import {
  createServer,
  request as httpsRequest,
  type Server,
} from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { collabMemberRef, type CollabMemberStatus } from '@claudian/collab-protocol';

import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { type GitRuntime,GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import { GitHttpBackendProxy } from '@/app/collab/lan/GitHttpBackendProxy';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-alpha';
const MEMBER_ID = 'member-alice';
const CREDENTIAL = Buffer.alloc(32, 11).toString('base64url');

jest.setTimeout(60_000);

function authError(): CollabError {
  return new CollabError({
    code: 'authentication-failed',
    recoveryActions: ['request-access'],
    safeContext: { reason: 'test-authentication-failed' },
  });
}

async function withGitDiagnostics(
  operation: (setStage: (stage: string) => void) => Promise<void>,
): Promise<void> {
  let stage = 'test setup';
  try {
    await operation(nextStage => {
      stage = nextStage;
    });
  } catch (error) {
    if (error instanceof CollabError) {
      throw new Error(
        `Unexpected Git failure during ${stage}: ${error.code} ${JSON.stringify(error.safeContext)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

describe('GitHttpBackendProxy integration', () => {
  let authorityDirectory: string;
  let authenticationCalls: number;
  let backpressureCount: number;
  let bareRepositoryPath: string;
  let caCertificatePem: string;
  let emptyConfigPath: string;
  let forceBackpressure: boolean;
  let memberStatus: CollabMemberStatus;
  let network: {
    authorizationHeader: string;
    headers: readonly { readonly name: string; readonly value: string }[];
    sslCaInfoPath: string;
  };
  let proxy: GitHttpBackendProxy;
  let prepareBarrier: Promise<void> | null;
  let prepareStarted: boolean;
  let root: string;
  let runner: GitCommandRunner;
  let runtime: GitRuntime;
  let server: Server;
  let service: GitRepositoryService;
  let url: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-git-http-'));
    authenticationCalls = 0;
    backpressureCount = 0;
    forceBackpressure = false;
    prepareBarrier = null;
    prepareStarted = false;
    authorityDirectory = path.join(root, 'authority');
    bareRepositoryPath = path.join(authorityDirectory, 'repository.git');
    emptyConfigPath = path.join(root, 'empty.gitconfig');
    await mkdir(authorityDirectory);
    await writeFile(emptyConfigPath, '');
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available' || !resolution.runtime.httpBackendPath) {
      throw new Error('Native Git Smart HTTP is required for integration tests');
    }
    runtime = resolution.runtime;
    runner = new GitCommandRunner({
      emptyConfigPath,
      executablePath: runtime.executablePath,
    });
    service = new GitRepositoryService(runner);

    const sourcePath = path.join(root, 'source');
    await mkdir(sourcePath);
    await service.initializeWorkingRepository(sourcePath);
    await service.configureLocalRepository(sourcePath, {
      memberId: 'member-host',
      personalRef: collabMemberRef('member-host'),
      projectId: PROJECT_ID,
      userDisplayName: 'Host',
    });
    await writeFile(path.join(sourcePath, 'note.md'), 'initial\n');
    await service.stageAll(sourcePath);
    const initialOid = await service.createCommitFromIndex(sourcePath, {
      expectedRefOid: null,
      message: 'Initial project',
      parents: [],
      ref: 'refs/heads/main',
    });
    await mkdir(bareRepositoryPath);
    await service.initializeBareRepository(bareRepositoryPath);
    await service.addRemote(sourcePath, 'origin', bareRepositoryPath);
    await service.push(sourcePath, 'origin', 'refs/heads/main:refs/heads/main');
    await service.createRef(sourcePath, collabMemberRef(MEMBER_ID), initialOid);
    await service.push(
      sourcePath,
      'origin',
      `${collabMemberRef(MEMBER_ID)}:${collabMemberRef(MEMBER_ID)}`,
    );

    memberStatus = 'pending';
    proxy = new GitHttpBackendProxy({
      authorityDirectory,
      authenticateMemberCredential: async (credential, statuses) => {
        authenticationCalls += 1;
        const actual = createHash('sha256').update(credential).digest();
        const expected = createHash('sha256').update(CREDENTIAL).digest();
        if (!actual.equals(expected) || !statuses.includes(memberStatus)) throw authError();
        return { member: { id: MEMBER_ID } };
      },
      emptyConfigPath,
      gitExecutablePath: runtime.executablePath,
      gitHttpBackendPath: runtime.httpBackendPath!,
      maxConcurrentChildren: 1,
      maxConcurrentChildrenPerMember: 1,
      maxReceivedPackBytes: 1024 * 1024,
      onChildStarted: memberId => {
        expect(memberId).toBe(MEMBER_ID);
      },
      prepareMemberRef: async memberId => {
        prepareStarted = true;
        await prepareBarrier;
        const personalRef = collabMemberRef(memberId);
        if (await service.resolveRef(bareRepositoryPath, personalRef)) return;
        const mainOid = await service.resolveRef(bareRepositoryPath, 'refs/heads/main');
        if (!mainOid) throw new Error('Missing main');
        await service.createRef(bareRepositoryPath, personalRef, mainOid);
      },
      projectId: PROJECT_ID,
      repository: service,
      terminationGraceMs: 50,
    });
    await proxy.enable();

    const identity = await new LanTlsIdentity(root).issueServerIdentity('127.0.0.1');
    caCertificatePem = identity.caCertificatePem;
    const caPath = path.join(root, 'host-ca.pem');
    await writeFile(caPath, identity.caCertificatePem, { mode: 0o600 });
    server = createServer({
      cert: identity.certificateChainPem,
      key: identity.privateKeyPem,
    }, (request, response) => {
      const originalWrite = response.write;
      response.write = ((...args: unknown[]) => {
        const result = Reflect.apply(originalWrite, response, args) as boolean;
        if (forceBackpressure) {
          forceBackpressure = false;
          backpressureCount += 1;
          window.setTimeout(() => response.emit('drain'), 0);
          return false;
        }
        return result;
      }) as typeof response.write;
      void proxy.handle(request, response).then(handled => {
        if (!handled) {
          response.statusCode = 404;
          response.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    url = `https://127.0.0.1:${address.port}/v1/git/${PROJECT_ID}/repository.git`;
    const authorizationHeader = `Basic ${Buffer.from(
      `${MEMBER_ID}:${CREDENTIAL}`,
    ).toString('base64')}`;
    network = {
      authorizationHeader,
      headers: [{ name: 'Authorization', value: authorizationHeader }],
      sslCaInfoPath: caPath,
    };
  });

  afterEach(async () => {
    await proxy.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { force: true, recursive: true });
  });

  it('allows pending clone, requires activation for push, and accepts own fast-forward', () => withGitDiagnostics(async setStage => {
    forceBackpressure = true;
    setStage('pending clone');
    const clonePath = await service.cloneRepository({
      branch: `members/${MEMBER_ID}`,
      directoryName: 'member-clone',
      network,
      parentDirectory: root,
      remoteUrl: url,
    });
    const initialOid = await service.resolveRef(clonePath, collabMemberRef(MEMBER_ID));
    expect(initialOid).not.toBeNull();
    setStage('local clone configuration');
    await service.configureLocalRepository(clonePath, {
      memberId: MEMBER_ID,
      personalRef: collabMemberRef(MEMBER_ID),
      projectId: PROJECT_ID,
      userDisplayName: 'Alice',
    });
    await writeFile(path.join(clonePath, 'note.md'), 'published\n');
    await service.stageAll(clonePath);
    setStage('local publication commit');
    const publishedOid = await service.createCommitFromIndex(clonePath, {
      expectedRefOid: initialOid,
      message: 'Publish note',
      parents: [initialOid!],
      ref: collabMemberRef(MEMBER_ID),
    });

    setStage('pending push rejection');
    await expect(service.push(
      clonePath,
      'origin',
      `${collabMemberRef(MEMBER_ID)}:${collabMemberRef(MEMBER_ID)}`,
      network,
    )).rejects.toBeInstanceOf(CollabError);
    expect(await service.resolveRef(bareRepositoryPath, collabMemberRef(MEMBER_ID)))
      .toBe(initialOid);

    memberStatus = 'active';
    setStage('active personal push');
    await service.push(
      clonePath,
      'origin',
      `${collabMemberRef(MEMBER_ID)}:${collabMemberRef(MEMBER_ID)}`,
      network,
    );
    expect(await service.resolveRef(bareRepositoryPath, collabMemberRef(MEMBER_ID)))
      .toBe(publishedOid);
    setStage('active fetch');
    await service.fetch(
      clonePath,
      'origin',
      ['+refs/heads/main:refs/remotes/origin/main'],
      network,
    );
    setStage('repository health check');
    await service.assertHealthy(bareRepositoryPath);
    expect(backpressureCount).toBeGreaterThan(0);
    expect(proxy.activeChildCount).toBe(0);
    const receiveFsck = await runner.run({
      args: ['config', '--local', '--get', 'receive.fsckObjects'],
      cwd: bareRepositoryPath,
    });
    expect(receiveFsck.stdout.toString('utf8').trim()).toBe('true');
  }));

  it('re-authenticates after asynchronous preparation before starting a Git child', async () => {
    memberStatus = 'active';
    let releasePreparation!: () => void;
    prepareBarrier = new Promise<void>(resolve => {
      releasePreparation = resolve;
    });
    const request = requestStatus(
      '/v1/git/project-alpha/repository.git/info/refs?service=git-upload-pack',
      { authorization: network.authorizationHeader },
    );
    await waitFor(() => prepareStarted && authenticationCalls === 1);

    memberStatus = 'revoked';
    releasePreparation();

    await expect(request).resolves.toMatchObject({
      statusCode: 401,
      wwwAuthenticate: expect.any(String),
    });
    expect(authenticationCalls).toBe(2);
    expect(proxy.activeChildCount).toBe(0);
  });

  it('rejects Host startup when the existing repository exceeds its storage quota', async () => {
    await proxy.close();
    proxy = new GitHttpBackendProxy({
      authorityDirectory,
      authenticateMemberCredential: async () => ({ member: { id: MEMBER_ID } }),
      emptyConfigPath,
      gitExecutablePath: runtime.executablePath,
      gitHttpBackendPath: runtime.httpBackendPath!,
      maxHostRepositoryBytes: 1,
      prepareMemberRef: async () => undefined,
      projectId: PROJECT_ID,
      repository: service,
    });

    await expect(proxy.enable()).rejects.toMatchObject({
      code: 'quota-exceeded',
      safeContext: { quota: 'hostRepositorySoftLimitBytes' },
    });
  });

  it('caps cumulative Host storage for later receive-pack requests', () => withGitDiagnostics(async setStage => {
    memberStatus = 'active';
    setStage('repository measurement');
    const baseline = await service.measureStorageBytes(bareRepositoryPath);
    await proxy.close();
    proxy = new GitHttpBackendProxy({
      authorityDirectory,
      authenticateMemberCredential: async (credential, statuses) => {
        const actual = createHash('sha256').update(credential).digest();
        const expected = createHash('sha256').update(CREDENTIAL).digest();
        if (!actual.equals(expected) || !statuses.includes(memberStatus)) throw authError();
        return { member: { id: MEMBER_ID } };
      },
      emptyConfigPath,
      gitExecutablePath: runtime.executablePath,
      gitHttpBackendPath: runtime.httpBackendPath!,
      maxHostRepositoryBytes: baseline + 64 * 1024,
      maxReceivedPackBytes: 1024 * 1024,
      prepareMemberRef: async () => undefined,
      projectId: PROJECT_ID,
      repository: service,
    });
    await proxy.enable();
    setStage('quota clone');
    const clonePath = await service.cloneRepository({
      branch: `members/${MEMBER_ID}`,
      directoryName: 'quota-clone',
      network,
      parentDirectory: root,
      remoteUrl: url,
    });
    setStage('quota clone configuration');
    await service.configureLocalRepository(clonePath, {
      memberId: MEMBER_ID,
      personalRef: collabMemberRef(MEMBER_ID),
      projectId: PROJECT_ID,
      userDisplayName: 'Alice',
    });
    await writeFile(path.join(clonePath, 'large.bin'), randomBytes(256 * 1024));
    await service.stageAll(clonePath);
    const initialOid = await service.resolveRef(clonePath, collabMemberRef(MEMBER_ID));
    setStage('oversized local commit');
    await service.createCommitFromIndex(clonePath, {
      expectedRefOid: initialOid,
      message: 'Oversized cumulative push',
      parents: [initialOid!],
      ref: collabMemberRef(MEMBER_ID),
    });

    setStage('quota push rejection');
    await expect(service.push(
      clonePath,
      'origin',
      `${collabMemberRef(MEMBER_ID)}:${collabMemberRef(MEMBER_ID)}`,
      network,
    )).rejects.toBeInstanceOf(CollabError);
    setStage('quota repository health check');
    await service.assertHealthy(bareRepositoryPath);
  }));

  it('rejects main, another member, deletion, and non-fast-forward updates', () => withGitDiagnostics(async setStage => {
    memberStatus = 'active';
    setStage('hostile clone');
    const clonePath = await service.cloneRepository({
      branch: `members/${MEMBER_ID}`,
      directoryName: 'hostile-clone',
      network,
      parentDirectory: root,
      remoteUrl: url,
    });
    const personalRef = collabMemberRef(MEMBER_ID);
    setStage('hostile clone configuration');
    await service.configureLocalRepository(clonePath, {
      memberId: MEMBER_ID,
      personalRef,
      projectId: PROJECT_ID,
      userDisplayName: 'Alice',
    });
    const initialOid = await service.resolveRef(clonePath, personalRef);
    const mainOid = await service.resolveRef(bareRepositoryPath, 'refs/heads/main');
    expect(initialOid).toBe(mainOid);

    await writeFile(path.join(clonePath, 'second.md'), 'second\n');
    await service.stageAll(clonePath);
    setStage('hostile local commit');
    const secondOid = await service.createCommitFromIndex(clonePath, {
      expectedRefOid: initialOid,
      message: 'Second commit',
      parents: [initialOid!],
      ref: personalRef,
    });

    for (const refspec of [
      `${personalRef}:refs/heads/main`,
      `${personalRef}:${collabMemberRef('member-bob')}`,
      `:${personalRef}`,
    ]) {
      setStage(`protected ref rejection for ${refspec}`);
      await expect(runner.run({
        args: ['push', '--porcelain', 'origin', refspec],
        cwd: clonePath,
        network,
      })).rejects.toBeInstanceOf(CollabError);
    }

    setStage('valid personal push');
    await service.push(
      clonePath,
      'origin',
      `${personalRef}:${personalRef}`,
      network,
    );
    setStage('local personal ref rewind');
    await runner.run({
      args: ['update-ref', personalRef, initialOid!, secondOid],
      cwd: clonePath,
    });
    setStage('non-fast-forward rejection');
    await expect(runner.run({
      args: ['push', '--porcelain', 'origin', `+${personalRef}:${personalRef}`],
      cwd: clonePath,
      network,
    })).rejects.toBeInstanceOf(CollabError);

    expect(await service.resolveRef(bareRepositoryPath, 'refs/heads/main')).toBe(mainOid);
    expect(await service.resolveRef(bareRepositoryPath, collabMemberRef('member-bob')))
      .toBeNull();
    expect(await service.resolveRef(bareRepositoryPath, personalRef)).toBe(secondOid);
    setStage('hostile repository health check');
    await service.assertHealthy(bareRepositoryPath);
    expect(proxy.activeChildCount).toBe(0);
  }));

  it('rejects dumb and anonymous requests before spawning a Git child', async () => {
    await expect(requestStatus('/v1/git/project-alpha/repository.git/HEAD'))
      .resolves.toMatchObject({ statusCode: 404 });
    await expect(requestStatus(
      '/v1/git/project-alpha/repository.git/info/refs?service=git-upload-pack',
    )).resolves.toMatchObject({ statusCode: 401, wwwAuthenticate: expect.any(String) });
    await expect(requestStatus(
      '/v1/git/project-other/repository.git/info/refs?service=git-upload-pack',
      { authorization: network.authorizationHeader },
    )).resolves.toMatchObject({ statusCode: 404 });
    await expect(requestStatus(
      '/v1/git/project-alpha/repository.git/info/refs?service=git-receive-pack',
      { authorization: network.authorizationHeader },
    )).resolves.toMatchObject({ statusCode: 401 });
    await expect(requestStatus(
      '/v1/git/project-alpha/repository.git/git-upload-pack',
      {
        authorization: network.authorizationHeader,
        'content-length': String(1024 * 1024 + 1),
        'content-type': 'application/x-git-upload-pack-request',
      },
      'POST',
    )).resolves.toMatchObject({ statusCode: 413 });
    expect(proxy.activeChildCount).toBe(0);
  });

  it('caps children and terminates them on disconnect or Host abort', async () => {
    const hanging = openHangingUploadRequest();
    await waitFor(() => proxy.activeChildCount === 1);

    await expect(requestStatus(
      '/v1/git/project-alpha/repository.git/info/refs?service=git-upload-pack',
      { authorization: network.authorizationHeader },
    )).resolves.toMatchObject({ statusCode: 429 });

    hanging.destroy();
    await waitFor(() => proxy.activeChildCount === 0);

    const hostAborted = openHangingUploadRequest();
    await waitFor(() => proxy.activeChildCount === 1);
    await proxy.close();
    hostAborted.destroy();
    expect(proxy.activeChildCount).toBe(0);
    await expect(service.assertHealthy(bareRepositoryPath)).resolves.toBeUndefined();
  });

  function requestStatus(
    requestPath: string,
    headers: Readonly<Record<string, string>> = {},
    method = 'GET',
  ): Promise<{ statusCode: number; wwwAuthenticate?: string }> {
    return new Promise((resolve, reject) => {
      const request = httpsRequest({
        ca: caCertificatePem,
        headers,
        hostname: '127.0.0.1',
        method,
        path: requestPath,
        port: Number(new URL(url).port),
      }, response => {
        response.resume();
        response.once('end', () => resolve({
          statusCode: response.statusCode ?? 0,
          ...(typeof response.headers['www-authenticate'] === 'string'
            ? { wwwAuthenticate: response.headers['www-authenticate'] }
            : {}),
        }));
      });
      request.once('error', reject);
      request.end();
    });
  }

  function openHangingUploadRequest(): ClientRequest {
    const request = httpsRequest({
      ca: caCertificatePem,
      headers: {
        authorization: network.authorizationHeader,
        'content-length': '100',
        'content-type': 'application/x-git-upload-pack-request',
      },
      hostname: '127.0.0.1',
      method: 'POST',
      path: `/v1/git/${PROJECT_ID}/repository.git/git-upload-pack`,
      port: Number(new URL(url).port),
    });
    request.on('error', () => undefined);
    request.flushHeaders();
    return request;
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for Git child state');
      await new Promise<void>(resolve => window.setTimeout(resolve, 10));
    }
  }
});
