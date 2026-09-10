import type { StreamChunk } from '../../../core/types';
import type { PiFamilyProfile } from '../PiFamilyProfile';
import {
  PiExtensionUiBridge,
  type PiExtensionUiRenderer,
} from '../runtime/PiExtensionUiBridge';
import type { PiLaunchSpec } from '../runtime/PiLaunchSpec';
import {
  type PiRpcRecord,
  PiRpcTransport,
} from '../runtime/PiRpcTransport';
import { PiSubprocess } from '../runtime/PiSubprocess';

export interface PiExecutionKernelCallbacks {
  onClose(error?: Error): void;
  onEvent(event: PiRpcRecord): void;
  onExtensionChunk(chunk: StreamChunk): void;
  onExtensionRequest(request: PiRpcRecord): boolean;
}

export interface PiExecutionKernel {
  readonly launchSpec: PiLaunchSpec;
  getStderrSnapshot(): string;
  request<T>(
    type: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
  send(record: PiRpcRecord): void;
  shutdown(): Promise<void>;
  start(): void;
}

export type PiExecutionKernelFactory = (
  profile: PiFamilyProfile,
  launchSpec: PiLaunchSpec,
  callbacks: PiExecutionKernelCallbacks,
  extensionUiRenderer?: PiExtensionUiRenderer | null,
) => PiExecutionKernel;

export class PiRpcSessionKernel implements PiExecutionKernel {
  private readonly subprocess: PiSubprocess;
  private transport: PiRpcTransport | null = null;
  private extensionBridge: PiExtensionUiBridge | null = null;
  private removeCloseListener: (() => void) | null = null;
  private removeEventListener: (() => void) | null = null;
  private started = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly profile: PiFamilyProfile,
    readonly launchSpec: PiLaunchSpec,
    private readonly callbacks: PiExecutionKernelCallbacks,
    extensionUiRenderer?: PiExtensionUiRenderer | null,
  ) {
    this.subprocess = new PiSubprocess(launchSpec, profile);
    this.extensionUiRenderer = extensionUiRenderer ?? null;
  }

  private readonly extensionUiRenderer: PiExtensionUiRenderer | null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.subprocess.start();
    const transport = new PiRpcTransport({
      input: this.subprocess.stdout,
      onClose: listener => this.subprocess.onClose(listener),
      output: this.subprocess.stdin,
    });
    const extensionBridge = new PiExtensionUiBridge(
      transport,
      this.extensionUiRenderer,
      this.profile.displayName,
      chunk => this.callbacks.onExtensionChunk(chunk),
      request => this.callbacks.onExtensionRequest(request),
    );
    this.transport = transport;
    this.extensionBridge = extensionBridge;
    transport.start();
    this.removeEventListener = transport.onEvent((event) => {
      if (event.type === 'extension_ui_request') {
        extensionBridge.handleRequest(event);
        return;
      }
      this.callbacks.onEvent(event);
    });
    this.removeCloseListener = transport.onClose(error => {
      this.callbacks.onClose(error);
    });
  }

  getStderrSnapshot(): string {
    return this.subprocess.getStderrSnapshot();
  }

  request<T>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.requireTransport().request(type, payload, timeoutMs, signal);
  }

  send(record: PiRpcRecord): void {
    this.requireTransport().send(record);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    this.extensionBridge?.cleanup();
    this.removeEventListener?.();
    this.removeEventListener = null;
    this.removeCloseListener?.();
    this.removeCloseListener = null;
    this.transport?.dispose();
    this.transport = null;
    this.extensionBridge = null;
    await this.subprocess.shutdown();
  }

  private requireTransport(): PiRpcTransport {
    if (!this.transport) {
      throw new Error(
        `${this.profile.displayName} execution kernel is not started`,
      );
    }
    return this.transport;
  }
}

export const createPiExecutionKernel: PiExecutionKernelFactory = (
  profile,
  launchSpec,
  callbacks,
  extensionUiRenderer,
) => new PiRpcSessionKernel(
  profile,
  launchSpec,
  callbacks,
  extensionUiRenderer,
);
