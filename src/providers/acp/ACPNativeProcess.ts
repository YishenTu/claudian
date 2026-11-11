import {
  ACPClientConnection,
  type ACPClientConnectionDelegate,
} from './ACPClientConnection';
import { ACPJSONRPCTransport } from './ACPJSONRPCTransport';
import { ACPSubprocess, type ACPSubprocessLaunchSpec } from './ACPSubprocess';
import type { ACPClientCapabilities } from './types';

export interface ACPNativeProcessOptions {
  readonly launch: ACPSubprocessLaunchSpec;
  readonly version: string;
  readonly delegate: ACPClientConnectionDelegate;
  readonly clientCapabilities?: ACPClientCapabilities;
}

/**
 * One ACP agent process with its JSON-RPC transport and client, started on construction.
 * Shutdown runs once: it releases the caller's listeners, closes the client and transport, then
 * stops the process.
 */
export class ACPNativeProcess {
  readonly client: ACPClientConnection;
  readonly transport: ACPJSONRPCTransport;
  private readonly process: ACPSubprocess;
  private shutdownFlight: Promise<void> | null = null;

  constructor(options: ACPNativeProcessOptions) {
    this.process = new ACPSubprocess(options.launch);
    this.process.start();
    this.transport = new ACPJSONRPCTransport({
      input: this.process.stdout,
      onClose: listener => this.process.onClose(listener),
      output: this.process.stdin,
    });
    this.client = new ACPClientConnection({
      ...(options.clientCapabilities ? { clientCapabilities: options.clientCapabilities } : {}),
      clientInfo: { name: 'claudian', version: options.version },
      delegate: options.delegate,
      transport: this.transport,
    });
  }

  isAlive(): boolean {
    return this.process.isAlive();
  }

  onClose(listener: (error?: Error) => void): () => void {
    return this.process.onClose(listener);
  }

  flush(): Promise<void> {
    return this.transport.flush();
  }

  shutdown(releaseListeners: () => void = () => undefined): Promise<void> {
    this.shutdownFlight ??= (async () => {
      releaseListeners();
      this.client.dispose();
      this.transport.dispose();
      await this.process.shutdown();
    })();
    return this.shutdownFlight;
  }
}
