import {
  type ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcessTree,
} from '@/utils/windowsCmdShim';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STDOUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

export interface GitNetworkEnvironment {
  readonly headers: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly sslCaInfoPath?: string;
}

export interface GitCommandIdentity {
  readonly email: string;
  readonly name: string;
}

export interface IsolatedGitEnvironmentOptions {
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly emptyConfigPath: string;
  readonly identity?: GitCommandIdentity;
  readonly network?: GitNetworkEnvironment;
  readonly platform?: NodeJS.Platform;
  readonly suppressHooks?: boolean;
}

export interface GitCommandRunnerOptions {
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly emptyConfigPath: string;
  readonly executablePath: string;
  readonly taskkillTimeoutMs?: number;
  readonly terminationGraceMs?: number;
}

export interface GitCommandRequest {
  readonly acceptedExitCodes?: readonly number[];
  readonly args: readonly string[];
  readonly cwd: string;
  readonly identity?: GitCommandIdentity;
  readonly maxStderrBytes?: number;
  readonly maxStdoutBytes?: number;
  readonly network?: GitNetworkEnvironment;
  readonly sensitiveValues?: readonly string[];
  readonly signal?: AbortSignal;
  readonly stdin?: string | Uint8Array;
  readonly suppressHooks?: boolean;
  readonly timeoutMs?: number;
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: Buffer;
}

type GitCommandFailureKind = 'cancelled' | 'output-limit' | 'timeout';

function removeInheritedGitState(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toLocaleUpperCase('en-US');
    if (
      normalizedKey.startsWith('GIT_')
      || normalizedKey === 'SSH_ASKPASS'
      || normalizedKey === 'LC_ALL'
      || normalizedKey === 'LANG'
    ) {
      delete environment[key];
    }
  }
}

function invalidNetworkEnvironment(
  network: GitNetworkEnvironment,
): CollabError | null {
  if (
    network.headers.length < 1
    || network.headers.length > 4
    || network.headers.some(header => (
      !/^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(header.name)
      || header.value.length < 1
      || header.value.length > 4_096
      || header.value.includes('\u0000')
      || header.value.includes('\r')
      || header.value.includes('\n')
      || (header.name.toLocaleLowerCase('en-US') === 'authorization'
        && !/^(?:Basic|Bearer) [A-Za-z0-9._~+/-]+={0,2}$/u.test(header.value))
    ))
    || new Set(network.headers.map(header => header.name.toLocaleLowerCase('en-US'))).size
      !== network.headers.length
    || (network.sslCaInfoPath !== undefined && (
      network.sslCaInfoPath.length === 0
      || network.sslCaInfoPath.length > 4_096
      || !path.isAbsolute(network.sslCaInfoPath)
      || network.sslCaInfoPath.includes('\u0000')
      || network.sslCaInfoPath.includes('\r')
      || network.sslCaInfoPath.includes('\n')
    ))
  ) {
    return commandFailure('operation-failed', 'unsafe-git-network-environment');
  }
  return null;
}

function invalidIdentity(identity: GitCommandIdentity): CollabError | null {
  if ([identity.name, identity.email].some(value => (
    value.length === 0
    || value.length > 200
    || value.includes('\u0000')
    || value.includes('\r')
    || value.includes('\n')
  ))) {
    return commandFailure('operation-failed', 'unsafe-git-identity');
  }
  return null;
}

export function buildIsolatedGitEnvironment(
  options: IsolatedGitEnvironmentOptions,
): NodeJS.ProcessEnv {
  if (options.network) {
    const error = invalidNetworkEnvironment(options.network);
    if (error) throw error;
  }
  if (options.identity) {
    const error = invalidIdentity(options.identity);
    if (error) throw error;
  }
  const environment: NodeJS.ProcessEnv = {
    ...(options.baseEnvironment ?? process.env),
  };
  removeInheritedGitState(environment);

  const runtimeConfig: Array<{ key: string; value: string }> = [
    { key: 'credential.helper', value: '' },
    { key: 'credential.useHttpPath', value: 'true' },
    { key: 'core.askPass', value: '' },
    { key: 'fetch.fsckObjects', value: 'true' },
    { key: 'transfer.fsckObjects', value: 'true' },
  ];
  if (options.suppressHooks) {
    runtimeConfig.push({ key: 'core.hooksPath', value: options.emptyConfigPath });
  }
  if (options.network) {
    for (const header of options.network.headers) {
      runtimeConfig.push({
        key: 'http.extraHeader',
        value: `${header.name}: ${header.value}`,
      });
    }
    if (
      options.network.sslCaInfoPath !== undefined
      && (options.platform ?? process.platform) === 'win32'
    ) {
      runtimeConfig.push(
        { key: 'http.sslBackend', value: 'schannel' },
        { key: 'http.schannelCheckRevoke', value: 'false' },
        { key: 'http.schannelUseSSLCAInfo', value: 'true' },
      );
    }
    if (options.network.sslCaInfoPath !== undefined) {
      runtimeConfig.push({
        key: 'http.sslCAInfo',
        value: options.network.sslCaInfoPath,
      });
    }
  }

  Object.assign(environment, {
    GIT_ASKPASS: '',
    GIT_CONFIG_COUNT: String(runtimeConfig.length),
    GIT_CONFIG_GLOBAL: options.emptyConfigPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: options.emptyConfigPath,
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    SSH_ASKPASS: '',
  });
  if (options.identity) {
    Object.assign(environment, {
      GIT_AUTHOR_EMAIL: options.identity.email,
      GIT_AUTHOR_NAME: options.identity.name,
      GIT_COMMITTER_EMAIL: options.identity.email,
      GIT_COMMITTER_NAME: options.identity.name,
    });
  }
  for (const [index, entry] of runtimeConfig.entries()) {
    environment[`GIT_CONFIG_KEY_${index}`] = entry.key;
    environment[`GIT_CONFIG_VALUE_${index}`] = entry.value;
  }
  return environment;
}

