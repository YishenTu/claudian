import type { StreamChunk } from '../../../core/types';
import {
  PiExtensionUIBridge,
  type PiExtensionUIRenderer,
} from '../runtime/PiExtensionUIBridge';
import type { PiLaunchSpec } from '../runtime/PiLaunchSpecBuilder';
import {
  type PiRPCRecord,
  PiRPCTransport,
} from '../runtime/PiRPCTransport';
import { PiSubprocess } from '../runtime/PiSubprocess';
import { isPiTreeResponse, PI_TREE_EXTENSION_SOURCE, requestPiTree } from '../runtime/PiTreeBridge';

export interface PiExecutionKernelCallbacks {
  onClose(error?: Error): void;
  onEvent(event: PiRPCRecord): void;
  onExtensionChunk(chunk: StreamChunk): void;
  onExtensionRequest(request: PiRPCRecord): boolean;
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
  send(record: PiRPCRecord): void;
  shutdown(): Promise<void>;
  start(): void;
}

export type PiExecutionKernelFactory = (
  launchSpec: PiLaunchSpec,
  callbacks: PiExecutionKernelCallbacks,
  extensionUiRenderer: PiExtensionUIRenderer | null,
) => PiExecutionKernel;

export class PiRPCSessionKernel implements PiExecutionKernel {
  private readonly subprocess: PiSubprocess;
  private transport: PiRPCTransport | null = null;
  private extensionBridge: PiExtensionUIBridge | null = null;
  private removeCloseListener: (() => void) | null = null;
  private removeEventListener: (() => void) | null = null;
  private started = false;
  private shutdownPromise: Promise<void> | null = null;
  private treeExtensionDirectory: string | null = null;

  constructor(
    readonly launchSpec: PiLaunchSpec,
    private readonly callbacks: PiExecutionKernelCallbacks,
    extensionUiRenderer: PiExtensionUIRenderer | null,
  ) {
    let processSpec = launchSpec;
    if (launchSpec.enableTreeBridge) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-pi-tree-'));
      try {
        const extension = path.join(directory, 'extension.ts');
        fs.writeFileSync(extension, PI_TREE_EXTENSION_SOURCE, 'utf8');
        processSpec = { ...launchSpec, args: [...launchSpec.args, '--extension', extension] };
        this.treeExtensionDirectory = directory;
      } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    }
    this.subprocess = new PiSubprocess(processSpec);
    this.extensionUiRenderer = extensionUiRenderer;
  }

  private readonly extensionUiRenderer: PiExtensionUIRenderer | null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.subprocess.start();
    const transport = new PiRPCTransport({
      input: this.subprocess.stdout,
      onClose: listener => this.subprocess.onClose(listener),
      output: this.subprocess.stdin,
    });
    const extensionBridge = new PiExtensionUIBridge(
      transport,
      this.extensionUiRenderer,
      chunk => this.callbacks.onExtensionChunk(chunk),
      request => this.callbacks.onExtensionRequest(request),
    );
    this.transport = transport;
    this.extensionBridge = extensionBridge;
    transport.start();
    this.removeEventListener = transport.onEvent((event) => {
      if (isPiTreeResponse(event)) return;
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
    if (type === 'claudian_tree') {
      return requestPiTree(this.#requireTransport(), payload, signal) as Promise<T>;
    }
    return this.#requireTransport().request(type, payload, timeoutMs, signal);
  }

  send(record: PiRPCRecord): void {
    this.#requireTransport().send(record);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.#shutdownInternal();
    return this.shutdownPromise;
  }

  async #shutdownInternal(): Promise<void> {
    this.extensionBridge?.cleanup();
    this.removeEventListener?.();
    this.removeEventListener = null;
    this.removeCloseListener?.();
    this.removeCloseListener = null;
    this.transport?.dispose();
    this.transport = null;
    this.extensionBridge = null;
    await this.subprocess.shutdown();
    if (this.treeExtensionDirectory) {
      await fsp.rm(this.treeExtensionDirectory, { recursive: true, force: true });
      this.treeExtensionDirectory = null;
    }
  }

  #requireTransport(): PiRPCTransport {
    if (!this.transport) {
      throw new Error('Pi execution kernel is not started');
    }
    return this.transport;
  }
}

export const createPiExecutionKernel: PiExecutionKernelFactory = (
  launchSpec,
  callbacks,
  extensionUiRenderer,
) => new PiRPCSessionKernel(
  launchSpec,
  callbacks,
  extensionUiRenderer,
);
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
