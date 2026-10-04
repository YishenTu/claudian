import type { ProviderToolPolicy } from '@/core/execution';
import type {
  Thread,
  ThreadForkResult,
  ThreadResumeResult,
  ThreadRollbackResult,
  ThreadStartResult,
} from '@/providers/codex/runtime/codexAppServerTypes';
import type { CodexRPCTransport } from '@/providers/codex/runtime/CodexRPCTransport';
import type { CodexThreadScope } from '@/providers/codex/runtime/CodexThreadScope';
import {
  CODEX_WORKSPACE_DEPENDENCY_TOOL_NAME,
  CODEX_WORKSPACE_DEPENDENCY_TOOL_NAMESPACE,
  CODEX_WORKSPACE_DEPENDENCY_TOOL_VERSION,
} from '@/providers/codex/runtime/CodexWorkspaceDependencyTool';
import type { CodexPendingForkTarget, CodexProviderState } from '@/providers/codex/types';

import type { CodexActiveRun } from './CodexActiveRun';
import type { CodexSessionConnection } from './CodexSessionConnection';
import { type CodexPolicy, sandboxModeOf } from './codexTurnConfig';

const LEGACY_WORKSPACE_DEPENDENCY_INSTRUCTIONS =
  'This thread predates Claudian client-hosted workspace dependency tools. Do not emulate load_workspace_dependencies or install replacement dependencies.';

export type CodexForkSource = NonNullable<CodexProviderState['forkSource']>;

/** The native thread configuration a run requires. */
export interface CodexThreadRequest {
  readonly model: string;
  readonly policy: CodexPolicy;
  readonly serviceTier: string | null;
  readonly baseInstructions: string;
  readonly persistExtendedHistory: boolean | undefined;
  readonly toolPolicy: ProviderToolPolicy;
}

/** The session's durable native thread identity when a run starts binding. */
export interface CodexThreadIdentity {
  readonly threadId: string | null;
  readonly sessionFilePath: string | null;
  readonly workspaceDependencyToolVersion: number | null;
}

export interface CodexEnsuredThread {
  threadId: string;
  sessionFilePath: string | null;
  forkCheckpoint?: string;
}

export interface CodexThreadBinderHost {
  /** An existing thread was resumed into the current process. */
  threadResumed(thread: Thread): void;
  /** thread/start created the session's native thread. */
  threadStarted(run: CodexActiveRun, identity: CodexThreadIdentity & { threadId: string }): void;
  /** A fork child exists; its identity is durable before the child is resumed. */
  forkTargetAdopted(run: CodexActiveRun, target: CodexPendingForkTarget): void;
  /** The pending fork was materialized at its checkpoint. */
  forkConsumed(run: CodexActiveRun): void;
}

/**
 * Starts, resumes, or forks the session's native thread through the attached
 * thread scope before a turn targets it, and tracks what that generation has loaded.
 */
export class CodexThreadBinder {
  #pendingFork: CodexForkSource | undefined;
  #pendingForkTarget: CodexPendingForkTarget | undefined;
  #forkIdentityPromise: Promise<CodexPendingForkTarget> | null = null;
  #forkSetupPromise: Promise<CodexEnsuredThread> | null = null;
  #loadedThreadId: string | null = null;
  /** Sandbox mode in effect on the loaded thread; turn/start overrides persist across turns. */
  #loadedThreadSandbox: string | null = null;
  #loadedThreadSandboxRevision = 0;
  #loadedThreadBaseInstructions: string | null = null;
  #supportsApprovalReviewer = false;

  constructor(
    private readonly host: CodexThreadBinderHost,
    private readonly connection: CodexSessionConnection,
    pendingFork: CodexForkSource | undefined,
    pendingForkTarget: CodexPendingForkTarget | undefined,
  ) {
    this.#pendingFork = pendingFork;
    this.#pendingForkTarget = pendingFork ? pendingForkTarget : undefined;
  }

  get pendingFork(): CodexForkSource | undefined {
    return this.#pendingFork;
  }

  get pendingForkTarget(): CodexPendingForkTarget | undefined {
    return this.#pendingForkTarget;
  }

  get supportsApprovalReviewer(): boolean {
    return this.#supportsApprovalReviewer;
  }

