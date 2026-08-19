import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { collabMemberRef } from '@claudian/collab-protocol';
import initSqlJs, { type SqlJsStatic } from 'sql.js';

import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';

jest.setTimeout(90_000);

describe('M3 secure LAN repository gate', () => {
  let SQL: SqlJsStatic;
  let host: ClaudianCollabService;
  let member: ClaudianCollabService;
  let root: string;

  beforeAll(async () => {
    SQL = await initSqlJs();
  });

  afterEach(async () => {
    await member?.close();
    await host?.close();
    await rm(root, { force: true, recursive: true });
  });

  it('creates, hosts, joins, and protects a real two-Vault repository', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-m3-gate-'));
    const hostRoot = path.join(root, 'host-vault');
    const memberRoot = path.join(root, 'member-vault');
    await Promise.all([
      mkdir(hostRoot),
      mkdir(memberRoot),
    ]);
    const invitationCodec = new InvitationCodec({
      isAddressAllowed: address => address === '127.0.0.1',
    });
    host = new ClaudianCollabService({
      createAuthorityDatabase: authorityDirectory => new SqlJsProjectDatabase(
        authorityDirectory,
        { loadSqlJs: async () => SQL },
      ),
      getConfiguredGitPath: () => '',
      lanHost: {
        createInvitationCodec: () => invitationCodec,
        getPrivateIpv4Addresses: () => ['127.0.0.1'],
        portCandidates: [0],
      },
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: hostRoot,
    });
    member = new ClaudianCollabService({
      getConfiguredGitPath: () => '',
      invitationCodec,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: memberRoot,
    });

    const setup = new CollabProjectSetupService(host, { vaultRoot: hostRoot });
    const created = await setup.createProject({
      memberDisplayName: 'Host',
      name: 'Alpha',
    });
    if (created.status !== 'success') {
      throw new Error(`Project setup failed: ${JSON.stringify(created)}`);
    }
    const projectId = created.value.id;

    const hostSession = await host.lanHost.startProject(projectId);
    expect(hostSession).toMatchObject({ status: 'running' });
    const invitation = await host.lanHost.createInvitation(projectId);
    const joined = await member.join.joinProject({
      encodedInvitation: invitation.encodedInvitation,
      memberDisplayName: 'Member',
    });
    if (joined.status !== 'success') {
      throw new Error(`Project Join failed: ${JSON.stringify(joined)}`);
    }

    const localMembership = await member.local.projects.loadMembership(projectId);
    if (!localMembership) throw new Error('Member membership missing');
    const workingCopy = path.join(memberRoot, joined.value.workspacePath);
    await writeFile(path.join(workingCopy, 'member-note.md'), 'member change\n');
    const memberGit = await member.requireGitFoundation();
    const personalRef = collabMemberRef(localMembership.member.id);
    const previousOid = await memberGit.repositories.resolveRef(workingCopy, personalRef);
    if (!previousOid) throw new Error('Member ref missing');
    await memberGit.repositories.stageAll(workingCopy);
    const nextOid = await memberGit.repositories.createCommitFromIndex(workingCopy, {
      expectedRefOid: previousOid,
      message: 'Add member note',
      parents: [previousOid],
      ref: personalRef,
    });
    const caPath = path.join(root, 'host-ca.pem');
    await writeFile(caPath, localMembership.authority.hostCaCertificatePem!, {
      mode: 0o600,
    });
    const network = {
      authorizationHeader: `Basic ${Buffer.from(
        `${localMembership.member.id}:${localMembership.member.credential}`,
      ).toString('base64')}`,
      sslCaInfoPath: caPath,
    };
    await memberGit.repositories.push(
      workingCopy,
      'origin',
      `${personalRef}:${personalRef}`,
      network,
    );
    await expect(memberGit.repositories.push(
      workingCopy,
      'origin',
      `${personalRef}:refs/heads/main`,
      network,
    )).rejects.toMatchObject({ code: 'operation-failed' });

    const hostGit = await host.requireGitFoundation();
    const bareRepository = path.join(
      hostRoot,
      '.claudian',
      'collab',
      'authorities',
      projectId,
      'repository.git',
    );
    expect(await hostGit.repositories.resolveRef(bareRepository, personalRef)).toBe(nextOid);
    await expect(hostGit.repositories.assertHealthy(bareRepository)).resolves.toBeUndefined();
    expect(await readFile(path.join(workingCopy, 'member-note.md'), 'utf8'))
      .toBe('member change\n');
    expect(hostGit.runner.activeProcessCount).toBe(0);
    expect(memberGit.runner.activeProcessCount).toBe(0);

    await expect(host.lanHost.stopProject(projectId)).resolves.toEqual({
      projectId,
      status: 'stopped',
    });
  });
});
