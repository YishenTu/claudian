import { Readable, Writable } from 'stream';

import type { CodexAppServerProcess } from '@/providers/codex/runtime/CodexAppServerProcess';
import { CodexRpcTransport } from '@/providers/codex/runtime/CodexRpcTransport';

function createMockServerProcess(): CodexAppServerProcess & {
  _stdout: Readable;
  _stdin: Writable;
  _pushLine: (json: unknown) => void;
  _written: string[];
} {
  const stdout = new Readable({ read() {} });
  const written: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  });

  const proc = {
    stdin,
    stdout,
    stderr: new Readable({ read() {} }),
    isAlive: jest.fn().mockReturnValue(true),
    onExit: jest.fn(),
    getStderrSnapshot: jest.fn().mockReturnValue(''),
    _stdout: stdout,
    _stdin: stdin,
    _written: written,
    _pushLine(json: unknown) {
      stdout.push(JSON.stringify(json) + '\n');
    },
  } as unknown as CodexAppServerProcess & {
    _stdout: Readable;
    _stdin: Writable;
    _pushLine: (json: unknown) => void;
    _written: string[];
  };

  return proc;
}

describe('CodexRpcTransport', () => {
  let proc: ReturnType<typeof createMockServerProcess>;
  let transport: CodexRpcTransport;

  beforeEach(() => {
    proc = createMockServerProcess();
    transport = new CodexRpcTransport(proc);
    transport.start();
  });

  afterEach(() => {
    transport.dispose();
  });

  describe('request/response correlation', () => {
    it('resolves a request when the matching response arrives', async () => {
      const promise = transport.request('initialize', { clientInfo: { name: 'test', version: '0.1' } });

      // Inspect what was written
      expect(proc._written.length).toBe(1);
      const sent = JSON.parse(proc._written[0]);
      expect(sent.jsonrpc).toBe('2.0');
      expect(sent.method).toBe('initialize');
      expect(typeof sent.id).toBe('number');

      // Send response
      proc._pushLine({ jsonrpc: '2.0', id: sent.id, result: { codexHome: '/home' } });

      const result = await promise;
      expect(result).toEqual({ codexHome: '/home' });
    });

    it('rejects a request when the response has an error', async () => {
      const promise = transport.request('thread/start', {});

      const sent = JSON.parse(proc._written[0]);
      proc._pushLine({ jsonrpc: '2.0', id: sent.id, error: { code: -32600, message: 'Invalid request' } });

      await expect(promise).rejects.toThrow('Invalid request');
    });

    it('correlates multiple concurrent requests correctly', async () => {
      const p1 = transport.request('method/a', {});
      const p2 = transport.request('method/b', {});

      const sent1 = JSON.parse(proc._written[0]);
      const sent2 = JSON.parse(proc._written[1]);

      // Reply in reverse order
      proc._pushLine({ jsonrpc: '2.0', id: sent2.id, result: { answer: 'b' } });
      proc._pushLine({ jsonrpc: '2.0', id: sent1.id, result: { answer: 'a' } });

      expect(await p1).toEqual({ answer: 'a' });
      expect(await p2).toEqual({ answer: 'b' });
    });
  });

  describe('notifications', () => {
    it('sends a notification without an id', () => {
      transport.notify('initialized');

      const sent = JSON.parse(proc._written[0]);
      expect(sent.jsonrpc).toBe('2.0');
      expect(sent.method).toBe('initialized');
      expect(sent.id).toBeUndefined();
    });

    it('routes server notifications to registered handlers', async () => {
      const handler = jest.fn();
      transport.onNotification('item/agentMessage/delta', handler);

      proc._pushLine({
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { delta: 'Hello' },
      });

      await new Promise(r => setTimeout(r, 10));
      expect(handler).toHaveBeenCalledWith({ delta: 'Hello' });
    });

    it('ignores notifications without a registered handler', async () => {
      proc._pushLine({
        jsonrpc: '2.0',
        method: 'mcpServer/startupStatus/updated',
        params: { name: 'test' },
      });
      await new Promise(r => setTimeout(r, 10));
      // No crash — transport stays functional
      expect(transport).toBeDefined();
    });

    it('contains synchronous notification handler exceptions', async () => {
      const throwingHandler = jest.fn(() => { throw new Error('handler failed'); });
      const workingHandler = jest.fn();
      transport.onNotification('throwing', throwingHandler);
      transport.onNotification('working', workingHandler);

      proc._pushLine({ jsonrpc: '2.0', method: 'throwing', params: {} });
      proc._pushLine({ jsonrpc: '2.0', method: 'working', params: { ok: true } });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(throwingHandler).toHaveBeenCalledTimes(1);
      expect(workingHandler).toHaveBeenCalledWith({ ok: true });
    });
  });

  describe('server-initiated requests', () => {
    it('routes server requests to handlers and sends back the response', async () => {
      const handler = jest.fn().mockResolvedValue({ decision: 'accept' });
      transport.onServerRequest('item/commandExecution/requestApproval', handler);

      proc._pushLine({
        jsonrpc: '2.0',
        id: 100,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'echo test' },
      });

      // Allow microtasks to settle
      await new Promise(r => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledWith(100, { command: 'echo test' });

      // Check that a response was sent back
      const responseLine = proc._written.find(line => {
        const parsed = JSON.parse(line);
        return parsed.id === 100;
      });
      expect(responseLine).toBeDefined();
      const response = JSON.parse(responseLine!);
      expect(response.result).toEqual({ decision: 'accept' });
    });

    it('sends an error response for unhandled server requests', async () => {
      proc._pushLine({
        jsonrpc: '2.0',
        id: 200,
        method: 'unknown/request',
        params: {},
      });

      await new Promise(r => setTimeout(r, 10));

      const responseLine = proc._written.find(line => {
        const parsed = JSON.parse(line);
        return parsed.id === 200;
      });
      expect(responseLine).toBeDefined();
      const response = JSON.parse(responseLine!);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32601);
    });

    it('turns a synchronous server request handler exception into an error response', async () => {
      transport.onServerRequest('throwing/request', (() => {
        throw new Error('synchronous failure');
      }) as any);

      proc._pushLine({ jsonrpc: '2.0', id: 201, method: 'throwing/request', params: {} });
      await new Promise(resolve => setTimeout(resolve, 0));

      const response = proc._written.map(line => JSON.parse(line)).find(message => message.id === 201);
      expect(response.error).toMatchObject({ code: -32603, message: 'synchronous failure' });
    });
  });

  describe('malformed input', () => {
    it('does not crash on malformed JSON lines', () => {
      proc._stdout.push('not valid json\n');
      proc._stdout.push('{"jsonrpc":"2.0"}\n'); // valid but incomplete

      // Should not throw
      expect(transport).toBeDefined();
    });

    it.each([null, true, 42, 'text'])('ignores parsed JSON primitive %p', async (primitive) => {
      proc._pushLine(primitive);
      const request = transport.request('still/works', {});
      const sent = JSON.parse(proc._written[0]);
      proc._pushLine({ jsonrpc: '2.0', id: sent.id, result: 'ok' });
      await expect(request).resolves.toBe('ok');
    });
  });

  it('rejects requests immediately after disposal even with no timeout', async () => {
    transport.dispose();

    await expect(transport.request('after/dispose', {}, 0)).rejects.toThrow('Transport disposed');
    expect(proc._written).toEqual([]);
  });

  describe('cleanup on process exit', () => {
    it('rejects all pending requests when the process exits', async () => {
      const exitCb = (proc.onExit as jest.Mock).mock.calls[0][0];

      const promise = transport.request('thread/start', {});

      // Simulate process exit
      exitCb(1, 'SIGTERM');

      await expect(promise).rejects.toThrow();
    });

    it('includes stderr when rejecting pending requests after process exit', async () => {
      (proc.getStderrSnapshot as jest.Mock).mockReturnValue(
        'failed to load configuration: ~/.codex/config.toml: unknown variant priority',
      );
      const exitCb = (proc.onExit as jest.Mock).mock.calls[0][0];

      const promise = transport.request('initialize', {});

      exitCb(1, null);

      await expect(promise).rejects.toThrow('unknown variant priority');
    });

    it('notifies active turn observers when the app-server exits', () => {
      const onClose = jest.fn();
      transport.onClose(onClose);

      const exitCb = (proc.onExit as jest.Mock).mock.calls[0][0];
      exitCb(1, null);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onClose.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it('does not notify close observers after disposal', () => {
      const onClose = jest.fn();
      transport.onClose(onClose);
      transport.dispose();

      const exitCb = (proc.onExit as jest.Mock).mock.calls[0][0];
      exitCb(0, null);

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('request timeout', () => {
    it('rejects a request that times out', async () => {
      jest.useFakeTimers();

      const promise = transport.request('slow/method', {}, 5_000);

      jest.advanceTimersByTime(5_001);

      await expect(promise).rejects.toThrow(/timeout/i);

      jest.useRealTimers();
    });
  });
});
