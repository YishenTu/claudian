import type { StreamChunk } from '../../../core/types';
import type { PiRPCRecord, PiRPCTransport } from './PiRPCTransport';

export interface PiExtensionUISelectRequest extends PiRPCRecord {
  id: string;
}

export interface PiExtensionUIConfirmRequest extends PiRPCRecord {
  id: string;
}

export interface PiExtensionUIInputRequest extends PiRPCRecord {
  id: string;
}

export interface PiExtensionUIEditorRequest extends PiRPCRecord {
  id: string;
}

export type PiExtensionUINotifyRequest = PiRPCRecord;
export type PiExtensionUISetEditorTextRequest = PiRPCRecord;
export type PiExtensionUISetStatusRequest = PiRPCRecord;
export type PiExtensionUISetTitleRequest = PiRPCRecord;
export type PiExtensionUISetWidgetRequest = PiRPCRecord;

export interface PiExtensionUIRenderer {
  confirm(request: PiExtensionUIConfirmRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; confirmed?: boolean }>;
  editor(request: PiExtensionUIEditorRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  input(request: PiExtensionUIInputRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  notify(request: PiExtensionUINotifyRequest): void;
  select(request: PiExtensionUISelectRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  setEditorText(request: PiExtensionUISetEditorTextRequest): void;
  setStatus(request: PiExtensionUISetStatusRequest): void;
  setTitle(request: PiExtensionUISetTitleRequest): void;
  setWidget(request: PiExtensionUISetWidgetRequest): void;
}

export class PiExtensionUIBridge {
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly transport: PiRPCTransport,
    private readonly renderer: PiExtensionUIRenderer | null,
    private readonly emit?: (chunk: StreamChunk) => void,
    private readonly admitDialog: (request: PiRPCRecord) => boolean = () => true,
  ) {}

  handleRequest(request: PiRPCRecord): boolean {
    if (request.type !== 'extension_ui_request') {
      return false;
    }

    const method = getString(request.method) ?? getString(request.action) ?? getString(request.uiType);
    switch (method) {
      case 'select':
        this.#handleDialog(request, (renderer, signal) =>
          renderer.select(requireDialogRequest(request), signal));
        return true;
      case 'confirm':
        this.#handleDialog(request, (renderer, signal) =>
          renderer.confirm(requireDialogRequest(request), signal));
        return true;
      case 'input':
        this.#handleDialog(request, (renderer, signal) =>
          renderer.input(requireDialogRequest(request), signal));
        return true;
      case 'editor':
        this.#handleDialog(request, (renderer, signal) =>
          renderer.editor(requireDialogRequest(request), signal));
        return true;
      case 'notify':
        this.renderer?.notify(request);
        this.emit?.({
          type: 'notice',
          content: getString(request.message) ?? getString(request.title) ?? 'Pi extension notification.',
          level: 'info',
        });
        return true;
      case 'setStatus':
      case 'set_status':
        this.renderer?.setStatus(request);
        return true;
      case 'setWidget':
      case 'set_widget':
        this.renderer?.setWidget(request);
        return true;
      case 'setTitle':
      case 'set_title':
        this.renderer?.setTitle(request);
        return true;
      case 'setEditorText':
      case 'set_editor_text':
        this.renderer?.setEditorText(request);
        return true;
      default:
        this.#sendCancellation(request);
        return true;
    }
  }

  cleanup(): void {
    for (const [id, controller] of this.pending) {
      controller.abort();
      this.#sendResponse(id, { cancelled: true });
    }
    this.pending.clear();
  }

  #handleDialog(
    request: PiRPCRecord,
    render: (
      renderer: PiExtensionUIRenderer,
      signal: AbortSignal,
    ) => Promise<Record<string, unknown>>,
  ): void {
    const id = getString(request.id);
    if (!id || !this.renderer || !this.admitDialog(request)) {
      this.#sendCancellation(request);
      return;
    }

    const controller = new AbortController();
    this.pending.set(id, controller);
    render(this.renderer, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          this.#sendResponse(id, response.cancelled ? { cancelled: true } : response);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          this.#sendResponse(id, { cancelled: true });
        }
      })
      .finally(() => {
        this.pending.delete(id);
      });
  }

  #sendCancellation(request: PiRPCRecord): void {
    const id = getString(request.id);
    if (id) {
      this.#sendResponse(id, { cancelled: true });
    }
  }

  #sendResponse(id: string, response: Record<string, unknown>): void {
    this.transport.send({
      id,
      type: 'extension_ui_response',
      ...response,
    });
  }
}

function requireDialogRequest<T extends PiRPCRecord & { id: string }>(request: PiRPCRecord): T {
  return request as T;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
