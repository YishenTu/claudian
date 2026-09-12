import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { collabCloudProjectOperationRoute } from '@claudian-collab/protocol';
import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import initSqlJs from 'sql.js';

import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import { createCollabFeatureSubcomposition } from '@/app/collab/CollabFeatureSubcomposition';
import { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { CloudAuthorityAdapter } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { NodeCloudAuthorityHttpTransport } from '@/app/collab/remote-authority/NodeCloudAuthorityHttpTransport';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const serverUrl = process.env.CLAUDIAN_AUTHORITY_TRANSFER_SERVER_URL;
const describeWithServer = serverUrl ? describe : describe.skip;
const MEMBER_ID = 'member-authority-roundtrip-gate';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Roundtrip fixture Git command failed');
  return result.stdout.trim();
}

describeWithServer('real Cloud authority roundtrip gate', () => {
  it.each([false, true])('preserves three roundtrips after lost begin response: %s', async loseBeginResponse => {
    const PROJECT_ID = `project-authority-roundtrip-${randomUUID()}`;
    if (!serverUrl) throw new Error('Missing real Cloud server URL');
    const root = await mkdtemp(path.join(tmpdir(), 'claudian-authority-roundtrip-client-'));
    const SQL = await initSqlJs();
    const foundation = new ClaudianCollabService({
      createAuthorityDatabase: (authorityDirectory, resourceAdmission) => new SqlJsProjectDatabase(authorityDirectory, { resourceAdmission, loadSqlJs: async () => SQL }),
      getConfiguredGitPath: () => '',
      installationKey: TEST_INSTALLATION_A,
      obsidianConfigDirectory: '.obsidian',
      vaultRoot: root,
    });
    const transport = new NodeCloudAuthorityHttpTransport();
    let beginResponseLost = false;
    const cloudAuthority = new CloudAuthorityAdapter(root, {
      request: async input => {
        const response = await transport.request(input);
        if (loseBeginResponse && !beginResponseLost
          && input.url.endsWith(collabCloudProjectOperationRoute(PROJECT_ID, 'beginLanToCloudTransfer').target)
          && response.status === 200) {
          beginResponseLost = true;
          throw new CollabError({ code: 'endpoint-unreachable' });
        }
        return response;
      },
    });
    const composition = createCollabFeatureSubcomposition({
      cloudAuthority,
      foundation,
      projectSetup: new CollabProjectSetupService(foundation, {
        installationKey: TEST_INSTALLATION_A,
        createId: kind => kind === 'project' ? PROJECT_ID : kind === 'member' ? MEMBER_ID : 'create-authority-roundtrip-gate',
        vaultRoot: root,
      }),
      vaultRoot: root,
    });
    try {
      await expect(composition.feature.initialize()).resolves.toMatchObject({ status: 'success' });
      await expect(composition.feature.createProject({ memberDisplayName: 'Roundtrip Host', name: 'Roundtrip Gate' }))
        .resolves.toMatchObject({ status: 'success' });
      const initial = await foundation.local.projects.loadMembership(PROJECT_ID);
      if (!initial) throw new Error('Missing created roundtrip membership');
      const repositoryPath = await foundation.local.workspace.resolveManagedProjectPath(initial.project.workspacePath);
      const initialHead = git(repositoryPath, ['rev-parse', 'HEAD']);
      const localFile = path.join(repositoryPath, 'unpublished-local-note.md');
      await writeFile(localFile, 'Unpublished local work survives every authority move.\n');
      await expect(composition.feature.createTicket({ projectId: PROJECT_ID, title: 'Surviving ticket', body: 'Coordination survives every authority move.' }))
        .resolves.toMatchObject({ status: 'success' });

      const recoverLostAcceptance = async (
        result: Awaited<ReturnType<typeof composition.feature.moveLanToCloud>>,
      ) => {
        expect(result).toMatchObject({ status: 'failure', error: { code: 'endpoint-unreachable' } });
        expect(beginResponseLost).toBe(true);
        await composition.feature.restoreLifecycle();
        return (await foundation.authorityTransfers.load(PROJECT_ID))?.status;
      };

      for (const generation of [2, 4, 6]) {
        const cloud = await composition.feature.moveLanToCloud({ projectId: PROJECT_ID, serverUrl });
        let cloudStatus;
        if (loseBeginResponse && generation === 2) {
          cloudStatus = await recoverLostAcceptance(cloud);
        } else if (cloud.status !== 'success') {
          const reason = 'error' in cloud ? `${cloud.error.code}:${cloud.error.safeContext.reason}` : cloud.status;
          const physical = await foundation.authorityTransfers.load(PROJECT_ID);
          const source = await foundation.authorityTransfers.loadSourceEntry(PROJECT_ID);
          throw new Error(`Cloud generation ${generation} failed: ${reason}; phase=${physical?.status.phase}; begin=${source?.beginSubmission}`);
        } else {
          cloudStatus = cloud.value;
        }
        expect(cloudStatus).toMatchObject({
          projectId: PROJECT_ID, state: 'completed', targetAuthority: { generation, kind: 'cloud' },
        });
        await expect(foundation.local.projects.loadMembership(PROJECT_ID)).resolves.toMatchObject({
          authority: { authorityGeneration: generation, kind: 'cloud' }, member: { id: MEMBER_ID },
        });
        const cloudSnapshot = await composition.feature.readSnapshot(PROJECT_ID);
        expect(cloudSnapshot).toMatchObject({ status: 'success', value: { snapshot: {
          currentMember: { id: MEMBER_ID }, project: { authorityGeneration: generation, authorityKind: 'cloud' }, openTicketCount: 1,
        } } });

        const lan = await composition.feature.moveCloudToLan(PROJECT_ID);
        if (lan.status !== 'success') {
          const reason = 'error' in lan ? `${lan.error.code}:${lan.error.safeContext.reason}` : lan.status;
          throw new Error(`LAN generation ${generation + 1} failed: ${reason}`);
        }
        expect(lan.value).toMatchObject({
          projectId: PROJECT_ID, state: 'completed', targetAuthority: { generation: generation + 1, kind: 'lan' },
        });
        const membership = await foundation.local.projects.loadMembership(PROJECT_ID);
        expect(membership).toMatchObject({
          authority: { authorityGeneration: generation + 1, kind: 'lan' },
          hostOwnership: { autoStart: true, ownsAuthority: true }, member: { id: MEMBER_ID },
        });
        const route = foundation.lanHost.getActiveProjectRoute(PROJECT_ID);
        expect(membership?.authority).toMatchObject({ endpoint: route?.endpoint });
        expect(git(repositoryPath, ['remote', 'get-url', 'origin']))
          .toBe(`${route?.endpoint}/v1/git/${PROJECT_ID}/repository.git`);
        expect(git(repositoryPath, ['rev-parse', 'HEAD'])).toBe(initialHead);
        await expect(readFile(localFile, 'utf8')).resolves.toBe('Unpublished local work survives every authority move.\n');
        await expect(composition.feature.readSnapshot(PROJECT_ID)).resolves.toMatchObject({
          status: 'success', value: { snapshot: { currentMember: { id: MEMBER_ID }, openTicketCount: 1 } },
        });
      }
    } finally {
      await composition.feature.close();
      await foundation.close();
      await rm(root, { force: true, recursive: true });
    }
  }, 180_000);
});
