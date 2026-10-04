import type { CodexAppServerConnection } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { CodexDynamicToolRegistry } from '@/providers/codex/runtime/CodexDynamicToolRegistry';
import type { CodexLaunchSpec } from '@/providers/codex/runtime/codexLaunchTypes';
import type { CodexRPCTransport } from '@/providers/codex/runtime/CodexRPCTransport';
import type { CodexRuntimeContext } from '@/providers/codex/runtime/CodexRuntimeContext';
import type { CodexThreadObserver, CodexThreadScope } from '@/providers/codex/runtime/CodexThreadScope';
import { createCodexWorkspaceDependencyTool } from '@/providers/codex/runtime/CodexWorkspaceDependencyTool';

export interface CodexSessionConnectionHost {
  readonly vaultWorkingDirectory: string;
  /** Routes the attached thread scope's native traffic. */
  readonly observer: CodexThreadObserver;
  /** The attached app-server generation exited on its own. */
  onExit(): void;
  /** The attached generation stopped accepting new work and may be releasable. */
  onRetired(): void;
  /** The attachment is gone; state scoped to it (loaded threads, tools) is invalid. */
  onRelease(): void;
}

/**
 * One session's attachment to a generation of the provider-owned shared
 * app-server: its thread scope, client-hosted dynamic tools, and path mapping.
 * The runtime owns the process; releasing detaches the scope, never the server.
 */
export class CodexSessionConnection {
  #connection: CodexAppServerConnection | null = null;
  #scope: CodexThreadScope | null = null;
  #runtimeContext: CodexRuntimeContext | null = null;
  #dynamicToolRegistry = new CodexDynamicToolRegistry();
  #detachListeners: (() => void) | null = null;
  #release: Promise<void> | null = null;

  constructor(private readonly host: CodexSessionConnectionHost) {}

  get transport(): CodexRPCTransport | null {
    return this.#connection?.transport ?? null;
  }

  get scope(): CodexThreadScope | null {
    return this.#scope;
  }

  get dynamicToolRegistry(): CodexDynamicToolRegistry {
    return this.#dynamicToolRegistry;
  }

  get pathMapper(): CodexLaunchSpec['pathMapper'] | undefined {
    return this.#connection?.launchSpec.pathMapper;
  }

  get sessionsDirHost(): string | null | undefined {
    return this.#runtimeContext?.sessionsDirHost;
  }

  get hasBackgroundWork(): boolean {
    return this.#scope?.hasBackgroundWork ?? false;
  }

  isAttachedTo(connection: CodexAppServerConnection): boolean {
    return this.#connection === connection;
  }

  /** Attached to a live generation whose threads still own native work. */
  isDraining(): boolean {
    return Boolean(this.#connection?.isAlive() && this.#scope?.hasWork);
  }

  /** Attached to a retired generation that no longer owns native work. */
  isReleasable(): boolean {
    return Boolean(this.#connection?.isRetired() && !this.#scope?.hasWork);
  }

  /** Settles an in-flight detachment before another attachment may start. */
  async settleRelease(): Promise<void> {
    await this.#release;
  }

  /**
   * Attaches to an initialized generation. The caller keeps its acquisition
   * lease until this resolves; the thread scope retains its own.
   */
  async attach(connection: CodexAppServerConnection): Promise<CodexDynamicToolRegistry> {
    const runtimeContext = await connection.initialized;
    this.#connection = connection;
    this.#runtimeContext = runtimeContext;
    this.#dynamicToolRegistry = new CodexDynamicToolRegistry();
    this.#dynamicToolRegistry.register(createCodexWorkspaceDependencyTool(runtimeContext));
    this.#scope = connection.createThreadScope(this.host.observer);
    const offExit = connection.onExit(() => {
      if (this.#connection === connection) this.host.onExit();
    });
    const offRetire = connection.onRetired(() => this.host.onRetired());
    this.#detachListeners = () => { offExit(); offRetire(); };
    return this.#dynamicToolRegistry;
  }

  /** Detaches the thread scope; it keeps native cleanup ownership until closure. */
  release(): Promise<void> {
    if (this.#release) return this.#release;
    const scope = this.#scope;
    this.#scope = null;
    this.#connection = null;
    this.#runtimeContext = null;
    this.#detachListeners?.();
    this.#detachListeners = null;
    this.#dynamicToolRegistry = new CodexDynamicToolRegistry();
    this.host.onRelease();
    const pending = scope?.detach() ?? Promise.resolve();
    this.#release = pending;
    void pending.finally(() => {
      if (this.#release === pending) this.#release = null;
    }).catch(() => undefined);
    return pending;
  }

  /** The vault directory as the app-server sees it. */
  targetWorkingDirectory(): string {
    const launchSpec = this.#connection?.launchSpec;
    if (!launchSpec) return this.host.vaultWorkingDirectory;
    return launchSpec.pathMapper.toTargetPath(this.host.vaultWorkingDirectory) ?? launchSpec.targetCwd;
  }

  toTargetPath(hostPath: string | null): string | null {
    if (!hostPath) return null;
    return this.pathMapper?.toTargetPath(hostPath) ?? hostPath;
  }

  toHostPath(targetPath: string | null | undefined): string | null {
    if (!targetPath) return null;
    return this.pathMapper?.toHostPath(targetPath) ?? targetPath;
  }
}
