import type { StreamChunk } from '../../../core/types';
import type { PiRpcRecord, PiRpcTransport } from './PiRpcTransport';

export interface PiExtensionUiSelectRequest extends PiRpcRecord {
  id: string;
}

export interface PiExtensionUiConfirmRequest extends PiRpcRecord {
  id: string;
}

export interface PiExtensionUiInputRequest extends PiRpcRecord {
  id: string;
}

export interface PiExtensionUiEditorRequest extends PiRpcRecord {
  id: string;
}

export type PiExtensionUiNotifyRequest = PiRpcRecord;
export type PiExtensionUiSetEditorTextRequest = PiRpcRecord;
export type PiExtensionUiSetStatusRequest = PiRpcRecord;
export type PiExtensionUiSetTitleRequest = PiRpcRecord;
export type PiExtensionUiSetWidgetRequest = PiRpcRecord;

export interface PiExtensionUiRenderer {
  confirm(request: PiExtensionUiConfirmRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; confirmed?: boolean }>;
  editor(request: PiExtensionUiEditorRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  input(request: PiExtensionUiInputRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  notify(request: PiExtensionUiNotifyRequest): void;
  select(request: PiExtensionUiSelectRequest, signal: AbortSignal): Promise<{ cancelled?: boolean; value?: string }>;
  setEditorText(request: PiExtensionUiSetEditorTextRequest): void;
  setStatus(request: PiExtensionUiSetStatusRequest): void;
  setTitle(request: PiExtensionUiSetTitleRequest): void;
  setWidget(request: PiExtensionUiSetWidgetRequest): void;
}

export class PiExtensionUiBridge {
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly transport: PiRpcTransport,
    private readonly renderer: PiExtensionUiRenderer | null,
    private readonly emit?: (chunk: StreamChunk) => void,
  ) {}

  handleRequest(request: PiRpcRecord): boolean {
    if (request.type !== 'extension_ui_request') {
      return false;
    }

    const method = getString(request.method) ?? getString(request.action) ?? getString(request.uiType);
    switch (method) {
      case 'select':
        this.handleDialog(request, (renderer, signal) =>
          renderer.select(requireDialogRequest(request), signal));
        return true;
      case 'confirm':
        this.handleDialog(request, (renderer, signal) =>
          renderer.confirm(requireDialogRequest(request), signal));
        return true;
      case 'input':
        this.handleDialog(request, (renderer, signal) =>
          renderer.input(requireDialogRequest(request), signal));
        return true;
      case 'editor':
        this.handleDialog(request, (renderer, signal) =>
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
        this.sendCancellation(request);
        return true;
    }
  }

  cleanup(): void {
    for (const [id, controller] of this.pending) {
      controller.abort();
      this.sendResponse(id, { cancelled: true });
    }
    this.pending.clear();
  }

  private handleDialog(
    request: PiRpcRecord,
    render: (
      renderer: PiExtensionUiRenderer,
      signal: AbortSignal,
    ) => Promise<Record<string, unknown>>,
  ): void {
    const id = getString(request.id);
    if (!id || !this.renderer) {
      this.sendCancellation(request);
      return;
    }

    const controller = new AbortController();
    this.pending.set(id, controller);
    render(this.renderer, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          this.sendResponse(id, response.cancelled ? { cancelled: true } : response);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          this.sendResponse(id, { cancelled: true });
        }
      })
      .finally(() => {
        this.pending.delete(id);
      });
  }

  private sendCancellation(request: PiRpcRecord): void {
    const id = getString(request.id);
    if (id) {
      this.sendResponse(id, { cancelled: true });
    }
  }

  private sendResponse(id: string, response: Record<string, unknown>): void {
    this.transport.send({
      id,
      type: 'extension_ui_response',
      ...response,
    });
  }
}

function requireDialogRequest<T extends PiRpcRecord & { id: string }>(request: PiRpcRecord): T {
  return request as T;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
