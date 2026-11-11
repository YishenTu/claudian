import type { ProviderSessionToolPort } from '@/core/execution';
import type { TargetLaunchSpec } from '@/core/process/execution-target/types';
import type { CodexAppServerConnection } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { CodexDynamicToolRegistry } from '@/providers/codex/runtime/CodexDynamicToolRegistry';
import type { CodexRPCTransport } from '@/providers/codex/runtime/CodexRPCTransport';
import type { CodexRuntimeContext } from '@/providers/codex/runtime/CodexRuntimeContext';
import { createCodexSessionTools } from '@/providers/codex/runtime/CodexSessionTools';
import type { CodexThreadObserver, CodexThreadScope } from '@/providers/codex/runtime/CodexThreadScope';
import { createCodexWorkspaceDependencyTool } from '@/providers/codex/runtime/CodexWorkspaceDependencyTool';

export interface CodexSessionConnectionHost {
  readonly workingDirectory: string;
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
interface Attachment {
  readonly connection: CodexAppServerConnection;
  readonly scope: CodexThreadScope;
  readonly runtimeContext: CodexRuntimeContext;
  readonly detachListeners: () => void;
}

export class CodexSessionConnection {
  #attachment: Attachment | null = null;
  #dynamicToolRegistry = new CodexDynamicToolRegistry();
  #release: Promise<void> | null = null;

  constructor(
    private readonly host: CodexSessionConnectionHost,
    private readonly sessionTools?: ProviderSessionToolPort,
  ) {}

  get transport(): CodexRPCTransport | null {
    return this.#attachment?.connection.transport ?? null;
  }

  get scope(): CodexThreadScope | null {
    return this.#attachment?.scope ?? null;
  }

  get dynamicToolRegistry(): CodexDynamicToolRegistry {
    return this.#dynamicToolRegistry;
  }

  get pathMapper(): TargetLaunchSpec['pathMapper'] | undefined {
    return this.#attachment?.connection.launchSpec.pathMapper;
  }

  get sessionsDirHost(): string | null | undefined {
    return this.#attachment?.runtimeContext.sessionsDirHost;
  }

  get hasBackgroundWork(): boolean {
    return this.#attachment?.scope.hasBackgroundWork ?? false;
  }

  isAttachedTo(connection: CodexAppServerConnection): boolean {
    return this.#attachment?.connection === connection;
  }

  /** Attached to a live generation whose threads still own native work. */
  isDraining(): boolean {
    const attachment = this.#attachment;
    return Boolean(attachment?.connection.isAlive() && attachment.scope.hasWork);
  }

  /** Attached to a retired generation that no longer owns native work. */
  isReleasable(): boolean {
    const attachment = this.#attachment;
    return Boolean(attachment?.connection.isRetired() && !attachment.scope.hasWork);
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
    this.#dynamicToolRegistry = new CodexDynamicToolRegistry();
    this.#dynamicToolRegistry.register(createCodexWorkspaceDependencyTool(runtimeContext));
    if (this.sessionTools) {
      for (const tool of createCodexSessionTools(this.sessionTools)) this.#dynamicToolRegistry.register(tool);
    }
    const scope = connection.createThreadScope(this.host.observer);
    const offExit = connection.onExit(() => {
      if (this.#attachment?.connection === connection) this.host.onExit();
    });
    const offRetire = connection.onRetired(() => this.host.onRetired());
    this.#attachment = { connection, detachListeners: () => { offExit(); offRetire(); }, runtimeContext, scope };
    return this.#dynamicToolRegistry;
  }

  /** Detaches the thread scope; it keeps native cleanup ownership until closure. */
  release(): Promise<void> {
    if (this.#release) return this.#release;
    const attachment = this.#attachment;
    this.#attachment = null;
    attachment?.detachListeners();
    const scope = attachment?.scope;
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
    const launchSpec = this.#attachment?.connection.launchSpec;
    if (!launchSpec) return this.host.workingDirectory;
    return launchSpec.pathMapper.toTargetPath(this.host.workingDirectory) ?? launchSpec.targetCwd;
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
