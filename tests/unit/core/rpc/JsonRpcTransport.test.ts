import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import {
  JsonRpcErrorResponse,
  JsonRpcTransport,
  JsonRpcTransportClosedError,
} from '@/core/rpc/JsonRpcTransport';

interface TransportHarness {
  close: () => void;
  closeProcess: (error?: Error) => void;
  input: PassThrough;
  nextOutbound: () => Promise<Record<string, unknown>>;
  output: PassThrough;
  sendInbound: (message: unknown) => void;
  transport: JsonRpcTransport;
  unregisterClose: jest.Mock;
}

function createTransportHarness(
  defaultTimeoutMs = 30_000,
  streamCloseGraceMs = 0,
): TransportHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createInterface({ input: output });
  const queued: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  let processClose: ((error?: Error) => void) | undefined;
  const unregisterClose = jest.fn();

  reader.on('error', () => {});

  reader.on('line', (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    queued.push(message);
  });

  return {
    close: () => {
      reader.close();
      input.destroy();
      output.destroy();
    },
    closeProcess: error => processClose?.(error),
    input,
    nextOutbound: () => {
      const message = queued.shift();
      return message
        ? Promise.resolve(message)
        : new Promise(resolve => waiters.push(resolve));
    },
    output,
    sendInbound: message => input.write(`${JSON.stringify(message)}\n`),
    transport: new JsonRpcTransport({
      input,
      onClose: (listener) => {
        processClose = listener;
        return unregisterClose;
      },
      output,
    }, defaultTimeoutMs, { streamCloseGraceMs }),
    unregisterClose,
  };
}

