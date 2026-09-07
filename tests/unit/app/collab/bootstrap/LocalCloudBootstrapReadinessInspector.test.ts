import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  LocalCloudBootstrapReadinessInspector,
} from '@/app/collab/bootstrap/LocalCloudBootstrapReadinessInspector';

import {
  bootstrapManifest,
  HOST_MEMBER_ID,
  PROJECT_ID,
} from './fixtures';

describe('LocalCloudBootstrapReadinessInspector', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-bootstrap-readiness-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('keeps durable publication and Manager responsibility active after quiescence', async () => {
    const manifest = bootstrapManifest();
    const member = manifest.comparison.members.find(candidate => (
      candidate.memberId === HOST_MEMBER_ID
    ));
    if (!member) throw new Error('host member fixture missing');
    const refs = new Map(manifest.git.refs.map(ref => [ref.name, ref.oid]));
    const inspector = new LocalCloudBootstrapReadinessInspector({
      foundation: {
        hostInstallations: {
          inspect: async () => 'hosted-here',
        },
        inspectAuthority: async () => ({
          authorityDirectory: path.join(vaultRoot, 'authority'),
        }),
        local: {
          projects: {
            getConflictDirectoryPath: () => '.claudian/collab/conflicts',
            hostTransferRecovery: { load: async () => null },
            listPendingOperationProjectIds: async () => [],
            loadMembership: async () => ({
              authority: { kind: 'lan' },
              hostOwnership: { ownsAuthority: true },
              lifecycle: 'active',
              member: {
                id: HOST_MEMBER_ID,
                personalRef: member.personalRef,
              },
              project: {
                id: PROJECT_ID,
                workspacePath: `workspace/${PROJECT_ID}`,
              },
            }),
            loadProjectDocument: async (_projectId: string, kind: string) => (
              kind === 'publication-state'
                ? {
                    baseMainOid: manifest.comparison.mainOid,
                    operation: {
                      candidateOid: null,
                      contributionHeadOid: refs.get(member.personalRef),
                      createdAt: '2026-08-21T00:00:00.000Z',
                      currentMainOid: null,
                      operationId: 'publish-active',
                      phase: 'captured',
                      updatedAt: '2026-08-21T00:00:00.000Z',
                    },
                    projectId: PROJECT_ID,
                    schemaVersion: 1,
                    updatedAt: '2026-08-21T00:00:00.000Z',
                  }
                : null
            ),
            loadRetirementRecord: async () => null,
            localCleanup: { load: async () => null },
          },
          workspace: {
            resolveManagedProjectPath: async () => path.join(vaultRoot, 'workspace', PROJECT_ID),
          },
        },
        requireGitFoundation: async () => ({
          repositories: {
            assertLocalRepositoryIdentity: async () => undefined,
            getWorkingTreeState: async () => ({ entries: [] }),
            resolveRef: async () => refs.get(member.personalRef) ?? null,
            resolveRefs: async () => refs,
          },
          runner: {
            activeProcessCount: 0,
            run: async () => ({ stdout: Buffer.from(`${manifest.git.objectFormat}\n`) }),
          },
        }),
      } as never,
      isProjectQuiesced: () => true,
      managerResponsibilityReceipts: {
        load: async () => ({ status: 'acknowledged' }) as never,
      },
      vaultRoot,
    });

    const observation = await inspector.inspect(PROJECT_ID, HOST_MEMBER_ID);

    expect(observation.operations.managerResponsibility).toBe('active');
    expect(observation.operations.publish).toBe('active');
    expect(Object.entries(observation.operations).filter(([operation]) => (
      operation !== 'managerResponsibility' && operation !== 'publish'
    )).every(([, state]) => state === 'settled')).toBe(true);
  });
});
