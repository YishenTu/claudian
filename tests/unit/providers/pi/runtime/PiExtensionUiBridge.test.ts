import { PiExtensionUiBridge, type PiExtensionUiRenderer } from '@/providers/pi/runtime/PiExtensionUiBridge';
import type { PiRpcTransport } from '@/providers/pi/runtime/PiRpcTransport';

function createBridge(renderer: Partial<PiExtensionUiRenderer>) {
  const transport = {
    send: jest.fn(),
  } as unknown as PiRpcTransport;
  const bridge = new PiExtensionUiBridge(transport, renderer as PiExtensionUiRenderer);
  return { bridge, transport };
}

describe('PiExtensionUiBridge', () => {
  it('sends dialog responses through the transport', async () => {
    const renderer = {
      select: jest.fn().mockResolvedValue({ value: 'choice-a' }),
    };
    const { bridge, transport } = createBridge(renderer);

    expect(bridge.handleRequest({ id: 'ui-1', method: 'select', type: 'extension_ui_request' })).toBe(true);
    await Promise.resolve();

    expect(renderer.select).toHaveBeenCalled();
    expect(transport.send).toHaveBeenCalledWith({
      id: 'ui-1',
      type: 'extension_ui_response',
      value: 'choice-a',
    });
  });

  it('cancels dialog requests when no renderer is available', () => {
    const transport = {
      send: jest.fn(),
    } as unknown as PiRpcTransport;
    const bridge = new PiExtensionUiBridge(transport, null);

    bridge.handleRequest({ id: 'ui-1', method: 'confirm', type: 'extension_ui_request' });

    expect(transport.send).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
  });

  it('handles notify without sending a response', () => {
    const renderer = {
      notify: jest.fn(),
    };
    const { bridge, transport } = createBridge(renderer);

    bridge.handleRequest({ message: 'hello', method: 'notify', type: 'extension_ui_request' });

    expect(renderer.notify).toHaveBeenCalledWith({
      message: 'hello',
      method: 'notify',
      type: 'extension_ui_request',
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('cancels pending dialogs on cleanup', () => {
    const renderer = {
      input: jest.fn((_request: unknown, signal: AbortSignal) => new Promise<{ cancelled?: boolean }>((resolve) => {
        signal.addEventListener('abort', () => resolve({ cancelled: true }));
      })),
    };
    const { bridge, transport } = createBridge(renderer);

    bridge.handleRequest({ id: 'ui-1', method: 'input', type: 'extension_ui_request' });
    bridge.cleanup();

    expect(transport.send).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
  });

  it('does not send duplicate cancellation responses when cleanup aborts a rejecting renderer', async () => {
    const renderer = {
      input: jest.fn((_request: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      })),
    };
    const { bridge, transport } = createBridge(renderer);

    bridge.handleRequest({ id: 'ui-1', method: 'input', type: 'extension_ui_request' });
    bridge.cleanup();
    await Promise.resolve();

    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
  });
});
