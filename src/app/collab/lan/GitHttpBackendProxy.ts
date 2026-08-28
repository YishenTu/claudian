import {
  type ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import { collabMemberRef, isCollabProjectId } from '@claudian-collab/protocol';

import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import {
  authenticateGitBasicRequest,
  type GitMembershipAuthenticator,
} from '@/app/collab/lan/git/GitBasicAuthentication';
import {
  isGitHttpRoute,
  type ParsedGitHttpRoute,
  parseGitHttpRoute,
} from '@/app/collab/lan/git/GitHttpRoute';
import {
  buildGitReceiveHookEnvironment,
  createProtectedReceiveHook,
} from '@/app/collab/lan/git/GitReceiveHookPolicy';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcessTree,
  type WindowsCmdShimSpawnSpec,
} from '@/utils/windowsCmdShim';

const MAX_CGI_HEADER_BYTES = 32 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_GLOBAL_CHILD_LIMIT = 8;
const DEFAULT_MEMBER_CHILD_LIMIT = 2;
const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

type RepositoryBoundary = Pick<
  GitRepositoryService,
  | 'assertHealthy'
  | 'configureHostedRepository'
  | 'installHook'
  | 'measureStorageBytes'
>;

export interface GitHttpBackendProxyOptions {
  readonly authorityDirectory: string;
  readonly authenticateMemberCredential:
    GitMembershipAuthenticator['authenticateMemberCredential'];
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly emptyConfigPath: string;
  readonly gitExecutablePath: string;
  readonly gitHttpBackendPath: string;
  readonly maxConcurrentChildren?: number;
  readonly maxConcurrentChildrenPerMember?: number;
  readonly maxHostRepositoryBytes?: number;
  readonly maxReceivedPackBytes?: number;
  readonly onChildStarted?: (
    memberId: string,
    close: () => void,
  ) => void | (() => void);
  readonly prepareMemberRef: (memberId: string) => Promise<void>;
  readonly projectId: string;
  readonly repository: RepositoryBoundary;
  readonly requestTimeoutMs?: number;
  readonly terminationGraceMs?: number;
}

interface EnabledGitProject {
  readonly authorityDirectory: string;
  readonly repositoryPath: string;
}

interface ActiveGitChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  readonly memberId: string;
  readonly spawnSpec: WindowsCmdShimSpawnSpec;
  terminationTask: Promise<boolean> | null;
  terminated: boolean;
  terminationTimer: number | null;
  unregisterOwnedResource?: () => void;
}

interface ParsedCgiHeaders {
  readonly headers: Readonly<Record<string, string>>;
  readonly statusCode: number;
}

function proxyError(
  code:
    | 'operation-failed'
    | 'path-invalid'
    | 'quota-exceeded'
    | 'repository-invalid',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'quota-exceeded' ? ['retry'] : ['open-diagnostics'],
    safeContext: { reason },
  });
}

function storageQuotaError(actual: number, limit: number): CollabError {
  return new CollabError({
    code: 'quota-exceeded',
    recoveryActions: ['open-diagnostics'],
    safeContext: {
      actual,
      limit,
      quota: 'hostRepositorySoftLimitBytes',
      reason: 'host-repository-storage-limit',
    },
  });
}

function isContainedPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative.length > 0
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function removeInheritedGitAndAuthState(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    const normalized = key.toLocaleUpperCase('en-US');
    if (
      normalized.startsWith('GIT_')
      || normalized.startsWith('CLAUDIAN_COLLAB_')
      || normalized === 'AUTHORIZATION'
      || normalized === 'HTTP_AUTHORIZATION'
      || normalized === 'REMOTE_USER'
      || normalized === 'SSH_ASKPASS'
      || normalized === 'LC_ALL'
      || normalized === 'LANG'
    ) {
      delete environment[key];
    }
  }
}

