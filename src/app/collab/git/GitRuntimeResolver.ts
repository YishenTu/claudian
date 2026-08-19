import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdtemp,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { findCliBinaryPath } from '@/utils/cliBinaryLocator';

export const MINIMUM_COLLAB_GIT_VERSION = '2.38.0' as const;

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

export interface GitRuntimeCapabilities {
  readonly catFileBatch: boolean;
  readonly commitTree: boolean;
  readonly diffTreeNul: boolean;
  readonly httpBackend: boolean;
  readonly mergeTreeWriteTree: boolean;
  readonly statusPorcelainV2Nul: boolean;
}

export interface GitRuntimeProbeResult {
  readonly capabilities: GitRuntimeCapabilities;
  readonly execPath: string;
  readonly httpBackendPath: string | null;
  readonly version: GitVersion;
}

export interface GitRuntime extends GitRuntimeProbeResult {
  readonly executablePath: string;
}

export type GitRuntimeSource = 'configured' | 'conventional' | 'path';

export type GitRuntimeResolution =
  | {
    readonly status: 'available';
    readonly source: GitRuntimeSource;
    readonly runtime: GitRuntime;
  }
  | {
    readonly status: 'missing';
    readonly reason: 'configured-path-invalid' | 'not-found' | 'runtime-unusable';
  }
  | {
    readonly status: 'incompatible';
    readonly minimumVersion: typeof MINIMUM_COLLAB_GIT_VERSION;
    readonly missingCapabilities: readonly GitRequiredCapability[];
    readonly source: GitRuntimeSource;
    readonly version: string;
  };

export interface GitRuntimeResolveInput {
  readonly configuredPath?: string;
  readonly pathEnvironment?: string;
}

export type GitRequiredCapability =
  | 'cat-file-batch'
  | 'commit-tree'
  | 'diff-tree-nul'
  | 'http-backend'
  | 'merge-tree-write-tree'
  | 'status-porcelain-v2-nul';

export interface GitRuntimeResolverOptions {
  readonly conventionalCandidates?: () => readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly findOnPath?: (pathEnvironment?: string) => string | null;
  readonly platform?: NodeJS.Platform;
  readonly probe?: (executablePath: string) => Promise<GitRuntimeProbeResult>;
}

interface GitCandidate {
  readonly path: string;
  readonly source: GitRuntimeSource;
}

const REQUIRED_CAPABILITIES: ReadonlyArray<{
  readonly key: keyof GitRuntimeCapabilities;
  readonly name: GitRequiredCapability;
}> = [
  { key: 'catFileBatch', name: 'cat-file-batch' },
  { key: 'commitTree', name: 'commit-tree' },
  { key: 'diffTreeNul', name: 'diff-tree-nul' },
  { key: 'httpBackend', name: 'http-backend' },
  { key: 'mergeTreeWriteTree', name: 'merge-tree-write-tree' },
  { key: 'statusPorcelainV2Nul', name: 'status-porcelain-v2-nul' },
];

function getEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const exact = environment[key];
  if (exact) return exact;
  const matchingKey = Object.keys(environment).find(
    candidate => candidate.toLocaleLowerCase('en-US') === key.toLocaleLowerCase('en-US'),
  );
  return matchingKey ? environment[matchingKey] : undefined;
}

export function getConventionalGitCandidates(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  if (platform === 'win32') {
    const windowsPaths = path.win32;
    const candidates: string[] = [];
    const programFiles = getEnvironmentValue(environment, 'ProgramFiles');
    const programFilesX86 = getEnvironmentValue(environment, 'ProgramFiles(x86)');
    const localAppData = getEnvironmentValue(environment, 'LOCALAPPDATA');
    for (const root of [programFiles, programFilesX86]) {
      if (!root) continue;
      candidates.push(
        windowsPaths.join(root, 'Git', 'cmd', 'git.exe'),
        windowsPaths.join(root, 'Git', 'bin', 'git.exe'),
      );
    }
    if (localAppData) {
      candidates.push(windowsPaths.join(
        localAppData,
        'Programs',
        'Git',
        'cmd',
        'git.exe',
      ));
    }
    return candidates;
  }

  if (platform === 'darwin') {
    return [
      '/usr/bin/git',
      '/opt/homebrew/bin/git',
      '/usr/local/bin/git',
      path.join(homedir(), '.local', 'bin', 'git'),
    ];
  }

  return [
    '/usr/bin/git',
    '/usr/local/bin/git',
    '/snap/bin/git',
    path.join(homedir(), '.local', 'bin', 'git'),
  ];
}