function redactGitDiagnostic(
  diagnostic: string,
  sensitiveValues: readonly string[],
): string {
  let redacted = diagnostic.replace(
    /Authorization\s*:\s*(?:Basic|Bearer)\s+[^\s]+/gi,
    'Authorization: [REDACTED]',
  );
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length === 0) continue;
    redacted = redacted.split(sensitiveValue).join('[REDACTED]');
  }
  return redacted;
}

function summarizeGitFailure(diagnostic: string): string {
  const firstLine = diagnostic
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0) ?? '';
  const token = firstLine
    .replace(/https?:\/\/[^\s'"]+/gi, 'url')
    .replace(/\[[^\]]+\]/g, 'redacted')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  return token || 'git-command-failed';
}

function commandFailure(
  code: 'cancelled' | 'operation-failed' | 'operation-timeout' | 'quota-exceeded',
  reason: string,
  safeContext: Readonly<Record<string, unknown>> = {},
): CollabError {
  return new CollabError({
    code,
    safeContext: { reason, ...safeContext },
    recoveryActions: code === 'cancelled' ? ['retry'] : ['retry', 'open-diagnostics'],
  });
}

function validateGitArguments(
  args: readonly string[],
  sensitiveValues: readonly string[],
): CollabError | null {
  const forbiddenArguments = new Set([
    '-C',
    '-c',
    '--config-env',
    '--file',
    '--global',
    '--git-dir',
    '--system',
    '--work-tree',
  ]);
  for (const argument of args) {
    if (
      argument.includes('\u0000')
      || forbiddenArguments.has(argument)
      || argument.startsWith('--config-env=')
      || argument.startsWith('--git-dir=')
      || argument.startsWith('--work-tree=')
      || /Authorization\s*:/i.test(argument)
      || sensitiveValues.some(value => value.length > 0 && argument.includes(value))
    ) {
      return commandFailure('operation-failed', 'unsafe-git-argument');
    }
  }
  return null;
}

function appendBoundedChunk(
  chunks: Buffer[],
  chunk: Buffer | string,
  currentBytes: number,
  limitBytes: number,
): { bytes: number; exceeded: boolean } {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const nextBytes = currentBytes + buffer.length;
  if (nextBytes > limitBytes) return { bytes: currentBytes, exceeded: true };
  chunks.push(buffer);
  return { bytes: nextBytes, exceeded: false };
}

