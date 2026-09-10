import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { ClientRequest } from 'node:http';
import { createServer, request as httpsRequest, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { collabMemberRef } from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import initSqlJs from 'sql.js';

import { PendingMembershipRepository } from '@/app/collab/authority/PendingMembershipRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { GitRuntimeResolver } from '@/app/collab/git/GitRuntimeResolver';
import { AuthorityMemberCredentialAuthenticator } from '@/app/collab/lan/AuthorityMemberCredentialAuthenticator';
import { GitHttpBackendAdmission } from '@/app/collab/lan/GitHttpBackendAdmission';
import { GitHttpBackendProxy } from '@/app/collab/lan/GitHttpBackendProxy';
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';

const CREATED_AT = '2026-09-10T00:00:00.000Z';
const members = Array.from({ length: 4 }, (_, index) => ({
  id: `member-${index}`, credential: Buffer.alloc(32, index + 1).toString('base64url'),
}));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for real Git child settlement');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

it('shares eight Git admissions across two Projects and releases capacity after disconnect', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'collab-git-admission-'));
  const childAdmission = new GitHttpBackendAdmission();
  const proxies = new Map<string, GitHttpBackendProxy>();
  const databases: SqlJsProjectDatabase[] = [];
  const hanging: ClientRequest[] = [];
  let server: Server | undefined;
  try {
    const resolution = await new GitRuntimeResolver().resolve();
    if (resolution.status !== 'available' || !resolution.runtime.httpBackendPath) throw new Error('Real Git Smart HTTP required');
    const runtime = resolution.runtime;
    const emptyConfigPath = path.join(root, 'empty.gitconfig');
    await writeFile(emptyConfigPath, '');
    const runner = new GitCommandRunner({ emptyConfigPath, executablePath: runtime.executablePath });
    const repository = new GitRepositoryService(runner);
    const source = path.join(root, 'source');
    await mkdir(source);
    await repository.initializeWorkingRepository(source);
    await repository.configureLocalRepository(source, { memberId: members[0]!.id, personalRef: collabMemberRef(members[0]!.id), projectId: 'project-alpha', userDisplayName: 'Host' });
    await writeFile(path.join(source, 'note.md'), 'Initial fixture content\n');
    await repository.stageAll(source);
    const mainOid = await repository.createCommitFromIndex(source, { expectedRefOid: null, message: 'Initial Project', parents: [], ref: 'refs/heads/main' });
    for (const projectId of ['project-alpha', 'project-beta']) {
      const authorityDirectory = path.join(root, projectId);
      const bare = path.join(authorityDirectory, 'repository.git');
      await mkdir(bare, { recursive: true });
      await repository.initializeBareRepository(bare);
      await repository.addRemote(source, projectId, bare);
      await repository.push(source, projectId, 'refs/heads/main:refs/heads/main');
      for (const member of members) await repository.createRef(bare, collabMemberRef(member.id), mainOid);
      const database = new SqlJsProjectDatabase(authorityDirectory, { loadSqlJs: () => initSqlJs() });
      databases.push(database);
      await database.open();
      await database.mutate(connection => {
        new ProjectAuthorityRepository().initialize(connection, { createdAt: CREATED_AT, hostCredentialHash: createHash('sha256').update(members[0]!.credential).digest(), hostDisplayName: 'Host', hostMemberId: members[0]!.id, name: projectId, projectId });
        const memberships = new PendingMembershipRepository();
        for (const member of members.slice(1)) {
          memberships.createPending(connection, { createdAt: CREATED_AT, credentialHash: createHash('sha256').update(member.credential).digest(), displayName: member.id, joinAttemptId: `join-${member.id}`, memberId: member.id });
          memberships.activate(connection, member.id, CREATED_AT);
        }
      });
      const authenticator = new AuthorityMemberCredentialAuthenticator(database);
      const proxy = new GitHttpBackendProxy({
        authorityDirectory, childAdmission,
        authenticateMemberCredential: (credential, statuses) => authenticator.authenticate(credential, statuses),
        emptyConfigPath, gitExecutablePath: runtime.executablePath, gitHttpBackendPath: runtime.httpBackendPath!,
        prepareMemberRef: async memberId => {
          if (!await repository.resolveRef(bare, collabMemberRef(memberId))) await repository.createRef(bare, collabMemberRef(memberId), mainOid);
        },
        projectId, repository, terminationGraceMs: 50,
      });
      proxies.set(projectId, proxy);
      await proxy.enable();
    }
    const identity = await new LanTlsIdentity(root, { installationKey: TEST_INSTALLATION_A }).issueServerIdentity('127.0.0.1');
    server = createServer({ key: identity.privateKeyPem, cert: identity.certificateChainPem }, (request, response) => {
      const projectId = request.url?.split('/')[3];
      const proxy = proxies.get(projectId ?? '');
      if (!proxy) { response.writeHead(404).end(); return; }
      void proxy.handle(request, response).catch(() => response.destroy());
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener address');
    const base = `https://127.0.0.1:${address.port}`;
    const authorization = (member: typeof members[number]) => `Basic ${Buffer.from(`${member.id}:${member.credential}`).toString('base64')}`;
    const advertisement = (projectId: string) => new Promise<number>((resolve, reject) => {
      const request = httpsRequest(`${base}/v1/git/${projectId}/repository.git/info/refs?service=git-upload-pack`, { agent: false, ca: identity.caCertificatePem, headers: { authorization: authorization(members[0]!) }, signal: AbortSignal.timeout(5000) }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject); request.end();
    });
    const alpha = proxies.get('project-alpha')!;
    const beta = proxies.get('project-beta')!;
    for (const member of members) {
      for (let device = 0; device < 2; device++) {
        const request = httpsRequest(`${base}/v1/git/project-alpha/repository.git/git-upload-pack`, {
          method: 'POST', agent: false, ca: identity.caCertificatePem,
          headers: { authorization: authorization(member), 'content-encoding': 'gzip', 'content-length': '100', 'content-type': 'application/x-git-upload-pack-request' },
        });
        request.on('error', () => undefined); request.flushHeaders(); hanging.push(request);
        await until(() => alpha.activeChildCount === hanging.length);
      }
    }
    const saturated = await advertisement('project-beta');
    hanging.shift()!.destroy();
    await until(() => alpha.activeChildCount === 7 && beta.activeChildCount === 0);
    const afterRelease = await advertisement('project-beta');
    expect({ saturated, afterRelease }).toEqual({ saturated: 429, afterRelease: 200 });
  } finally {
    for (const request of hanging) request.destroy();
    await Promise.all([...proxies.values()].map(proxy => proxy.close()));
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await Promise.all(databases.map(database => database.close()));
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