async function isExecutableFile(
  candidate: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    if (!(await stat(candidate)).isFile()) return false;
    if (platform !== 'win32') await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isAbsolutePath(candidate: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? path.win32.isAbsolute(candidate)
    : path.posix.isAbsolute(candidate);
}

function parseGitVersion(output: string): GitVersion {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/i.exec(output.trim());
  if (!match) throw new Error('Unsupported Git version output');
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    raw: output.trim(),
  };
}

function isSupportedVersion(version: GitVersion): boolean {
  return version.major > 2 || (version.major === 2 && version.minor >= 38);
}

function missingCapabilities(
  capabilities: GitRuntimeCapabilities,
): readonly GitRequiredCapability[] {
  return REQUIRED_CAPABILITIES
    .filter(capability => !capabilities[capability.key])
    .map(capability => capability.name);
}

function displayVersion(version: GitVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function nullGitConfigPath(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}

async function settleProbeWave<const T extends readonly unknown[]>(
  operations: { readonly [Key in keyof T]: Promise<T[Key]> },
): Promise<T> {
  const settled = await Promise.allSettled(operations);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) {
    throw rejected.reason instanceof Error
      ? rejected.reason
      : new Error('Git runtime probe failed', { cause: rejected.reason });
  }
  return settled.map(result => (
    result as PromiseFulfilledResult<unknown>
  ).value) as unknown as T;
}