export function parseGitNulFields(output: Uint8Array): readonly string[] {
  if (output.byteLength === 0) return [];
  if (output[output.byteLength - 1] !== 0) {
    throw commandFailure('operation-failed', 'git-nul-output-unterminated');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const fields: string[] = [];
  let start = 0;
  try {
    for (let index = 0; index < output.byteLength; index += 1) {
      if (output[index] !== 0) continue;
      fields.push(decoder.decode(output.slice(start, index)));
      start = index + 1;
    }
  } catch {
    throw commandFailure('operation-failed', 'git-output-not-utf8');
  }
  return fields;
}

export class GitCommandRunner {
  private readonly activeProcesses = new Set<ChildProcessWithoutNullStreams>();
  private readonly baseEnvironment: NodeJS.ProcessEnv;
  private readonly taskkillTimeoutMs: number | undefined;
  private readonly terminationGraceMs: number;

  constructor(private readonly options: GitCommandRunnerOptions) {
    this.baseEnvironment = { ...(options.baseEnvironment ?? process.env) };
    this.taskkillTimeoutMs = options.taskkillTimeoutMs;
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  }

  get activeProcessCount(): number {
    return this.activeProcesses.size;
  }

  run(request: GitCommandRequest): Promise<GitCommandResult> {
    if (request.signal?.aborted) {
      return Promise.reject(commandFailure('cancelled', 'git-command-cancelled'));
    }

    const sensitiveValues = [
      ...(request.sensitiveValues ?? []),
      ...(request.network ? request.network.headers.map(header => header.value) : []),
    ];
    const argumentError = validateGitArguments(request.args, sensitiveValues);
    if (argumentError) return Promise.reject(argumentError);
    if (request.network) {
      const networkError = invalidNetworkEnvironment(request.network);
      if (networkError) return Promise.reject(networkError);
    }
    if (request.identity) {
      const identityError = invalidIdentity(request.identity);
      if (identityError) return Promise.reject(identityError);
    }

    const args = [...request.args];
    const environment = buildIsolatedGitEnvironment({
      baseEnvironment: this.baseEnvironment,
      emptyConfigPath: this.options.emptyConfigPath,
      identity: request.identity,
      network: request.network,
      suppressHooks: request.suppressHooks,
    });
    const spawnSpec = resolveWindowsCmdShimSpawnSpec({
      args,
      command: this.options.executablePath,
      killProcessTree: true,
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: request.cwd,
        env: environment,
        stdio: 'pipe',
        windowsHide: true,
        ...(spawnSpec.windowsVerbatimArguments
          ? { windowsVerbatimArguments: true }
          : {}),
      });
    } catch {
      return Promise.reject(commandFailure('operation-failed', 'git-spawn-failed'));
    }
    this.activeProcesses.add(child);

    return new Promise<GitCommandResult>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failureKind: GitCommandFailureKind | null = null;
      let spawnError = false;
      let settled = false;
      let terminationTask: Promise<boolean> | null = null;
      let terminationTimer: number | null = null;

      const terminate = (kind: GitCommandFailureKind): void => {
        if (failureKind !== null) return;
        failureKind = kind;
        try {
          terminationTask = terminateSpawnedProcessTree(
            child,
            'SIGTERM',
            spawn,
            spawnSpec,
            { taskkillTimeoutMs: this.taskkillTimeoutMs },
          );
        } catch {
          // The SIGKILL fallback below remains authoritative.
        }
        if (!spawnSpec.killProcessTree) {
          terminationTimer = window.setTimeout(() => {
            try {
              terminationTask = terminateSpawnedProcessTree(child, 'SIGKILL', spawn, spawnSpec);
            } catch {
              // Close/error still determines final cleanup.
            }
          }, this.terminationGraceMs);
        }
      };

      const timeout = window.setTimeout(
        () => terminate('timeout'),
        request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      const onAbort = (): void => terminate('cancelled');
      request.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer | string) => {
        const appended = appendBoundedChunk(
          stdoutChunks,
          chunk,
          stdoutBytes,
          request.maxStdoutBytes ?? DEFAULT_STDOUT_LIMIT_BYTES,
        );
        stdoutBytes = appended.bytes;
        if (appended.exceeded) terminate('output-limit');
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        const appended = appendBoundedChunk(
          stderrChunks,
          chunk,
          stderrBytes,
          request.maxStderrBytes ?? DEFAULT_STDERR_LIMIT_BYTES,
        );
        stderrBytes = appended.bytes;
        if (appended.exceeded) terminate('output-limit');
      });
      child.stdin.on('error', () => undefined);
      child.on('error', () => {
        spawnError = true;
      });
      child.on('close', exitCode => {
        void (async () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          if (terminationTimer !== null) window.clearTimeout(terminationTimer);
          request.signal?.removeEventListener('abort', onAbort);
          await terminationTask?.catch(() => false);
          this.activeProcesses.delete(child);

          const stderr = redactGitDiagnostic(
            Buffer.concat(stderrChunks).toString('utf8'),
            [
              ...sensitiveValues,
              ...(request.cwd.length > 1 ? [request.cwd] : []),
              ...(request.network?.sslCaInfoPath
                ? [request.network.sslCaInfoPath]
                : []),
            ],
          );
          if (failureKind === 'cancelled') {
            reject(commandFailure('cancelled', 'git-command-cancelled'));
            return;
          }
          if (failureKind === 'timeout') {
            reject(commandFailure('operation-timeout', 'git-command-timeout'));
            return;
          }
          if (failureKind === 'output-limit') {
            reject(commandFailure('quota-exceeded', 'git-output-limit'));
            return;
          }
          if (spawnError || exitCode === null) {
            reject(commandFailure('operation-failed', 'git-spawn-failed'));
            return;
          }
          if (!(request.acceptedExitCodes ?? [0]).includes(exitCode)) {
            reject(commandFailure('operation-failed', 'git-command-failed', {
              exitCode,
              status: summarizeGitFailure(stderr),
              stderr,
            }));
            return;
          }
          resolve({
            exitCode,
            stderr,
            stdout: Buffer.concat(stdoutChunks),
          });
        })();
      });

      if (request.stdin === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(request.stdin);
      }
    });
  }
}