describe('JsonRpcTransport', () => {
  let harness: TransportHarness;

  beforeEach(() => {
    harness = createTransportHarness();
  });

  afterEach(() => {
    harness.transport.dispose();
    harness.close();
    jest.useRealTimers();
  });

  it('correlates successful and typed error responses with numeric client IDs', async () => {
    const successful = harness.transport.request('first', { value: 1 });
    const first = await harness.nextOutbound();
    expect(first).toMatchObject({ id: 1, jsonrpc: '2.0', method: 'first' });
    harness.sendInbound({ id: first.id, jsonrpc: '2.0', result: { ok: true } });
    await expect(successful).resolves.toEqual({ ok: true });

    const failed = harness.transport.request('second');
    const second = await harness.nextOutbound();
    expect(second.id).toBe(2);
    harness.sendInbound({
      error: { code: -32602, data: { field: 'cwd' }, message: 'Invalid params' },
      id: second.id,
      jsonrpc: '2.0',
    });
    await expect(failed).rejects.toEqual(expect.objectContaining({
      code: -32602,
      data: { field: 'cwd' },
      message: 'Invalid params',
      method: 'second',
    }));
    await expect(failed).rejects.toBeInstanceOf(JsonRpcErrorResponse);
  });

  it('times out and ignores a later response', async () => {
    jest.useFakeTimers();
    const request = harness.transport.request('slow', {}, { timeoutMs: 500 });
    const outbound = await harness.nextOutbound();

    jest.advanceTimersByTime(500);
    await expect(request).rejects.toThrow('Request timeout: slow (500ms)');

    harness.sendInbound({ id: outbound.id, jsonrpc: '2.0', result: 'late' });
    expect(harness.transport.isClosed).toBe(false);
  });

  it('supports cancellation before and during a request', async () => {
    const before = new AbortController();
    before.abort();
    await expect(harness.transport.request('before', {}, { signal: before.signal }))
      .rejects.toThrow('Request aborted: before');

    const during = new AbortController();
    const request = harness.transport.request('during', {}, {
      signal: during.signal,
      timeoutMs: 0,
    });
    const outbound = await harness.nextOutbound();
    expect(outbound.method).toBe('during');
    during.abort();

    await expect(request).rejects.toThrow('Request aborted: during');
    harness.sendInbound({ id: outbound.id, jsonrpc: '2.0', result: 'late' });
  });

  it('sends notifications and dispatches all registered notification handlers', async () => {
    const first = jest.fn();
    const second = jest.fn();
    harness.transport.onNotification('turn/updated', first);
    const unsubscribe = harness.transport.onNotification('turn/updated', second);

    harness.transport.notify('initialized');
    await expect(harness.nextOutbound()).resolves.toEqual({
      jsonrpc: '2.0',
      method: 'initialized',
    });

    harness.sendInbound({
      jsonrpc: '2.0',
      method: 'turn/updated',
      params: { status: 'running' },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(first).toHaveBeenCalledWith({ status: 'running' });
    expect(second).toHaveBeenCalledWith({ status: 'running' });

    unsubscribe();
    harness.sendInbound({ jsonrpc: '2.0', method: 'turn/updated', params: { status: 'done' } });
    await new Promise(resolve => setImmediate(resolve));
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('exposes the native server-request ID in handler context', async () => {
    const handler = jest.fn().mockResolvedValue({ decision: 'accept' });
    harness.transport.start();
    harness.transport.onRequest('approval/request', handler);

    harness.sendInbound({
      id: 'native-request-7',
      jsonrpc: '2.0',
      method: 'approval/request',
      params: { command: 'echo ok' },
    });

    await expect(harness.nextOutbound()).resolves.toEqual({
      id: 'native-request-7',
      jsonrpc: '2.0',
      result: { decision: 'accept' },
    });
    expect(handler).toHaveBeenCalledWith(
      { command: 'echo ok' },
      { method: 'approval/request', requestId: 'native-request-7' },
    );
  });

  it('returns standard errors for missing and failed server-request handlers', async () => {
    harness.transport.start();
    harness.sendInbound({ id: 10, jsonrpc: '2.0', method: 'missing' });
    await expect(harness.nextOutbound()).resolves.toMatchObject({
      error: { code: -32601 },
      id: 10,
    });

    harness.transport.onRequest('failed', () => {
      throw new Error('handler failed');
    });
    harness.sendInbound({ id: 11, jsonrpc: '2.0', method: 'failed' });
    await expect(harness.nextOutbound()).resolves.toMatchObject({
      error: { code: -32603, message: 'handler failed' },
      id: 11,
    });
  });

  it.each([
    ['input error', (current: TransportHarness) => current.input.emit('error', new Error('read failed')), 'read failed'],
    ['input end', (current: TransportHarness) => current.input.end(), 'JSON-RPC input closed'],
    ['input close', (current: TransportHarness) => current.input.emit('close'), 'JSON-RPC input closed'],
    ['output error', (current: TransportHarness) => current.output.emit('error', new Error('write failed')), 'write failed'],
    ['output close', (current: TransportHarness) => current.output.emit('close'), 'JSON-RPC output closed'],
  ])('rejects pending requests on %s', async (_label, terminate, expectedMessage) => {
    const request = harness.transport.request('pending', {}, { timeoutMs: 0 });
    await harness.nextOutbound();

    terminate(harness);

    await expect(request).rejects.toThrow(expectedMessage);
    expect(harness.transport.isClosed).toBe(true);
  });

  it('rejects pending requests with the provider process-death error', async () => {
    const request = harness.transport.request('pending', {}, { timeoutMs: 0 });
    await harness.nextOutbound();

    harness.closeProcess(new Error('provider exited with diagnostics'));

    await expect(request).rejects.toThrow('provider exited with diagnostics');
    expect(harness.unregisterClose).toHaveBeenCalledTimes(1);
  });

  it('allows an authoritative owner-close error to supersede stream closure', async () => {
    const deferred = createTransportHarness(30_000, 1_000);
    try {
      const request = deferred.transport.request('pending', {}, { timeoutMs: 0 });
      const outcome = request.then(
        () => null,
        (error: Error) => error,
      );
      await deferred.nextOutbound();

      deferred.input.end();
      await new Promise(resolve => setImmediate(resolve));
      expect(deferred.transport.isClosed).toBe(false);

      deferred.closeProcess(new Error('provider exited with late diagnostics'));
      await expect(outcome).resolves.toEqual(expect.objectContaining({
        message: 'provider exited with late diagnostics',
      }));
    } finally {
      deferred.transport.dispose();
      deferred.close();
    }
  });

  it('falls back to the stream-close error after the owner-close grace period', async () => {
    jest.useFakeTimers();
    const deferred = createTransportHarness(30_000, 1_000);
    try {
      const request = deferred.transport.request('pending', {}, { timeoutMs: 0 });
      const outcome = request.then(
        () => null,
        (error: Error) => error,
      );
      await deferred.nextOutbound();

      deferred.input.emit('end');
      expect(deferred.transport.isClosed).toBe(false);
      jest.advanceTimersByTime(1_000);

      await expect(outcome).resolves.toEqual(expect.objectContaining({
        message: 'JSON-RPC input closed',
      }));
      expect(deferred.transport.isClosed).toBe(true);
    } finally {
      deferred.transport.dispose();
      deferred.close();
    }
  });

  it('removes listeners and disposes exactly once', () => {
    const onClose = jest.fn();
    const baseline = {
      inputClose: harness.input.listenerCount('close'),
      inputEnd: harness.input.listenerCount('end'),
      inputError: harness.input.listenerCount('error'),
      outputClose: harness.output.listenerCount('close'),
      outputError: harness.output.listenerCount('error'),
    };
    harness.transport.start();
    harness.transport.onClose(onClose);

    harness.transport.dispose(new Error('first close'));
    harness.transport.dispose(new Error('second close'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ message: 'first close' }));
    expect(harness.unregisterClose).toHaveBeenCalledTimes(1);
    expect(harness.transport.signal.aborted).toBe(true);
    expect(harness.input.listenerCount('error')).toBe(baseline.inputError);
    expect(harness.input.listenerCount('end')).toBe(baseline.inputEnd);
    expect(harness.input.listenerCount('close')).toBe(baseline.inputClose);
    expect(harness.output.listenerCount('error')).toBe(baseline.outputError);
    expect(harness.output.listenerCount('close')).toBe(baseline.outputClose);
  });

  it('rejects requests after disposal with the closed transport error', async () => {
    harness.transport.dispose();

    await expect(harness.transport.request('after-dispose'))
      .rejects.toBeInstanceOf(JsonRpcTransportClosedError);
  });
});