export async function probeGitRuntime(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<GitRuntimeProbeResult> {
  const probeDirectory = await mkdtemp(path.join(tmpdir(), 'claudian-git-probe-'));
  const runner = new GitCommandRunner({
    emptyConfigPath: nullGitConfigPath(platform),
    executablePath,
  });
  try {
    const [versionOutput, execPathOutput, commandOutput] = await settleProbeWave([
      runner.run({
        args: ['--version'],
        cwd: probeDirectory,
        maxStdoutBytes: 4 * 1024,
      }),
      runner.run({
        args: ['--exec-path'],
        cwd: probeDirectory,
        maxStdoutBytes: 16 * 1024,
      }),
      runner.run({
        args: ['--list-cmds=main,others,nohelpers'],
        cwd: probeDirectory,
        maxStdoutBytes: 128 * 1024,
      }),
      runner.run({ args: ['init', '--quiet'], cwd: probeDirectory }),
    ] as const);
    const version = parseGitVersion(versionOutput.stdout.toString('utf8'));
    const execPath = execPathOutput.stdout.toString('utf8').trim();
    if (!execPath || !path.isAbsolute(execPath)) {
      throw new Error('Git exec path is invalid');
    }
    const backendName = platform === 'win32' ? 'git-http-backend.exe' : 'git-http-backend';
    const backendCandidate = path.join(execPath, backendName);
    const commands = new Set(
      commandOutput.stdout.toString('utf8').split(/\r?\n/).filter(Boolean),
    );
    const [httpBackend, statusPorcelainV2Nul, diffTreeNul, catFileBatch, mergeTreeHelp] =
      await settleProbeWave([
        isExecutableFile(backendCandidate, platform),
        runner.run({
          args: ['status', '--porcelain=v2', '-z'],
          cwd: probeDirectory,
        }).then(() => true, () => false),
        runner.run({
          args: ['diff-tree', '--stdin', '-z'],
          cwd: probeDirectory,
          stdin: '',
        }).then(() => true, () => false),
        runner.run({
          args: ['cat-file', '--batch-check'],
          cwd: probeDirectory,
          stdin: '',
        }).then(() => true, () => false),
        runner.run({
          acceptedExitCodes: [0, 129],
          args: ['merge-tree', '-h'],
          cwd: probeDirectory,
          maxStderrBytes: 64 * 1024,
          maxStdoutBytes: 64 * 1024,
        }).then(result => `${result.stdout.toString('utf8')}\n${result.stderr}`, () => ''),
      ] as const);
    const httpBackendPath = httpBackend ? backendCandidate : null;

    return {
      capabilities: {
        catFileBatch,
        commitTree: commands.has('commit-tree'),
        diffTreeNul,
        httpBackend: httpBackendPath !== null,
        mergeTreeWriteTree: commands.has('merge-tree')
          && mergeTreeHelp.includes('--write-tree'),
        statusPorcelainV2Nul,
      },
      execPath,
      httpBackendPath,
      version,
    };
  } finally {
    await rm(probeDirectory, { force: true, recursive: true });
  }
}

export class GitRuntimeResolver {
  private cachedKey: string | null = null;
  private cachedResolution: Promise<GitRuntimeResolution> | null = null;
  private readonly conventionalCandidates: () => readonly string[];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly findOnPath: (pathEnvironment?: string) => string | null;
  private lastInput: GitRuntimeResolveInput = {};
  private readonly platform: NodeJS.Platform;
  private readonly probe: (executablePath: string) => Promise<GitRuntimeProbeResult>;

  constructor(options: GitRuntimeResolverOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.environment = { ...(options.environment ?? process.env) };
    this.findOnPath = options.findOnPath
      ?? (pathEnvironment => findCliBinaryPath('git', pathEnvironment, this.platform));
    this.conventionalCandidates = options.conventionalCandidates
      ?? (() => getConventionalGitCandidates(this.platform, this.environment));
    this.probe = options.probe ?? (candidate => probeGitRuntime(candidate, this.platform));
  }

  resolve(input: GitRuntimeResolveInput = {}): Promise<GitRuntimeResolution> {
    this.lastInput = { ...input };
    const cacheKey = JSON.stringify({
      configuredPath: input.configuredPath?.trim() ?? '',
      pathEnvironment: input.pathEnvironment ?? this.environment.PATH ?? '',
      platform: this.platform,
    });
    if (this.cachedKey === cacheKey && this.cachedResolution) {
      return this.cachedResolution;
    }
    this.cachedKey = cacheKey;
    this.cachedResolution = this.scan(input);
    return this.cachedResolution;
  }

  rescan(input: GitRuntimeResolveInput = this.lastInput): Promise<GitRuntimeResolution> {
    this.cachedKey = null;
    this.cachedResolution = null;
    return this.resolve(input);
  }

  private async scan(input: GitRuntimeResolveInput): Promise<GitRuntimeResolution> {
    const configuredPath = input.configuredPath?.trim();
    if (configuredPath) {
      if (
        !isAbsolutePath(configuredPath, this.platform)
        || !await isExecutableFile(configuredPath, this.platform)
      ) {
        return { reason: 'configured-path-invalid', status: 'missing' };
      }
      return this.resolveCandidates([{ path: configuredPath, source: 'configured' }], true);
    }

    const candidates: GitCandidate[] = [];
    const pathCandidate = this.findOnPath(input.pathEnvironment ?? this.environment.PATH);
    if (pathCandidate) candidates.push({ path: pathCandidate, source: 'path' });
    candidates.push(...this.conventionalCandidates().map(candidate => ({
      path: candidate,
      source: 'conventional' as const,
    })));
    const seen = new Set<string>();
    const executableCandidates: GitCandidate[] = [];
    for (const candidate of candidates) {
      const key = this.platform === 'win32'
        ? candidate.path.toLocaleLowerCase('en-US')
        : candidate.path;
      if (seen.has(key)) continue;
      seen.add(key);
      if (
        isAbsolutePath(candidate.path, this.platform)
        && await isExecutableFile(candidate.path, this.platform)
      ) {
        executableCandidates.push(candidate);
      }
    }
    if (executableCandidates.length === 0) {
      return { reason: 'not-found', status: 'missing' };
    }
    return this.resolveCandidates(executableCandidates, false);
  }

  private async resolveCandidates(
    candidates: readonly GitCandidate[],
    configuredOnly: boolean,
  ): Promise<GitRuntimeResolution> {
    let incompatible: GitRuntimeResolution | null = null;
    let probeFailed = false;
    for (const candidate of candidates) {
      let probe: GitRuntimeProbeResult;
      try {
        probe = await this.probe(candidate.path);
      } catch {
        probeFailed = true;
        continue;
      }
      const unavailableCapabilities = missingCapabilities(probe.capabilities);
      if (!isSupportedVersion(probe.version) || unavailableCapabilities.length > 0) {
        incompatible ??= {
          minimumVersion: MINIMUM_COLLAB_GIT_VERSION,
          missingCapabilities: unavailableCapabilities,
          source: candidate.source,
          status: 'incompatible',
          version: displayVersion(probe.version),
        };
        if (configuredOnly) return incompatible;
        continue;
      }
      return {
        runtime: { ...probe, executablePath: candidate.path },
        source: candidate.source,
        status: 'available',
      };
    }
    if (incompatible) return incompatible;
    return {
      reason: probeFailed ? 'runtime-unusable' : 'not-found',
      status: 'missing',
    };
  }
}
