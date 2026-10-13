import { invokeSessionTool, type SessionToolInvocation } from '@/core/session-tools/invokeSessionTool';
import { isSessionTool } from '@/core/tools/toolNames';

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
import { PI_SESSION_TOOLS_EXTENSION_SOURCE, PI_SESSION_TOOLS_TITLE } from '../runtime/PiSessionTools';
import { PiSubprocess } from '../runtime/PiSubprocess';
import { isPiTreeResponse, PI_TREE_EXTENSION_SOURCE, requestPiTree } from '../runtime/PiTreeBridge';

export interface PiExecutionKernelCallbacks {
  getSessionToolInvocation?(): SessionToolInvocation | undefined;
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
  private extensionDirectory: string | null = null;
  private readonly sessionToolCalls = new Map<string, {
    name: string;
    invocation: SessionToolInvocation;
    controller: AbortController;
    cleanup(): void;
    requestId?: string;
  }>();

  constructor(
    readonly launchSpec: PiLaunchSpec,
    private readonly callbacks: PiExecutionKernelCallbacks,
    extensionUiRenderer: PiExtensionUIRenderer | null,
  ) {
    let processSpec = launchSpec;
    if (launchSpec.enableTreeBridge || launchSpec.enableSessionTools) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-pi-extensions-'));
      try {
        const args = [...launchSpec.args];
        for (const [name, enabled, source] of [
          ['tree', launchSpec.enableTreeBridge, PI_TREE_EXTENSION_SOURCE],
          ['session-tools', launchSpec.enableSessionTools, PI_SESSION_TOOLS_EXTENSION_SOURCE],
        ] as const) {
          if (!enabled) continue;
          const extension = path.join(directory, name + '.ts');
          fs.writeFileSync(extension, source, 'utf8');
          args.push('--extension', extension);
        }
        processSpec = { ...launchSpec, args };
        this.extensionDirectory = directory;
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
      if (event.type === 'extension_ui_request' && event.method === 'input' && event.title === PI_SESSION_TOOLS_TITLE) {
        this.#handleSessionToolRequest(event);
        return;
      }
      if (event.type === 'tool_execution_start') this.#captureSessionTool(event);
      if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
        this.#clearSessionTool(event.toolCallId);
      }
      if (event.type === 'extension_ui_request') {
        extensionBridge.handleRequest(event);
        return;
      }
      this.callbacks.onEvent(event);
    });
    this.removeCloseListener = transport.onClose(error => {
      this.#clearSessionTools();
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
    if (type === 'abort') this.#clearSessionTools();
    if (type === 'claudian_tree') {
      return requestPiTree(this.#requireTransport(), payload, signal) as Promise<T>;
    }
    return this.#requireTransport().request(type, payload, timeoutMs, signal);
  }

  send(record: PiRPCRecord): void {
    if (record.type === 'abort') this.#clearSessionTools();
    this.#requireTransport().send(record);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.#shutdownInternal();
    return this.shutdownPromise;
  }

  async #shutdownInternal(): Promise<void> {
    this.#clearSessionTools();
    this.extensionBridge?.cleanup();
    this.removeEventListener?.();
    this.removeEventListener = null;
    this.removeCloseListener?.();
    this.removeCloseListener = null;
    this.transport?.dispose();
    this.transport = null;
    this.extensionBridge = null;
    await this.subprocess.shutdown();
    if (this.extensionDirectory) {
      await fsp.rm(this.extensionDirectory, { recursive: true, force: true });
      this.extensionDirectory = null;
    }
  }

  #captureSessionTool(event: PiRPCRecord): void {
    const { toolCallId, toolName } = event;
    if (typeof toolCallId !== 'string' || typeof toolName !== 'string' || !isSessionTool(toolName)) return;
    this.#clearSessionTool(toolCallId);
    // Capture at native execution start, never at the later UI callback.
    const invocation = this.callbacks.getSessionToolInvocation?.();
    if (!invocation || invocation.signal.aborted) return;
    const controller = new AbortController();
    const abort = () => this.#clearSessionTool(toolCallId);
    invocation.signal.addEventListener('abort', abort, { once: true });
    this.sessionToolCalls.set(toolCallId, {
      name: toolName,
      invocation: { ...invocation, signal: controller.signal },
      controller,
      cleanup: () => invocation.signal.removeEventListener('abort', abort),
    });
  }

  #handleSessionToolRequest(event: PiRPCRecord): void {
    if (typeof event.id !== 'string') return;
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(event.placeholder));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid session tool request');
      payload = parsed as Record<string, unknown>;
    } catch {
      this.transport?.send({ type: 'extension_ui_response', id: event.id, cancelled: true });
      return;
    }
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
    const call = this.sessionToolCalls.get(toolCallId);
    if (!call || call.name !== payload.name || call.requestId) {
      this.transport?.send({ type: 'extension_ui_response', id: event.id, cancelled: true });
      return;
    }
    call.requestId = event.id;
    void invokeSessionTool(call.name, payload.args, call.invocation).then(result => {
      if (this.sessionToolCalls.get(toolCallId) !== call || call.controller.signal.aborted) return;
      this.transport?.send({ type: 'extension_ui_response', id: call.requestId, value: JSON.stringify(result) });
      call.requestId = undefined;
      this.#clearSessionTool(toolCallId);
    });
  }

  #clearSessionTool(toolCallId: string): void {
    const call = this.sessionToolCalls.get(toolCallId);
    if (!call) return;
    this.sessionToolCalls.delete(toolCallId);
    if (call.requestId && this.transport && !this.transport.isClosed) {
      this.transport.send({ type: 'extension_ui_response', id: call.requestId, cancelled: true });
    }
    call.cleanup();
    call.controller.abort();
  }

  #clearSessionTools(): void {
    for (const id of this.sessionToolCalls.keys()) this.#clearSessionTool(id);
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
