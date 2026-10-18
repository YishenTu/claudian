import type { OpencodeServerService } from '../http/OpencodeServerService';
import { buildOpencodeRuntimeEnv } from '../runtime/OpencodeRuntimeEnvironment';
import { detectOpencodeNativeVersion } from '../runtime/OpencodeVersion';
import { OpencodeHTTPSessionKernel } from './OpencodeHTTPSessionKernel';
import type { OpencodeKernelConnectOptions,OpencodeSessionKernel, OpencodeSessionKernelOptions } from './OpencodeSessionContract';
import type { OpencodeSessionPersistence } from './OpencodeSessionPersistence';

/** Verifies the native runtime once per independent execution lease before connecting. */
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
    await detectOpencodeNativeVersion(cliPath, environment);
    if (this.disposed) throw new Error('OpenCode session is disposed');
    const nativeEnvironment = { ...environment, ...(this.options.databasePath ? { OPENCODE_DB: this.options.databasePath } : {}) };
    this.kernel = new OpencodeHTTPSessionKernel(this.options, cliPath, nativeEnvironment, this.serverService, this.persistence);
    await this.kernel.connect(options);
  }

  get hasNativeWork(): boolean { return this.kernel?.hasNativeWork ?? false; }
  whenIdle(): Promise<void> { return this.kernel?.whenIdle() ?? Promise.resolve(); }

  openSession(...args: Parameters<OpencodeSessionKernel['openSession']>) { return this.requireKernel().openSession(...args); }
  setConfigOption(...args: Parameters<OpencodeSessionKernel['setConfigOption']>) { return this.requireKernel().setConfigOption(...args); }
  setAutoApprove(enabled: boolean): void { this.requireKernel().setAutoApprove(enabled); }
  prompt(...args: Parameters<OpencodeSessionKernel['prompt']>) { return this.requireKernel().prompt(...args); }
  steer(...args: Parameters<OpencodeSessionKernel['steer']>): Promise<boolean> {
    const kernel = this.disposed ? null : this.kernel;
    return kernel ? kernel.steer(...args) : Promise.resolve(false);
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
