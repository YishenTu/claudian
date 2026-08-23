import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  COLLAB_MAIN_REF,
  collabMemberRef,
} from '@claudian-collab/protocol';

import {
  LocalDevelopmentBootstrapSource,
} from '@/app/collab/bootstrap/LocalDevelopmentBootstrapSource';
import type { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';

import {
  HOST_OID,
  MAIN_OID,
  OTHER_OID,
  PROJECT_ID,
} from './fixtures';

describe('LocalDevelopmentBootstrapSource', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'claudian-cloud-bootstrap-source-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { force: true, recursive: true });
  });

  it('captures only the eligible two-Member authority and exact canonical refs', async () => {
    const sourceHostMemberId = 'member-zulu';
    const otherMemberId = 'member-alpha';
    let sourceEventSequence = 12;
    let latestEventActorMemberId = sourceHostMemberId;
    let latestEventKind = 'project.updated';
    const authorityDirectory = path.join(vaultRoot, '.claudian', 'collab', 'authorities', PROJECT_ID);
    await mkdir(path.join(authorityDirectory, 'repository.git'), { recursive: true });
    const refs = [
      `${MAIN_OID} ${COLLAB_MAIN_REF}`,
      `${HOST_OID} ${collabMemberRef(sourceHostMemberId)}`,
      `${OTHER_OID} ${collabMemberRef(otherMemberId)}`,
    ].join('\n');
    const members = [
      {
        activated_at: '2026-08-20T00:00:00.000Z',
        created_at: '2026-08-19T00:00:00.000Z',
        display_name: 'Alice',
        member_id: sourceHostMemberId,
        personal_ref: collabMemberRef(sourceHostMemberId),
        role: 'manager',
        status: 'active',
      },
      {
        activated_at: '2026-08-20T00:01:00.000Z',
        created_at: '2026-08-19T00:01:00.000Z',
        display_name: 'Bob',
        member_id: otherMemberId,
        personal_ref: collabMemberRef(otherMemberId),
        role: 'member',
        status: 'active',
      },
    ];
    let stallBundle = false;
    let markBundleStarted: (() => void) | undefined;
    const bundleStarted = new Promise<void>(resolve => { markBundleStarted = resolve; });
    const runner = {
      activeProcessCount: 0,
      run: jest.fn(async ({
        args,
        signal,
      }: {
        readonly args: readonly string[];
        readonly signal?: AbortSignal;
      }) => {
        if (args[0] === 'rev-parse') {
          return { exitCode: 0, stderr: '', stdout: Buffer.from('sha1\n') };
        }
        if (args[0] === 'for-each-ref') {
          return { exitCode: 0, stderr: '', stdout: Buffer.from(`${refs}\n`) };
        }
        if (args[0] === 'bundle') {
          if (stallBundle) {
            markBundleStarted?.();
            return new Promise<never>((_resolve, reject) => {
              const fail = () => reject(new Error('bundle cancelled'));
              signal?.addEventListener('abort', fail, { once: true });
              if (signal?.aborted) fail();
            });
          }
          await writeFile(args[2]!, Buffer.from([1, 2, 3]), { mode: 0o600 });
          return { exitCode: 0, stderr: '', stdout: Buffer.alloc(0) };
        }
        throw new Error('unexpected Git command');
      }),
    };
    const foundation = {
      local: {
        projects: {
          loadMembership: async () => ({
            authority: {
              endpoint: 'https://192.168.1.20:54545',
              gitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
              hostCaCertificatePem: 'certificate',
              hostCaFingerprint: 'BB:'.repeat(31) + 'BB',
              kind: 'lan',
            },
            createdAt: '2026-08-19T00:00:00.000Z',
            hostOwnership: { autoStart: true, ownsAuthority: true },
            lastEventSequence: 12,
            lifecycle: 'active',
            member: {
              credential: 'a'.repeat(43),
              displayName: 'Alice',
              id: sourceHostMemberId,
              personalRef: collabMemberRef(sourceHostMemberId),
              role: 'manager',
            },
            project: {
              id: PROJECT_ID,
              name: 'Project Alpha',
              workspacePath: 'Collab/Project Alpha',
            },
            schemaVersion: 2,
            updatedAt: '2026-08-20T00:00:00.000Z',
          }),
        },
      },
      openAuthority: async () => ({
        authorityDirectory,
        database: {
          read: async (operation: (connection: unknown) => unknown) => operation({
            all: (sql: string) => sql.includes('FROM members') ? members : [],
            get: (sql: string) => {
              if (sql.includes('MAX(sequence)')) return { count: sourceEventSequence };
              if (sql.includes('ORDER BY sequence DESC')) {
                return {
                  actor_member_id: latestEventActorMemberId,
                  event_kind: latestEventKind,
                  sequence: sourceEventSequence,
                };
              }
              return { count: 0 };
            },
          }),
        },
        projects: {
          get: () => ({
            createdAt: '2026-08-19T00:00:00.000Z',
            hostMemberId: sourceHostMemberId,
            mainRef: COLLAB_MAIN_REF,
            managerSetGeneration: 4,
            name: 'Project Alpha',
            projectId: PROJECT_ID,
            snapshotGeneration: 3,
            state: 'active',
          }),
        },
      }),
      requireGitFoundation: async () => ({ runner }),
    } as unknown as ClaudianCollabService;
    const source = new LocalDevelopmentBootstrapSource({
      createAttemptId: () => 'bootstrap-attempt-source',
      foundation,
      now: () => new Date('2026-08-21T00:00:00.000Z'),
      vaultRoot,
    });

    const controller = new AbortController();
    const manifest = await source.captureManifest(PROJECT_ID, controller.signal);
    const chunks: Buffer[] = [];
    for await (const chunk of source.openBundle(manifest)) chunks.push(Buffer.from(chunk));

    expect(manifest).toMatchObject({
      attemptId: 'bootstrap-attempt-source',
      comparison: {
        mainOid: MAIN_OID,
        members: [
          expect.objectContaining({ memberId: otherMemberId }),
          expect.objectContaining({ memberId: sourceHostMemberId }),
        ],
        sourceCaFingerprint: 'b'.repeat(64),
        sourceEventSequence: 12,
        sourceHostMemberId,
      },
      git: {
        bundle: { byteCount: 3 },
        objectFormat: 'sha1',
      },
    });
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(runner.run).toHaveBeenLastCalledWith(expect.objectContaining({
      args: [
        'bundle',
        'create',
        expect.stringContaining('bootstrap-attempt-source.bundle'),
        COLLAB_MAIN_REF,
        collabMemberRef(otherMemberId),
        collabMemberRef(sourceHostMemberId),
      ],
      signal: controller.signal,
    }));
    await expect(source.assertManifestCurrent(manifest, controller.signal))
      .resolves.toBeUndefined();

    sourceEventSequence = 13;
    latestEventKind = 'host.stopped';
    await expect(source.assertManifestCurrent(manifest, controller.signal))
      .resolves.toBeUndefined();

    latestEventActorMemberId = otherMemberId;
    await expect(source.assertManifestCurrent(manifest, controller.signal)).rejects.toMatchObject({
      safeContext: { reason: 'cloud-bootstrap-source-manifest-authority-changed' },
    });

    sourceEventSequence = 12;
    latestEventActorMemberId = sourceHostMemberId;
    const ownership = jest.fn(async () => true);
    await expect(source.recoverArtifacts(ownership)).resolves.toBeUndefined();
    expect(ownership).toHaveBeenCalledWith(manifest);
    const preservedChunks: Buffer[] = [];
    for await (const chunk of source.openBundle(manifest)) {
      preservedChunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(preservedChunks)).toEqual(Buffer.from([1, 2, 3]));

    await expect(source.recoverArtifacts(async () => false)).resolves.toBeUndefined();
    await expect(source.discardBundle(manifest)).resolves.toBeUndefined();
    await expect(source.discardBundle(manifest)).resolves.toBeUndefined();
    await expect(lstat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'cloud-bootstrap-artifacts',
      'bootstrap-attempt-source.bundle',
    ))).rejects.toMatchObject({ code: 'ENOENT' });

    stallBundle = true;
    const cancelledSource = new LocalDevelopmentBootstrapSource({
      createAttemptId: () => 'bootstrap-attempt-cancelled',
      foundation,
      now: () => new Date('2026-08-21T00:00:00.000Z'),
      vaultRoot,
    });
    const cancellation = new AbortController();
    const capture = cancelledSource.captureManifest(PROJECT_ID, cancellation.signal);
    await bundleStarted;
    cancellation.abort();

    await expect(capture).rejects.toMatchObject({ code: 'cancelled' });
    await expect(lstat(path.join(
      vaultRoot,
      '.claudian',
      'collab',
      'cloud-bootstrap-artifacts',
      'bootstrap-attempt-cancelled.bundle',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