function normalizedRemoteAddress(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? '';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function singleHeader(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

function parseContentLength(request: IncomingMessage): number | null {
  const value = singleHeader(request, 'content-length');
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw proxyError('path-invalid', 'git-content-length-invalid');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw proxyError('quota-exceeded', 'git-request-body-limit');
  }
  return parsed;
}

function validateRequestHeaders(
  request: IncomingMessage,
  route: ParsedGitHttpRoute,
  maxReceivedPackBytes: number,
): number {
  const contentLength = parseContentLength(request);
  const transferEncoding = singleHeader(request, 'transfer-encoding');
  if (transferEncoding !== null && transferEncoding.toLocaleLowerCase('en-US') !== 'chunked') {
    throw proxyError('path-invalid', 'git-transfer-encoding-invalid');
  }
  if (contentLength !== null && transferEncoding !== null) {
    throw proxyError('path-invalid', 'git-request-framing-invalid');
  }
  if (route.phase === 'advertisement') {
    if ((contentLength ?? 0) !== 0 || transferEncoding !== null) {
      throw proxyError('path-invalid', 'git-advertisement-body-invalid');
    }
    return 0;
  }
  const expectedContentType = `application/x-${route.service}-request`;
  if (singleHeader(request, 'content-type') !== expectedContentType) {
    throw proxyError('path-invalid', 'git-content-type-invalid');
  }
  if (contentLength !== null && contentLength > maxReceivedPackBytes) {
    throw proxyError('quota-exceeded', 'git-request-body-limit');
  }
  return contentLength ?? -1;
}

function parseCgiHeaders(buffer: Buffer): ParsedCgiHeaders {
  const text = buffer.toString('latin1');
  if (text.includes('\u0000')) throw proxyError('operation-failed', 'git-cgi-header-invalid');
  const headers: Record<string, string> = {};
  let statusCode = 200;
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw proxyError('operation-failed', 'git-cgi-header-invalid');
    const name = line.slice(0, separator).trim().toLocaleLowerCase('en-US');
    const value = line.slice(separator + 1).trim();
    if (!/^[a-z][a-z0-9-]*$/.test(name) || /[\r\n]/.test(value)) {
      throw proxyError('operation-failed', 'git-cgi-header-invalid');
    }
    if (name === 'status') {
      const match = /^([1-5]\d\d)(?:\s|$)/.exec(value);
      if (!match) throw proxyError('operation-failed', 'git-cgi-status-invalid');
      statusCode = Number(match[1]);
      continue;
    }
    if (
      name !== 'cache-control'
      && name !== 'content-length'
      && name !== 'content-type'
      && name !== 'expires'
      && name !== 'pragma'
    ) {
      continue;
    }
    if (headers[name] !== undefined) {
      throw proxyError('operation-failed', 'git-cgi-header-duplicate');
    }
    headers[name] = value;
  }
  if (!headers['content-type']) {
    throw proxyError('operation-failed', 'git-cgi-content-type-missing');
  }
  return { headers, statusCode };
}

function responseForError(
  response: ServerResponse,
  statusCode: number,
  message: string,
  authenticate = false,
): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.statusCode = statusCode;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (authenticate) response.setHeader('WWW-Authenticate', 'Basic realm="Claudian Collab"');
  response.end(`${message}\n`);
}

export class GitHttpBackendProxy {
   readonly #activeChildren = new Set<ActiveGitChild>();
  private closed = false;
  private enabled: EnabledGitProject | null = null;
   readonly #maxConcurrentChildren: number;
   readonly #maxConcurrentChildrenPerMember: number;
   readonly #maxHostRepositoryBytes: number;
  private readonly maxReceivedPackBytes: number;
   readonly #reservedChildrenByMember = new Map<string, number>();
   #reservedChildCount = 0;
   readonly #requestTimeoutMs: number;
   #reservedReceiveBytes = 0;
   readonly #terminationGraceMs: number;

  constructor(private readonly options: GitHttpBackendProxyOptions) {
    this.#maxConcurrentChildren = options.maxConcurrentChildren
      ?? DEFAULT_GLOBAL_CHILD_LIMIT;
    this.#maxConcurrentChildrenPerMember = options.maxConcurrentChildrenPerMember
      ?? DEFAULT_MEMBER_CHILD_LIMIT;
    this.#maxHostRepositoryBytes = options.maxHostRepositoryBytes
      ?? CLAUDIAN_COLLAB_LIMITS.hostRepositorySoftLimitBytes;
    this.maxReceivedPackBytes = options.maxReceivedPackBytes
      ?? CLAUDIAN_COLLAB_LIMITS.maxReceivedPackBytes;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#terminationGraceMs = options.terminationGraceMs
      ?? DEFAULT_TERMINATION_GRACE_MS;
  }

