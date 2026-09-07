import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type GitCommandRequest,
  type GitCommandResult,
  GitCommandRunner,
} from '@/app/collab/git/GitCommandRunner';
import {
  getConventionalGitCandidates,
  type GitRuntimeProbeResult,
  GitRuntimeResolver,
  probeGitRuntime,
} from '@/app/collab/git/GitRuntimeResolver';

const SUPPORTED_PROBE: GitRuntimeProbeResult = {
  capabilities: {
    catFileBatch: true,
    commitTree: true,
    diffTreeNul: true,
    httpBackend: true,
    mergeTreeWriteTree: true,
    statusPorcelainV2Nul: true,
  },
  execPath: '/git/libexec/git-core',
  httpBackendPath: '/git/libexec/git-core/git-http-backend',
  version: {
    major: 2,
    minor: 45,
    patch: 1,
    raw: 'git version 2.45.1',
  },
};

describe('GitRuntimeResolver', () => {
  let root: string;
  let manualGit: string;
  let pathGit: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'claudian-git-resolver-'));
    manualGit = path.join(root, 'manual-git');
    pathGit = path.join(root, 'path-git');
    await writeFile(manualGit, '');
    await writeFile(pathGit, '');
    await chmod(manualGit, 0o755);
    await chmod(pathGit, 0o755);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { force: true, recursive: true });
  });

  it('runs the cold capability probe in two bounded dependency waves', async () => {
    const pending = new Map<string, {
      readonly promise: Promise<GitCommandResult>;
      readonly resolve: (result: GitCommandResult) => void;
    }>();
    const callOrder: string[] = [];
    const result = (stdout = '', stderr = ''): GitCommandResult => ({
      exitCode: 0,
      stderr,
      stdout: Buffer.from(stdout),
    });
    const deferred = (key: string) => {
      let resolve!: (value: GitCommandResult) => void;
      const promise = new Promise<GitCommandResult>(next => {
        resolve = next;
      });
      const value = { promise, resolve };
      pending.set(key, value);
      return value;
    };
    jest.spyOn(GitCommandRunner.prototype, 'run').mockImplementation(
      (request: GitCommandRequest) => {
        const key = request.args[0] ?? '';
        callOrder.push(key);
        return (pending.get(key) ?? deferred(key)).promise;
      },
    );
    const waitForCalls = async (count: number): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (callOrder.length < count && Date.now() < deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 5));
      }
      if (callOrder.length < count) {
        throw new Error(`Timed out waiting for ${count} Git probe calls`);
      }
    };

    const probe = probeGitRuntime('/usr/bin/git', 'darwin');
    await waitForCalls(1);
    expect(callOrder).toEqual(expect.arrayContaining([
      '--exec-path',
      '--list-cmds=main,others,nohelpers',
      '--version',
      'init',
    ]));
    expect(callOrder).toHaveLength(4);

    pending.get('--version')?.resolve(result('git version 2.50.1\n'));
    pending.get('--exec-path')?.resolve(result('/tmp/git-core\n'));
    pending.get('--list-cmds=main,others,nohelpers')?.resolve(result(
      'commit-tree\nmerge-tree\n',
    ));
    pending.get('init')?.resolve(result());
    await waitForCalls(8);
    expect(callOrder).toEqual(expect.arrayContaining([
      'cat-file',
      'diff-tree',
      'merge-tree',
      'status',
    ]));
    expect(callOrder).toHaveLength(8);

    pending.get('status')?.resolve(result());
    pending.get('diff-tree')?.resolve(result());
    pending.get('cat-file')?.resolve(result());
    pending.get('merge-tree')?.resolve(result('', '--write-tree'));

    await expect(probe).resolves.toMatchObject({
      capabilities: {
        catFileBatch: true,
        commitTree: true,
        diffTreeNul: true,
        mergeTreeWriteTree: true,
        statusPorcelainV2Nul: true,
      },
      version: { major: 2, minor: 50, patch: 1 },
    });
  });

  it('uses the configured executable before PATH and conventional candidates', async () => {
    const probe = jest.fn().mockResolvedValue(SUPPORTED_PROBE);
    const resolver = new GitRuntimeResolver({
      conventionalCandidates: () => ['/conventional/git'],
      findOnPath: () => pathGit,
      platform: process.platform,
      probe,
    });

    const resolution = await resolver.resolve({ configuredPath: manualGit });

    expect(resolution).toMatchObject({
      runtime: { executablePath: manualGit },
      source: 'configured',
      status: 'available',
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(manualGit);
  });

  it('checks PATH before deduplicated conventional candidates', async () => {
    const probe = jest.fn()
      .mockRejectedValueOnce(new Error('PATH candidate failed'))
      .mockResolvedValueOnce(SUPPORTED_PROBE);
    const resolver = new GitRuntimeResolver({
      conventionalCandidates: () => [pathGit, manualGit],
      findOnPath: () => pathGit,
      platform: process.platform,
      probe,
    });

    const resolution = await resolver.resolve();

    expect(resolution).toMatchObject({
      runtime: { executablePath: manualGit },
      source: 'conventional',
      status: 'available',
    });
    expect(probe.mock.calls).toEqual([[pathGit], [manualGit]]);
  });

  it('reports an incompatible version without claiming missing Git', async () => {
    const resolver = new GitRuntimeResolver({
      findOnPath: () => pathGit,
      platform: process.platform,
      probe: async () => ({
        ...SUPPORTED_PROBE,
        version: { major: 2, minor: 37, patch: 9, raw: 'git version 2.37.9' },
      }),
    });

    await expect(resolver.resolve()).resolves.toMatchObject({
      minimumVersion: '2.38.0',
      status: 'incompatible',
      version: '2.37.9',
    });
  });

  it('reports every missing required capability', async () => {
    const resolver = new GitRuntimeResolver({
      findOnPath: () => pathGit,
      platform: process.platform,
      probe: async () => ({
        ...SUPPORTED_PROBE,
        capabilities: {
          ...SUPPORTED_PROBE.capabilities,
          httpBackend: false,
          mergeTreeWriteTree: false,
        },
        httpBackendPath: null,
      }),
    });

    await expect(resolver.resolve()).resolves.toMatchObject({
      missingCapabilities: ['http-backend', 'merge-tree-write-tree'],
      status: 'incompatible',
    });
  });

  it('caches a scan until Rescan is requested', async () => {
    const probe = jest.fn().mockResolvedValue(SUPPORTED_PROBE);
    const resolver = new GitRuntimeResolver({
      findOnPath: () => pathGit,
      platform: process.platform,
      probe,
    });

    await resolver.resolve();
    await resolver.resolve();
    await resolver.rescan();

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('treats a configured non-file as a configured-path error', async () => {
    const probe = jest.fn();
    const resolver = new GitRuntimeResolver({
      findOnPath: () => pathGit,
      platform: process.platform,
      probe,
    });

    await expect(resolver.resolve({ configuredPath: path.join(root, 'missing') }))
      .resolves.toMatchObject({
        reason: 'configured-path-invalid',
        status: 'missing',
      });
    expect(probe).not.toHaveBeenCalled();
  });

  it('rejects a relative configured executable path before probing it', async () => {
    const relativeGit = path.basename(manualGit);
    const probe = jest.fn();
    const resolver = new GitRuntimeResolver({
      findOnPath: () => pathGit,
      platform: process.platform,
      probe,
    });

    await expect(resolver.resolve({ configuredPath: relativeGit }))
      .resolves.toMatchObject({
        reason: 'configured-path-invalid',
        status: 'missing',
      });
    expect(probe).not.toHaveBeenCalled();
  });

  it('uses native Git for Windows candidates and never introduces WSL', () => {
    const candidates = getConventionalGitCandidates('win32', {
      LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    });

    expect(candidates).toEqual(expect.arrayContaining([
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Users\\Alice\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
    ]));
    expect(candidates.join('\n').toLocaleLowerCase('en-US')).not.toContain('wsl');
  });
});