  get loadedThreadSandbox(): string | null {
    return this.#loadedThreadSandbox;
  }

  get hasForkSetup(): boolean {
    return this.#forkSetupPromise !== null;
  }

  /**
   * Marks the loaded sandbox unknown while a turn overrides it; the override may take
   * effect before, or without, its acknowledgement. Returns the override's revision.
   */
  beginSandboxOverride(): number {
    return this.#setLoadedThreadSandbox(null);
  }

  /** Records the overridden mode unless the thread was reloaded since the override began. */
  confirmSandboxOverride(revision: number, mode: string): void {
    if (revision === this.#loadedThreadSandboxRevision) {
      this.#setLoadedThreadSandbox(mode);
    }
  }

  /** The generation that loaded threads is no longer attached. */
  unload(): void {
    this.#loadedThreadId = null;
    this.#setLoadedThreadSandbox(null);
    this.#loadedThreadBaseInstructions = null;
    this.#supportsApprovalReviewer = false;
  }

  async ensureThread(
    run: CodexActiveRun,
    request: CodexThreadRequest,
    identity: CodexThreadIdentity,
    isCurrent: () => boolean,
  ): Promise<CodexEnsuredThread> {
    const scope = this.connection.scope!;
    if (identity.threadId) scope.claim(identity.threadId);
    if (
      this.#pendingFork
      && (this.#pendingForkTarget !== undefined || !identity.threadId)
    ) {
      return this.#ensureForkThread(run, request, isCurrent);
    }

    if (
      identity.threadId
      && (
        this.#loadedThreadId !== identity.threadId
        || this.#loadedThreadBaseInstructions !== request.baseInstructions
      )
    ) {
      if (request.persistExtendedHistory === false) {
        throw new Error('This non-persistent Codex CLI session cannot be restored after its configuration changes. Start a new side chat.');
      }
      const result = await scope.open<ThreadResumeResult>(
        'thread/resume',
        this.#resumeParams(identity.threadId, request, identity.workspaceDependencyToolVersion === null),
      );
      this.#recordApprovalReviewer(result, request.policy.approvalsReviewer);
      this.host.threadResumed(result.thread);
      this.#recordLoadedThread(result.thread.id, result, request.baseInstructions);
      return {
        threadId: result.thread.id,
        sessionFilePath: this.connection.toHostPath(result.thread.path),
      };
    }

    if (identity.threadId) {
      return {
        threadId: identity.threadId,
        sessionFilePath: identity.sessionFilePath,
      };
    }

    const dynamicTools = shouldExposeDynamicTools(request.toolPolicy)
      ? this.connection.dynamicToolRegistry.getThreadStartSpecs().filter(spec =>
        isThreadStartToolAllowed(request.toolPolicy, spec.namespace, spec.name)
      )
      : [];
    const result = await scope.open<ThreadStartResult>(
      'thread/start',
      {
        ...this.#threadConfig(request, request.baseInstructions),
        cwd: this.connection.targetWorkingDirectory(),
        ...(request.persistExtendedHistory === false
          ? { ephemeral: true }
          : {}),
        ...persistExtendedHistoryParam(request),
        ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      },
    );
    this.#recordApprovalReviewer(result, request.policy.approvalsReviewer);
    this.#recordLoadedThread(result.thread.id, result, request.baseInstructions);
    const sessionFilePath = this.connection.toHostPath(result.thread.path);
    this.host.threadStarted(run, {
      threadId: result.thread.id,
      sessionFilePath,
      workspaceDependencyToolVersion: dynamicTools.some(spec =>
        spec.namespace === CODEX_WORKSPACE_DEPENDENCY_TOOL_NAMESPACE
        && spec.name === CODEX_WORKSPACE_DEPENDENCY_TOOL_NAME
      )
        ? CODEX_WORKSPACE_DEPENDENCY_TOOL_VERSION
        : null,
    });
    return {
      threadId: result.thread.id,
      sessionFilePath,
    };
  }

  /** Settles an in-flight fork request so its child identity is retained. */
  async settleForkIdentity(): Promise<void> {
    const identity = this.#forkIdentityPromise;
    if (!identity) return;
    try {
      await identity;
    } catch {
      // A rejected fork request exposes no child identity to retain.
    }
  }

  async settleForkSetup(): Promise<void> {
    const setup = this.#forkSetupPromise;
    if (!setup) return;
    try {
      await setup;
    } catch {
      // The active run owns error or cancellation projection.
    }
  }

  #ensureForkThread(
    run: CodexActiveRun,
    request: CodexThreadRequest,
    isCurrent: () => boolean,
  ): Promise<CodexEnsuredThread> {
    if (this.#forkSetupPromise) return this.#forkSetupPromise;
    const transport = this.connection.transport;
    const scope = this.connection.scope;
    if (!transport || !scope || !this.#pendingFork) {
      return Promise.reject(new Error('Codex CLI fork setup is not available.'));
    }

    const setup = this.#materializeForkThread(run, request, isCurrent, transport, scope);
    this.#forkSetupPromise = setup;
    const clear = () => {
      if (this.#forkSetupPromise === setup) this.#forkSetupPromise = null;
    };
    void setup.then(clear, clear);
    return setup;
  }

  async #materializeForkThread(
    run: CodexActiveRun,
    request: CodexThreadRequest,
    isCurrent: () => boolean,
    transport: CodexRPCTransport,
    scope: CodexThreadScope,
  ): Promise<CodexEnsuredThread> {
    const fork = this.#pendingFork;
    if (!fork) throw new Error('Codex CLI fork source is not available.');

    let target = this.#pendingForkTarget;
    if (!target) {
      target = await this.#resolveForkIdentity(run, fork, scope, request.persistExtendedHistory === false ? {
        ephemeral: true,
        excludeTurns: true,
        lastTurnId: fork.resumeAt,
        ...this.#threadConfig(request, withLegacyToolInstructions(request.baseInstructions)),
        persistExtendedHistory: false,
      } : {});
    }

