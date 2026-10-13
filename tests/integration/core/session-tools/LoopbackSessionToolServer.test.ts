import * as http from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { LoopbackSessionToolServer } from '@/core/session-tools/LoopbackSessionToolServer';
import type { SessionToolRoute, SessionToolRoutedCallRequest } from '@/core/session-tools/SessionToolEndpoint';
import { SESSION_TOOL_SPECS, type SessionToolCallRequest } from '@/core/session-tools/sessionToolSpecs';

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

interface RawRequest {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Record<string, string | undefined>;
  readonly body?: string;
}

function routeRequest(route: SessionToolRoute, request: RawRequest = {}): Promise<RawResponse> {
  const url = new URL(route.url);
  const headers: Record<string, string> = {
    host: url.host,
    'content-type': 'application/json',
    ...route.headers,
  };
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const existing = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
    if (existing) delete headers[existing];
    if (value !== undefined) headers[name] = value;
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      method: request.method ?? 'POST',
      path: request.path ?? url.pathname,
      headers,
      setHost: false,
      agent: false,
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(request.body);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

const listCall = JSON.stringify({ tool: 'claudian_list_destinations', args: {}, callerNativeId: 'native-1' });

describe('LoopbackSessionToolServer', () => {
  let server: LoopbackSessionToolServer;

  beforeEach(() => {
    server = new LoopbackSessionToolServer({ maxBodyBytes: 256 });
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves JSON calls with the forwarded caller identity on a generic loopback URL', async () => {
    const requests: SessionToolRoutedCallRequest[] = [];
    const route = await server.registerCallRoute(async request => {
      requests.push(request);
      return { isError: false, text: '[]' };
    });

    const response = await routeRequest(route, { body: listCall });

    expect(route.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/call$/);
    expect(route.url).not.toContain(route.routeId);
    expect(route.headers).toEqual({ 'X-Claudian-Route': route.routeId });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(JSON.parse(response.body)).toEqual({ isError: false, text: '[]' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ name: 'claudian_list_destinations', args: {}, callerNativeId: 'native-1' });
  });

  it('issues distinct unguessable route ids', async () => {
    const handler = jest.fn();
    const routes = await Promise.all([server.registerCallRoute(handler), server.registerMCPRoute(handler)]);

    expect(routes[0].routeId).not.toBe(routes[1].routeId);
    for (const route of routes) expect(route.routeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each<[string, (route: SessionToolRoute) => RawRequest, number]>([
    ['a foreign Host', () => ({ headers: { host: 'attacker.example' } }), 403],
    ['a loopback Host on another port', route => ({ headers: { host: `127.0.0.1:${Number(new URL(route.url).port) + 1}` } }), 403],
    // Node's server answers a Host-less HTTP/1.1 request itself.
    ['a missing Host', () => ({ headers: { host: undefined } }), 400],
    ['the renderer Origin', () => ({ headers: { origin: 'app://obsidian.md' } }), 403],
    ['a same-origin Origin', route => ({ headers: { origin: new URL(route.url).origin } }), 403],
    ['GET', () => ({ method: 'GET', body: undefined }), 405],
    ['a CORS preflight', () => ({ method: 'OPTIONS', body: undefined }), 405],
    ['a missing route header', () => ({ headers: { 'X-Claudian-Route': undefined } }), 404],
    ['an unknown route id', () => ({ headers: { 'X-Claudian-Route': 'A'.repeat(43) } }), 404],
    ['the route id on another route shape path', () => ({ path: '/mcp' }), 404],
    ['a form content type', () => ({ headers: { 'content-type': 'text/plain' } }), 415],
    ['a missing content type', () => ({ headers: { 'content-type': undefined } }), 415],
    ['an oversized declared body', () => ({ body: JSON.stringify({ tool: 'claudian_list_destinations', args: { pad: 'x'.repeat(300) }, callerNativeId: 'n' }) }), 413],
    ['an oversized chunked body', () => ({
      headers: { 'transfer-encoding': 'chunked' },
      body: JSON.stringify({ tool: 'claudian_list_destinations', args: { pad: 'x'.repeat(300) }, callerNativeId: 'n' }),
    }), 413],
    ['invalid JSON', () => ({ body: '{' }), 400],
    ['a call without caller identity', () => ({ body: JSON.stringify({ tool: 'claudian_list_destinations', args: {} }) }), 400],
  ])('rejects %s before reaching the handler', async (_label, build, status) => {
    const handler = jest.fn(async () => ({ isError: false, text: '[]' }));
    const route = await server.registerCallRoute(handler);

    const response = await routeRequest(route, { body: listCall, ...build(route) });

    expect(response.status).toBe(status);
    expect(response.headers.allow).toBe(status === 405 ? 'POST' : undefined);
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts the localhost Host and a JSON content type with parameters', async () => {
    const handler = jest.fn(async () => ({ isError: false, text: '[]' }));
    const route = await server.registerCallRoute(handler);

    const response = await routeRequest(route, {
      body: listCall,
      headers: { host: `localhost:${new URL(route.url).port}`, 'content-type': 'Application/JSON; charset=utf-8' },
    });

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('revokes a released route and aborts its in-flight call', async () => {
    const started = deferred<AbortSignal>();
    const route = await server.registerCallRoute(async request => {
      started.resolve(request.signal);
      await waitForAbort(request.signal);
      return { isError: false, text: '[]' };
    });

    const pending = routeRequest(route, { body: listCall });
    const signal = await started.promise;
    route.dispose();

    expect(signal.aborted).toBe(true);
    expect((await pending).status).toBe(410);
    expect((await routeRequest(route, { body: listCall })).status).toBe(404);
  });

  it('aborts the call when the client disconnects', async () => {
    const started = deferred<AbortSignal>();
    const route = await server.registerCallRoute(async request => {
      started.resolve(request.signal);
      await waitForAbort(request.signal);
      return { isError: false, text: '[]' };
    });
    const url = new URL(route.url);
    const req = http.request({
      host: url.hostname, port: url.port, method: 'POST', path: url.pathname, agent: false,
      headers: { 'content-type': 'application/json', ...route.headers },
    });
    req.on('error', () => undefined);
    req.end(listCall);

    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    req.destroy();

    await waitForAbort(signal);
    expect(signal.aborted).toBe(true);
  });

  it('closes, aborting in-flight calls and refusing later registrations', async () => {
    const started = deferred<AbortSignal>();
    const route = await server.registerCallRoute(async request => {
      started.resolve(request.signal);
      await waitForAbort(request.signal);
      return { isError: false, text: '[]' };
    });
    const pending = routeRequest(route, { body: listCall }).catch(error => error);
    const signal = await started.promise;

    await server.close();

    expect(signal.aborted).toBe(true);
    await pending;
    await expect(server.registerMCPRoute(jest.fn())).rejects.toThrow(/closed/);
  });
});

describe('LoopbackSessionToolServer request timeouts', () => {
  let server: LoopbackSessionToolServer;

  beforeEach(() => {
    server = new LoopbackSessionToolServer({ requestTimeoutMs: 200, headersTimeoutMs: 100 });
  });

  afterEach(async () => {
    await server.close();
  });

  it('lets a call outlive the request timeout once its body has arrived', async () => {
    const route = await server.registerCallRoute(async () => {
      await new Promise(resolve => setTimeout(resolve, 600));
      return { isError: false, text: '{"sessionId":"conv-2","status":"queued"}' };
    });

    const response = await routeRequest(route, { body: listCall });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ isError: false, text: '{"sessionId":"conv-2","status":"queued"}' });
  });

  it('drops a request whose body stalls past the request timeout without calling the handler', async () => {
    const handler = jest.fn(async () => ({ isError: false, text: '[]' }));
    const route = await server.registerCallRoute(handler);
    const url = new URL(route.url);

    const status = await new Promise<number | string>(resolve => {
      const req = http.request({
        host: url.hostname, port: url.port, method: 'POST', path: url.pathname, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(listCall.length), ...route.headers },
      }, res => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', error => resolve(error.message));
      req.write(listCall.slice(0, 5));
    });

    expect(status).toBe(408);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('LoopbackSessionToolServer MCP route through the MCP SDK Streamable HTTP client', () => {
  let server: LoopbackSessionToolServer;
  let client: Client | undefined;

  beforeEach(() => {
    server = new LoopbackSessionToolServer();
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await server.close();
  });

  async function connect(route: SessionToolRoute) {
    const transport = new StreamableHTTPClientTransport(new URL(route.url), {
      requestInit: { headers: route.headers },
    });
    const connected = new Client({ name: 'grok-like', version: '1.0.0' });
    await connected.connect(transport);
    return connected;
  }

  it('initializes, lists and calls tools on the route bound to one session', async () => {
    const requests: SessionToolCallRequest[] = [];
    const route = await server.registerMCPRoute(async request => {
      requests.push(request);
      return { isError: false, text: '{"sessionId":"conv-2","status":"started"}' };
    });
    client = await connect(route);

    const { tools } = await client.listTools();
    const result = await client.callTool({ name: 'claudian_send_message', arguments: { sessionId: 'conv-2', text: 'Hi' } });

    expect(route.url).toMatch(/\/mcp$/);
    expect(tools.map(tool => tool.name)).toEqual(SESSION_TOOL_SPECS.map(spec => spec.name));
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"sessionId":"conv-2","status":"started"}' }],
      isError: false,
    });
    expect(requests.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: 'claudian_send_message', args: { sessionId: 'conv-2', text: 'Hi' } },
    ]);
  });

  it('aborts a call when the client cancels it', async () => {
    const started = deferred<AbortSignal>();
    const route = await server.registerMCPRoute(async request => {
      started.resolve(request.signal);
      await waitForAbort(request.signal);
      return { isError: false, text: '[]' };
    });
    client = await connect(route);
    const controller = new AbortController();

    const pending = client.callTool({ name: 'claudian_list_destinations', arguments: {} }, undefined, {
      signal: controller.signal,
    });
    const signal = await started.promise;
    controller.abort();

    await expect(pending).rejects.toThrow();
    await waitForAbort(signal);
    expect(signal.aborted).toBe(true);
  });

  it('answers MCP parse errors with a JSON-RPC error', async () => {
    const route = await server.registerMCPRoute(jest.fn());

    const response = await routeRequest(route, { body: '{' });

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
  });
});
