import type { OpencodeServerService } from '../http/OpencodeServerService';
import { buildOpencodeRuntimeEnv } from '../runtime/OpencodeRuntimeEnvironment';
import { assertOpencodeSessionCompatibility, detectOpencodeNativeVersion } from '../runtime/OpencodeVersion';
import { DefaultOpencodeACPSessionKernel } from './OpencodeACPSessionKernel';
import { OpencodeHTTPSessionKernel } from './OpencodeHTTPSessionKernel';
import type { OpencodeKernelConnectOptions,OpencodeSessionKernel, OpencodeSessionKernelOptions } from './OpencodeSessionContract';

/** Chooses the native transport once per independent execution lease. */
export class DefaultOpencodeSessionKernel implements OpencodeSessionKernel {
  private kernel: OpencodeSessionKernel | null = null;
  private disposed = false;
  private connecting: Promise<void> | null = null;
  constructor(private readonly options: OpencodeSessionKernelOptions, private readonly serverService: OpencodeServerService) {}

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
    this.kernel = version === 2
      ? new OpencodeHTTPSessionKernel(this.options, cliPath, environment, this.serverService)
      : new DefaultOpencodeACPSessionKernel(this.options);
    await this.kernel.connect(options);
  }

  openSession(...args: Parameters<OpencodeSessionKernel['openSession']>) { return this.requireKernel().openSession(...args); }
  setConfigOption(...args: Parameters<OpencodeSessionKernel['setConfigOption']>) { return this.requireKernel().setConfigOption(...args); }
  prompt(...args: Parameters<OpencodeSessionKernel['prompt']>) { return this.requireKernel().prompt(...args); }
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