    if (!isCurrent()) {
      throw new Error('Codex CLI fork setup was interrupted after child adoption.');
    }

    if (request.persistExtendedHistory === false) {
      // thread/fork already loaded the ephemeral child at the captured checkpoint.
      this.#loadedThreadId = target.threadId;
      this.#loadedThreadBaseInstructions = request.baseInstructions;
      this.#consumePendingFork(run);
      return { threadId: target.threadId, sessionFilePath: null };
    }

    const resumeResult = await scope.open<ThreadResumeResult>(
      'thread/resume',
      this.#resumeParams(target.threadId, request, true),
    );
    if (!isCurrent()) {
      throw new Error('Codex CLI fork setup was interrupted while resuming the child.');
    }
    if (resumeResult.thread.id !== target.threadId) {
      throw new Error('Codex CLI resumed a different thread than the owned fork target.');
    }

    this.#recordApprovalReviewer(resumeResult, request.policy.approvalsReviewer);
    this.#recordLoadedThread(target.threadId, resumeResult, request.baseInstructions);
    const checkpointIndex = resumeResult.thread.turns.findIndex(
      turn => turn.id === fork.resumeAt,
    );
    if (checkpointIndex < 0) {
      throw new Error(`Fork checkpoint not found: ${fork.resumeAt}`);
    }
    const rollbackCount = resumeResult.thread.turns.length - checkpointIndex - 1;
    if (rollbackCount > 0) {
      const rollbackResult = await transport.request<ThreadRollbackResult>(
        'thread/rollback',
        {
          threadId: target.threadId,
          numTurns: rollbackCount,
        },
      );
      if (!isCurrent()) {
        throw new Error('Codex CLI fork setup was interrupted while rolling back the child.');
      }
      if (rollbackResult.thread.id !== target.threadId) {
        throw new Error('Codex CLI rolled back a different thread than the owned fork target.');
      }
    }