  get activeChildCount(): number {
    return this.#activeChildren.size;
  }

  async enable(): Promise<void> {
    if (this.closed) throw proxyError('operation-failed', 'git-proxy-closed');
    if (
      !isCollabProjectId(this.options.projectId)
      || !path.isAbsolute(this.options.authorityDirectory)
      || !path.isAbsolute(this.options.emptyConfigPath)
      || !path.isAbsolute(this.options.gitExecutablePath)
      || !path.isAbsolute(this.options.gitHttpBackendPath)
      || !Number.isSafeInteger(this.#maxConcurrentChildren)
      || this.#maxConcurrentChildren < 1
      || !Number.isSafeInteger(this.#maxConcurrentChildrenPerMember)
      || this.#maxConcurrentChildrenPerMember < 1
      || !Number.isSafeInteger(this.maxReceivedPackBytes)
      || this.maxReceivedPackBytes < 1
      || !Number.isSafeInteger(this.#maxHostRepositoryBytes)
      || this.#maxHostRepositoryBytes < 1
      || !Number.isSafeInteger(this.#requestTimeoutMs)
      || this.#requestTimeoutMs < 1
      || !Number.isSafeInteger(this.#terminationGraceMs)
      || this.#terminationGraceMs < 0
    ) {
      throw proxyError('repository-invalid', 'git-proxy-configuration-invalid');
    }
    const authorityStat = await lstat(this.options.authorityDirectory).catch(() => null);
    const repositoryInput = path.join(this.options.authorityDirectory, 'repository.git');
    const repositoryStat = await lstat(repositoryInput).catch(() => null);
    const backendStat = await stat(this.options.gitHttpBackendPath).catch(() => null);
    const executableStat = await stat(this.options.gitExecutablePath).catch(() => null);
    if (
      !authorityStat?.isDirectory()
      || authorityStat.isSymbolicLink()
      || !repositoryStat?.isDirectory()
      || repositoryStat.isSymbolicLink()
      || !backendStat?.isFile()
      || !executableStat?.isFile()
    ) {
      throw proxyError('repository-invalid', 'git-proxy-boundary-invalid');
    }
    const authorityDirectory = await realpath(this.options.authorityDirectory);
    const repositoryPath = await realpath(repositoryInput);
    if (
      !isContainedPath(authorityDirectory, repositoryPath)
      || repositoryPath !== path.join(authorityDirectory, 'repository.git')
    ) {
      throw proxyError('repository-invalid', 'git-proxy-boundary-invalid');
    }
    await this.options.repository.configureHostedRepository(repositoryPath);
    await this.options.repository.installHook(
      repositoryPath,
      'pre-receive',
      createProtectedReceiveHook(),
    );
    await this.options.repository.assertHealthy(repositoryPath);
    const storageBytes = await this.options.repository.measureStorageBytes(repositoryPath);
    if (storageBytes > this.#maxHostRepositoryBytes) {
      throw storageQuotaError(storageBytes, this.#maxHostRepositoryBytes);
    }
    this.enabled = { authorityDirectory, repositoryPath };
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!isGitHttpRoute(request.url)) return false;
    let route: ParsedGitHttpRoute;
    try {
      route = parseGitHttpRoute(request.method ?? '', request.url!);
    } catch {
      responseForError(response, 404, 'Git route not found.');
      return true;
    }
    if (route.projectId !== this.options.projectId) {
      responseForError(response, 404, 'Git project not found.');
      return true;
    }
    if (this.closed || !this.enabled) {
      responseForError(response, 503, 'Git hosting is unavailable.');
      return true;
    }

    let memberId: string;
    let contentLength: number;
    try {
      contentLength = validateRequestHeaders(
        request,
        route,
        this.maxReceivedPackBytes,
      );
      const authenticated = await authenticateGitBasicRequest({
        authorization: singleHeader(request, 'authorization'),
        authenticateMemberCredential: this.options.authenticateMemberCredential,
        service: route.service,
      });
      memberId = authenticated.memberId;
    } catch (error) {
      if (error instanceof CollabError && error.code === 'quota-exceeded') {
        responseForError(response, 413, 'Git request is too large.');
      } else if (error instanceof CollabError && error.code === 'path-invalid') {
        responseForError(response, 400, 'Git request is invalid.');
      } else {
        responseForError(response, 401, 'Git authentication failed.', true);
      }
      return true;
    }

    if (!this.#reserveChild(memberId)) {
      responseForError(response, 429, 'Too many Git operations.');
      return true;
    }
    let reserved = true;
    let receiveReservationBytes = 0;
    try {
      await this.options.prepareMemberRef(memberId);
      if (this.closed || !this.enabled) {
        throw proxyError('operation-failed', 'git-proxy-disabled');
      }
      if (route.phase === 'rpc' && route.service === 'git-receive-pack') {
        receiveReservationBytes = await this.#reserveReceiveStorage(contentLength);
      }
      const reauthenticated = await authenticateGitBasicRequest({
        authorization: singleHeader(request, 'authorization'),
        authenticateMemberCredential: this.options.authenticateMemberCredential,
        service: route.service,
      });
      if (reauthenticated.memberId !== memberId) {
        throw proxyError('operation-failed', 'git-member-changed-during-admission');
      }
      if (this.closed || !this.enabled) {
        throw proxyError('operation-failed', 'git-proxy-disabled');
      }
      this.#releaseReservation(memberId);
      reserved = false;
      await this.#runBackend(
        request,
        response,
        route,
        memberId,
        contentLength,
        receiveReservationBytes > 0 ? receiveReservationBytes : null,
      );
    } catch (error) {
      if (error instanceof CollabError && error.code === 'quota-exceeded') {
        responseForError(response, 413, 'Git repository quota exceeded.');
      } else if (
        error instanceof CollabError
        && (
          error.code === 'authentication-failed'
          || error.code === 'authorization-denied'
          || error.code === 'membership-revoked'
        )
      ) {
        responseForError(response, 401, 'Git authentication failed.', true);
      } else {
        responseForError(response, 502, 'Git operation failed.');
      }
    } finally {
      this.#releaseReceiveStorage(receiveReservationBytes);
      if (reserved) this.#releaseReservation(memberId);
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.enabled = null;
    const children = [...this.#activeChildren];
    for (const child of children) this.terminate(child);
    await Promise.all(children.map(child => child.closed));
  }

   #hasChildCapacity(memberId: string): boolean {
    if (
      this.#activeChildren.size + this.#reservedChildCount
      >= this.#maxConcurrentChildren
    ) {
      return false;
    }
    let memberChildren = this.#reservedChildrenByMember.get(memberId) ?? 0;
    for (const active of this.#activeChildren) {
      if (active.memberId === memberId) memberChildren += 1;
    }
    return memberChildren < this.#maxConcurrentChildrenPerMember;
  }

   #reserveChild(memberId: string): boolean {
    if (!this.#hasChildCapacity(memberId)) return false;
    this.#reservedChildCount += 1;
    this.#reservedChildrenByMember.set(
      memberId,
      (this.#reservedChildrenByMember.get(memberId) ?? 0) + 1,
    );
    return true;
  }

   #releaseReservation(memberId: string): void {
    const count = this.#reservedChildrenByMember.get(memberId) ?? 0;
    if (count <= 0 || this.#reservedChildCount <= 0) return;
    this.#reservedChildCount -= 1;
    if (count === 1) this.#reservedChildrenByMember.delete(memberId);
    else this.#reservedChildrenByMember.set(memberId, count - 1);
  }

   async #reserveReceiveStorage(contentLength: number): Promise<number> {
    const enabled = this.enabled;
    if (!enabled) throw proxyError('operation-failed', 'git-proxy-disabled');
    const storageBytes = await this.options.repository.measureStorageBytes(
      enabled.repositoryPath,
    );
    const available = this.#maxHostRepositoryBytes
      - storageBytes
      - this.#reservedReceiveBytes;
    const requested = contentLength >= 0
      ? Math.max(1, contentLength)
      : Math.min(this.maxReceivedPackBytes, available);
    if (available < 1 || requested > available) {
      throw storageQuotaError(
        storageBytes + this.#reservedReceiveBytes + Math.max(requested, 0),
        this.#maxHostRepositoryBytes,
      );
    }
    this.#reservedReceiveBytes += requested;
    return requested;
  }

   #releaseReceiveStorage(bytes: number): void {
    if (bytes <= 0) return;
    this.#reservedReceiveBytes = Math.max(0, this.#reservedReceiveBytes - bytes);
  }

   #buildEnvironment(
    request: IncomingMessage,
    route: ParsedGitHttpRoute,
    memberId: string,
    contentLength: number,
    receiveMaxInputBytes: number | null,
  ): NodeJS.ProcessEnv {
    const enabled = this.enabled;
    if (!enabled) throw proxyError('operation-failed', 'git-proxy-disabled');
    const environment = { ...(this.options.baseEnvironment ?? process.env) };
    removeInheritedGitAndAuthState(environment);
    const inheritedPathKey = Object.keys(environment).find(
      key => key.toLocaleLowerCase('en-US') === 'path',
    );
    const inheritedPath = inheritedPathKey ? environment[inheritedPathKey] ?? '' : '';
    if (inheritedPathKey) delete environment[inheritedPathKey];
    const hookGit = buildGitReceiveHookEnvironment(
      this.options.gitExecutablePath,
      inheritedPath,
    );
    const gitProtocol = singleHeader(request, 'git-protocol');
    if (
      gitProtocol !== null
      && (
        gitProtocol.length > 256
        || !/^[\x20-\x7e]+$/.test(gitProtocol)
      )
    ) {
      throw proxyError('path-invalid', 'git-protocol-header-invalid');
    }
    Object.assign(environment, {
      CLAUDIAN_COLLAB_GIT_EXECUTABLE: hookGit.executable,
      CLAUDIAN_COLLAB_MEMBER_ID: memberId,
      CLAUDIAN_COLLAB_MEMBER_REF: collabMemberRef(memberId),
      CLAUDIAN_COLLAB_PROJECT_ID: this.options.projectId,
      CONTENT_LENGTH: contentLength < 0 ? '' : String(contentLength),
      CONTENT_TYPE: singleHeader(request, 'content-type') ?? '',
      GATEWAY_INTERFACE: 'CGI/1.1',
      GIT_CONFIG_GLOBAL: this.options.emptyConfigPath,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: this.options.emptyConfigPath,
      GIT_EXEC_PATH: path.dirname(this.options.gitHttpBackendPath),
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_PROJECT_ROOT: enabled.authorityDirectory,
      LANG: 'C',
      LC_ALL: 'C',
      PATH_INFO: `/repository.git${route.pathSuffix}`,
      PATH: hookGit.path,
      QUERY_STRING: route.queryString,
      REMOTE_ADDR: normalizedRemoteAddress(request),
      REMOTE_USER: memberId,
      REQUEST_METHOD: request.method ?? '',
      SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
      SERVER_SOFTWARE: 'Claudian',
    });
    if (gitProtocol !== null) environment.GIT_PROTOCOL = gitProtocol;
    if (receiveMaxInputBytes !== null) {
      Object.assign(environment, {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'receive.fsckObjects',
        GIT_CONFIG_KEY_1: 'receive.maxInputSize',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_VALUE_1: String(receiveMaxInputBytes),
      });
    }
    return environment;
  }

   #runBackend(
    request: IncomingMessage,
    response: ServerResponse,
    route: ParsedGitHttpRoute,
    memberId: string,
    contentLength: number,
    receiveMaxInputBytes: number | null,
  ): Promise<void> {
    const spawnSpec = resolveWindowsCmdShimSpawnSpec({
      args: [],
      command: this.options.gitHttpBackendPath,
      killProcessTree: true,
    });
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: this.enabled!.authorityDirectory,
      env: this.#buildEnvironment(
        request,
        route,
        memberId,
        contentLength,
        receiveMaxInputBytes,
      ),
      stdio: 'pipe',
      windowsHide: true,
      ...(spawnSpec.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true }
        : {}),
    });

    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => {
      resolveClosed = resolve;
    });
    const active: ActiveGitChild = {
      child,
      closed,
      memberId,
      spawnSpec,
      terminationTask: null,
      terminated: false,
      terminationTimer: null,
    };
    this.#activeChildren.add(active);

    return new Promise((resolve, reject) => {
      let bodyBytes = 0;
      let cgiHeader = Buffer.alloc(0);
      let cgiHeadersSent = false;
      let settled = false;
      let stderrBytes = 0;
      const requestTimer = window.setTimeout(
        () => this.terminate(active),
        this.#requestTimeoutMs,
      );

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(requestTimer);
        if (active.terminationTimer !== null) window.clearTimeout(active.terminationTimer);
        active.unregisterOwnedResource?.();
        this.#activeChildren.delete(active);
        resolveClosed();
        if (error) reject(error);
        else resolve();
      };
      const abort = (): void => this.terminate(active);
      request.once('aborted', abort);
      request.once('error', abort);
      response.once('close', () => {
        if (!response.writableEnded) abort();
      });

      request.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytes += buffer.byteLength;
        if (bodyBytes > this.maxReceivedPackBytes) {
          this.terminate(active);
          return;
        }
        if (!child.stdin.write(buffer)) {
          request.pause();
          child.stdin.once('drain', () => request.resume());
        }
      });
      request.once('end', () => child.stdin.end());
      child.stdin.on('error', () => undefined);

      child.stdout.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let body = buffer;
        if (!cgiHeadersSent) {
          cgiHeader = Buffer.concat([cgiHeader, buffer]);
          if (cgiHeader.byteLength > MAX_CGI_HEADER_BYTES) {
            this.terminate(active);
            return;
          }
          const crlfSeparator = cgiHeader.indexOf('\r\n\r\n');
          const lfSeparator = crlfSeparator < 0 ? cgiHeader.indexOf('\n\n') : -1;
          const separator = crlfSeparator >= 0 ? crlfSeparator : lfSeparator;
          if (separator < 0) return;
          const separatorBytes = crlfSeparator >= 0 ? 4 : 2;
          let parsed: ParsedCgiHeaders;
          try {
            parsed = parseCgiHeaders(cgiHeader.subarray(0, separator));
          } catch {
            this.terminate(active);
            return;
          }
          response.writeHead(parsed.statusCode, parsed.headers);
          cgiHeadersSent = true;
          body = cgiHeader.subarray(separator + separatorBytes);
          cgiHeader = Buffer.alloc(0);
        }
        if (body.byteLength > 0 && !response.write(body)) {
          child.stdout.pause();
          response.once('drain', () => child.stdout.resume());
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_STDERR_BYTES) this.terminate(active);
      });
      child.once('error', () => finish(proxyError(
        'operation-failed',
        'git-http-backend-spawn-failed',
      )));
      child.once('close', exitCode => {
        void (async () => {
          request.removeListener('aborted', abort);
          request.removeListener('error', abort);
          await active.terminationTask?.catch(() => false);
          if (
            exitCode !== 0
            || active.terminated
            || !cgiHeadersSent
            || bodyBytes > this.maxReceivedPackBytes
          ) {
            finish(proxyError('operation-failed', 'git-http-backend-failed'));
            return;
          }
          response.end();
          finish();
        })();
      });
      try {
        const unregister = this.options.onChildStarted?.(
          memberId,
          () => this.terminate(active),
        );
        if (typeof unregister === 'function') {
          active.unregisterOwnedResource = unregister;
        }
      } catch {
        this.terminate(active);
      }
    });
  }

  private terminate(active: ActiveGitChild): void {
    if (active.terminated) return;
    active.terminated = true;
    active.child.stdin.destroy();
    try {
      active.terminationTask = terminateSpawnedProcessTree(
        active.child,
        'SIGTERM',
        spawn,
        active.spawnSpec,
      );
    } catch {
      // The bounded SIGKILL fallback remains authoritative.
    }
    if (!active.spawnSpec.killProcessTree) {
      active.terminationTimer = window.setTimeout(() => {
        try {
          active.terminationTask = terminateSpawnedProcessTree(
            active.child,
            'SIGKILL',
            spawn,
            active.spawnSpec,
          );
        } catch {
          // The process close/error event remains authoritative for cleanup.
        }
      }, this.#terminationGraceMs);
    }
  }
}
