import type { OpencodeServerService } from '../http/OpencodeServerService';
import { buildOpencodeRuntimeEnv } from '../runtime/OpencodeRuntimeEnvironment';
import { assertOpencodeSessionCompatibility, detectOpencodeNativeVersion } from '../runtime/OpencodeVersion';
import { DefaultOpencodeACPSessionKernel } from './OpencodeACPSessionKernel';
import { OpencodeHTTPSessionKernel } from './OpencodeHTTPSessionKernel';
import type { OpencodeKernelConnectOptions,OpencodeSessionKernel, OpencodeSessionKernelOptions } from './OpencodeSessionContract';
import type { OpencodeSessionPersistence } from './OpencodeSessionPersistence';

/** Chooses the native transport once per independent execution lease. */
export class DefaultOpencodeSessionKernel implements OpencodeSessionKernel {
  private kernel: OpencodeSessionKernel | null = null;
  private disposed = false;
  private connecting: Promise<void> | null = null;
  constructor(private readonly options: OpencodeSessionKernelOptions, private readonly serverService: OpencodeServerService, private readonly persistence: OpencodeSessionPersistence) {}

  connect(options: OpencodeKernelConnectOptions): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('OpenCode session is disposed'));
    return this.connecting ??= this.connectInternal(options);
  }

  private async connectInternal(options: OpencodeKernelConnectOptions): Promise<void> {
    const cliPath = await this.options.plugin.getResolvedProviderCliPath('opencode') ?? 'opencode';
    const environment = buildOpencodeRuntimeEnv(this.options.plugin.settings, cliPath, this.options.databasePath);
    const version = await detectOpencodeNativeVersion(cliPath, environment);
    if (this.disposed) throw new Error('OpenCode session is disposed');
    assertOpencodeSessionCompatibility(this.options.nativeVersion, version);
    const nativeOptions = { ...this.options, databasePath: this.persistence.databasePath(version, this.options.databasePath) };
    const nativeEnvironment = { ...environment, ...(nativeOptions.databasePath ? { OPENCODE_DB: nativeOptions.databasePath } : {}) };
    this.kernel = version === 2
      ? new OpencodeHTTPSessionKernel(nativeOptions, cliPath, nativeEnvironment, this.serverService, this.persistence)
      : new DefaultOpencodeACPSessionKernel(nativeOptions, { cliPath, environment: nativeEnvironment, version });
    await this.kernel.connect(options);
  }

  get usesSharedRuntime(): boolean | undefined { return this.kernel ? this.kernel instanceof OpencodeHTTPSessionKernel : undefined; }
  get hasNativeWork(): boolean { return this.kernel?.hasNativeWork ?? false; }
  whenIdle(): Promise<void> { return this.kernel?.whenIdle?.() ?? Promise.resolve(); }

  openSession(...args: Parameters<OpencodeSessionKernel['openSession']>) { return this.requireKernel().openSession(...args); }
  setConfigOption(...args: Parameters<OpencodeSessionKernel['setConfigOption']>) { return this.requireKernel().setConfigOption(...args); }
  setAutoApprove(enabled: boolean): void { this.requireKernel().setAutoApprove(enabled); }
  prompt(...args: Parameters<OpencodeSessionKernel['prompt']>) { return this.requireKernel().prompt(...args); }
  steer(...args: Parameters<NonNullable<OpencodeSessionKernel['steer']>>): Promise<boolean> {
    const kernel = this.disposed ? null : this.kernel;
    return kernel?.steer ? kernel.steer(...args) : Promise.resolve(false);
  }
  cancel(sessionId: string): void { this.kernel?.cancel(sessionId); }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.kernel?.dispose();
    await this.connecting?.catch(() => undefined);
  }
  private requireKernel(): OpencodeSessionKernel {
    if (!this.kernel || this.disposed) throw new Error('OpenCode session is not connected');
    return this.kernel;
  }
}