    this.#consumePendingFork(run);
    return {
      threadId: target.threadId,
      sessionFilePath: target.sessionFilePath ?? null,
      forkCheckpoint: fork.resumeAt,
    };
  }

  #resolveForkIdentity(
    run: CodexActiveRun,
    fork: CodexForkSource,
    scope: CodexThreadScope,
    overrides: Record<string, unknown>,
  ): Promise<CodexPendingForkTarget> {
    if (this.#forkIdentityPromise) return this.#forkIdentityPromise;

    const pathMapper = this.connection.pathMapper;
    const identity = scope.open<ThreadForkResult>(
      'thread/fork',
      { threadId: fork.sessionId, ...overrides },
    ).then((forkResult) => {
      this.#recordApprovalReviewer(forkResult, overrides.approvalsReviewer);
      this.#setLoadedThreadSandbox(sandboxModeOf(forkResult.sandbox));
      const threadId = normalizeString(forkResult.thread.id);
      if (!threadId) {
        throw new Error('Codex CLI fork did not return a child thread ID.');
      }
      const sessionFilePath = forkResult.thread.path
        ? pathMapper?.toHostPath(forkResult.thread.path) ?? forkResult.thread.path
        : null;
      const target: CodexPendingForkTarget = {
        threadId,
        ...(sessionFilePath
          ? { sessionFilePath }
          : {}),
      };
      this.#pendingForkTarget = target;
      this.host.forkTargetAdopted(run, target);
      return target;
    });
    this.#forkIdentityPromise = identity;
    const clear = () => {
      if (this.#forkIdentityPromise === identity) this.#forkIdentityPromise = null;
    };
    void identity.then(clear, clear);
    return identity;
  }

  #consumePendingFork(run: CodexActiveRun): void {
    this.#pendingFork = undefined;
    this.#pendingForkTarget = undefined;
    this.host.forkConsumed(run);
  }

  /** Thread configuration shared by thread/start, thread/resume, and ephemeral thread/fork. */
  #threadConfig(request: CodexThreadRequest, baseInstructions: string): Record<string, unknown> {
    return {
      model: request.model,
      approvalPolicy: request.policy.approvalPolicy,
      approvalsReviewer: request.policy.approvalsReviewer,
      sandbox: request.policy.sandbox,
      serviceTier: request.serviceTier,
      baseInstructions,
      experimentalRawEvents: true,
    };
  }

  /** Threads that predate client-hosted dependency tools are told not to emulate them. */
  #resumeParams(
    threadId: string,
    request: CodexThreadRequest,
    predatesWorkspaceDependencyTools: boolean,
  ): Record<string, unknown> {
    return {
      threadId,
      ...this.#threadConfig(
        request,
        predatesWorkspaceDependencyTools
          ? withLegacyToolInstructions(request.baseInstructions)
          : request.baseInstructions,
      ),
      ...persistExtendedHistoryParam(request),
    };
  }

  #recordLoadedThread(
    threadId: string,
    result: ThreadStartResult,
    baseInstructions: string,
  ): void {
    this.#loadedThreadId = threadId;
    this.#setLoadedThreadSandbox(sandboxModeOf(result.sandbox));
    this.#loadedThreadBaseInstructions = baseInstructions;
  }

  #recordApprovalReviewer(result: ThreadStartResult, requested: unknown): void {
    // Older servers may ignore unknown request fields. Never claim automatic review in that case.
    this.#supportsApprovalReviewer = typeof result.approvalsReviewer === 'string'
      && (requested !== 'auto_review' || result.approvalsReviewer === 'auto_review');
  }

  #setLoadedThreadSandbox(mode: string | null): number {
    this.#loadedThreadSandbox = mode;
    return ++this.#loadedThreadSandboxRevision;
  }
}

function withLegacyToolInstructions(baseInstructions: string): string {
  return `${baseInstructions}\n\n${LEGACY_WORKSPACE_DEPENDENCY_INSTRUCTIONS}`;
}

function persistExtendedHistoryParam(request: CodexThreadRequest): { persistExtendedHistory?: boolean } {
  return request.persistExtendedHistory !== undefined
    ? { persistExtendedHistory: request.persistExtendedHistory }
    : {};
}

function shouldExposeDynamicTools(policy: ProviderToolPolicy): boolean {
  return (
    policy.kind === 'provider-default'
    || policy.kind === 'unrestricted'
    || policy.kind === 'allow-list'
  );
}

function isThreadStartToolAllowed(
  policy: ProviderToolPolicy,
  namespace: string | null | undefined,
  name: string,
): boolean {
  if (policy.kind === 'provider-default' || policy.kind === 'unrestricted') {
    return true;
  }
  if (policy.kind !== 'allow-list') return false;
  const qualified = namespace ? `${namespace}.${name}` : name;
  return policy.names.includes(name) || policy.names.includes(qualified);
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
