import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer } from 'ws';

import { DeepSeekRemoteClient } from '@/providers/deepseek/remote/DeepSeekRemoteClient';

let server: Server;
let sockets: WebSocketServer;
let client: DeepSeekRemoteClient | undefined;
let url: string;
const requests: Array<{ method: string; payload: unknown }> = [];
const held: Array<() => void> = [];

beforeEach(async () => {
  requests.length = 0; held.length = 0;
  server = createServer((req, res) => {
    if (req.url === '/?token=private-token') {
      res.writeHead(302, { 'Set-Cookie': 'dsh-session=private-cookie; HttpOnly', Location: '/' });
      res.end(); return;
    }
    if (req.headers.cookie !== 'dsh-session=private-cookie') { res.writeHead(401).end(); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const frame = JSON.parse(body);
      requests.push(frame);
      if (frame.method === 'fixture/stall') return;
      if (frame.method === 'fixture/held') {
        held.push(() => res.end(JSON.stringify({ type: 'server-response', rpcId: frame.rpcId, result: { ok: true, value: 'released' } })));
        return;
      }
      if (frame.method === 'fixture/malformed') { res.end('{broken'); return; }
      if (frame.method === 'fixture/foreign-rpc') {
        res.end(JSON.stringify({ type: 'server-response', rpcId: 'another-request', result: { ok: true, value: 'foreign' } }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ type: 'server-response', rpcId: frame.rpcId, result:
        frame.method === 'fixture/error'
          ? { ok: false, error: { code: 'session/writer-held', message: 'Writer already held' } }
          : { ok: true, value: frame.payload.args },
      }));
    });
  });
  sockets = new WebSocketServer({ server, path: '/api/remote.mux' });
  sockets.on('connection', (ws, req) => {
    if (req.headers.cookie !== 'dsh-session=private-cookie') { ws.close(); return; }
    ws.on('message', bytes => {
      const frame = JSON.parse(bytes.toString());
      if (frame.type === 'cancel') return;
      if (frame.type !== 'open') { ws.close(1008, 'invalid Remote stream request'); return; }
      if (frame.endpoint === 'fixture/error-stream') {
        ws.send(JSON.stringify({ type: 'error', streamId: frame.streamId, error: { code: 'session/missing', message: 'No such session' } }));
        return;
      }
      if (frame.endpoint === 'fixture/unknown-frame') { ws.send(JSON.stringify({ type: 'surprise', streamId: frame.streamId })); return; }
      ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value:
        frame.endpoint === '$events'
          ? { type: 'ready', clientId: 'native-client' }
          : { type: 'snapshot', cursor: 12, records: [] },
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?token=private-token`;
});

afterEach(async () => {
  client?.dispose(); client = undefined;
  for (const ws of sockets.clients) ws.terminate();
  sockets.close(); server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

it('authenticates unary calls and mux streams without exposing launch credentials', async () => {
  client = await DeepSeekRemoteClient.open(url);
  expect(client.clientId).toBe('native-client');
  expect(await client.call('session/list', { _request: {} })).toEqual({ _request: {} });
  const snapshot = await new Promise((resolve, reject) => client!.subscribe('session/follow', { request: { sessionId: 's' } }, resolve, reject));
  expect(snapshot).toEqual({ type: 'snapshot', cursor: 12, records: [] });
  expect(requests[0]).toMatchObject({ type: 'client-request', method: 'session/list' });
  await expect(client.call('fixture/error')).rejects.toMatchObject({ code: 'session/writer-held' });
  await expect(client.call('fixture/malformed')).rejects.toThrow(/malformed/i);
  await expect(client.call('fixture/foreign-rpc')).rejects.toThrow(/malformed.*result/i);
  await expect(client.call('fixture/stall', {}, { timeoutMs: 30 })).rejects.toThrow(/timed out/i);
});

it('rejects untrusted launch origins before authenticating and fences disposed calls', async () => {
  for (const address of ['https://example.com/?token=private-token', 'http://127.0.0.1.evil/?token=private-token', 'http://user:pass@127.0.0.1/?token=private-token']) {
    await expect(DeepSeekRemoteClient.open(address)).rejects.toThrow(/loopback/i);
  }
  await expect(DeepSeekRemoteClient.open(url.replace('private-token', 'stale-token'))).rejects.toThrow(/authentication failed \(HTTP 401\)/i);
  expect(sockets.clients.size).toBe(0);
  client = await DeepSeekRemoteClient.open(url);
  const closed = new Promise<Error>(resolve => client!.onDisconnect(resolve));
  for (const ws of sockets.clients) ws.terminate();
  expect((await closed).message).not.toMatch(/private-token|private-cookie/);
  await client.connect();
  expect(await client.call('session/list')).toEqual({});
  client.dispose();
  await expect(client.call('session/list')).rejects.toThrow(/disposed/i);
});


it('ends one stream, by cancellation or its own listener rejecting a frame, without disconnecting its siblings', async () => {
  client = await DeepSeekRemoteClient.open(url);
  const disconnected = jest.fn();
  client.onDisconnect(disconnected);
  const cancel = client.subscribe('job/list', {}, () => {}, () => {});
  cancel();
  const rejected = await new Promise<Error>(resolve => client!.subscribe('session/follow', {}, () => { throw new Error('Malformed session frame.'); }, resolve));
  expect(rejected.message).toBe('Malformed session frame.');
  // A subsequent open is a wire-order barrier: invalid cancellation closes the mux first.
  const snapshot = await Promise.race([
    new Promise((resolve, reject) => client!.subscribe('session/follow', {}, resolve, reject)),
    new Promise(resolve => client!.onDisconnect(() => resolve('disconnected'))),
  ]);
  expect(snapshot).toEqual({ type: 'snapshot', cursor: 12, records: [] });
  expect(disconnected).not.toHaveBeenCalled();
  expect(client.clientId).toBe('native-client');
  const remote = await new Promise<Error>(resolve => client!.subscribe('fixture/error-stream', {}, () => {}, resolve));
  expect(remote).toMatchObject({ code: 'session/missing', message: 'No such session' });
  expect(disconnected).not.toHaveBeenCalled();
});

it('closes the shared mux on an unknown stream frame instead of guessing its meaning', async () => {
  client = await DeepSeekRemoteClient.open(url);
  const disconnected = new Promise<Error>(resolve => client!.onDisconnect(resolve));
  client.subscribe('fixture/unknown-frame', {}, () => {}, () => {});
  expect((await disconnected).message).toMatch(/connection closed/i);
  expect(client.clientId).toBe('');
});

it('keeps the ordinary RPC deadline but waits without one only when asked, still honoring abort', async () => {
  client = await DeepSeekRemoteClient.open(url);
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  try {
    const abort = new AbortController();
    const settle = (promise: Promise<unknown>) => promise.then(value => ({ value }), (error: Error) => ({ error: error.message }));
    const bounded = settle(client.call('fixture/held'));
    const unbounded = settle(client.call('fixture/held', {}, { timeoutMs: 'none' }));
    const cancelled = settle(client.call('fixture/held', {}, { signal: abort.signal, timeoutMs: 'none' }));
    while (held.length < 3) await new Promise(resolve => setImmediate(resolve));
    jest.advanceTimersByTime(31_000);
    expect(await bounded).toEqual({ error: expect.stringMatching(/timed out/i) });
    abort.abort();
    expect(await cancelled).toEqual({ error: expect.any(String) });
    let pending = true;
    void unbounded.then(() => { pending = false; });
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    expect(pending).toBe(true);
    for (const release of held) release();
    expect(await unbounded).toEqual({ value: 'released' });
  } finally {
    jest.useRealTimers();
  }
});
