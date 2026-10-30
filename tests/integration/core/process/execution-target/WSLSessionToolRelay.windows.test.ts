// @test-ci {"inputs":["src/core/session-tools/**","tests/{unit,integration}/core/session-tools/**"]}
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { hasNativeWSL } from '@test/helpers/WSLNativeTarget';

import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import { LoopbackSessionToolServer } from '@/core/session-tools/LoopbackSessionToolServer';
import type { SessionToolRoute } from '@/core/session-tools/SessionToolEndpoint';
import { createWSLSessionToolRelay } from '@/core/session-tools/WSLSessionToolRelay';

// Windows CI uses WSL1. Transport is stdio -> Windows HTTP, with no Linux socket;
// the same design works under WSL2 NAT, but this test does not claim a NAT run.
describe.skipIf(!hasNativeWSL())('Windows session tool relay through WSL interop', { timeout: 60_000 }, () => {
  let server: LoopbackSessionToolServer;
  const children: ReturnType<typeof spawn>[] = [];
  beforeEach(() => { server = new LoopbackSessionToolServer(); });
  afterEach(async () => {
    for (const child of children.splice(0)) child.stdin?.end();
    await server.close();
  });

  async function connect(route: SessionToolRoute, mode: 'mcp' | 'call' = 'mcp') {
    const target = await resolveExecutionTargetAsync({ settings: { installationMethod: 'wsl', wslDistroOverride: '' } });
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const relay = await createWSLSessionToolRelay({ target, hostCwd: process.cwd(), env, route, mode });
    // The same command/args/env Grok launches as its stdio MCP child in Linux.
    const spec = buildTargetLaunchSpec({ target, hostCwd: process.cwd(), command: relay.command, args: ['-ExecutionPolicy', 'Restricted', ...relay.args], env: { ...env, ...relay.env } });
    const child = spawn(spec.command, spec.args, { cwd: spec.spawnCwd, env: spec.env, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments });
    children.push(child);
    const lines: unknown[] = [];
    const input = createInterface({ input: child.stdout });
    input.on('line', line => lines.push(JSON.parse(line)));
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const closed = new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
    return {
      lines, closed, stderr: () => stderr,
      end: () => child.stdin.end(),
      send: (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n'),
      response: async (id: number) => {
        await vi.waitFor(() => expect(lines.some(value => (value as { id?: number }).id === id)).toBe(true), { timeout: 15_000 });
        return lines.find(value => (value as { id?: number }).id === id);
      },
    };
  }

  it('initializes, lists and calls tools, forwards notifications concurrently, cancels and disconnects on EOF', async () => {
    const started = new Set<number>();
    const cancelled = new Set<number>();
    const route = await server.registerMCPRoute(async request => {
      const n = (request.args as { n: number }).n;
      started.add(n);
      if (n < 10) {
        await new Promise<void>(resolve => {
          if (request.signal.aborted) resolve();
          else request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        cancelled.add(n);
      }
      return { isError: false, text: `result ${n} 中文` };
    });
    const client = await connect(route);
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(await client.response(1)).toMatchObject({ result: { protocolVersion: '2025-03-26' } });
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(await client.response(2)).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'claudian_list_destinations' })]) } });
    const call = (id: number, n: number) => client.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'claudian_list_destinations', arguments: { n } } });
    call(3, 1); call(4, 2); call(5, 3);
    await vi.waitFor(() => expect(started.size).toBe(3), { timeout: 15_000 });
    call(6, 10);
    expect(await client.response(6)).toMatchObject({ result: { content: [{ type: 'text', text: 'result 10 中文' }] } });
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
    await vi.waitFor(() => expect(cancelled.has(1)).toBe(true), { timeout: 15_000 });
    // A ping after the notification establishes that its 202 did not create a line.
    client.send({ jsonrpc: '2.0', id: 7, method: 'ping' });
    await client.response(7);
    expect(client.lines.map(value => (value as { id: number }).id)).toEqual([1, 2, 6, 7]);
    client.end();
    expect(await client.closed).toBe(0);
    await vi.waitFor(() => expect([...cancelled].sort()).toEqual([1, 2, 3]), { timeout: 15_000 });
  });

  it('cancels immediately after a large call without waiting for endpoint admission', async () => {
    const route = await server.registerMCPRoute(async () => {
      // Give the following stdin notification time to reach the relay even if
      // this HTTP body happens to win admission on a fast Windows host.
      await new Promise(resolve => setTimeout(resolve, 100));
      return { isError: false, text: 'must not be delivered' };
    });
    const client = await connect(route);
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await client.response(1);
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'claudian_list_destinations', arguments: { text: 'x'.repeat(800_000) } } });
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    client.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    await client.response(3);
    // Observe beyond the handler's completion deadline, then prove the relay
    // remains usable rather than interpreting per-request cancellation as fatal.
    await new Promise(resolve => setTimeout(resolve, 500));
    client.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    await client.response(4);
    expect(client.lines.map(value => (value as { id: number }).id)).toEqual([1, 3, 4]);
    client.end();
    expect(await client.closed).toBe(0);
  });

  it('supports a one-shot call with unchanged caller identity and exits after the response', async () => {
    const handler = vi.fn(async () => ({ isError: false, text: 'reply' }));
    const route = await server.registerCallRoute(handler);
    const client = await connect(route, 'call');
    client.send({ tool: 'claudian_list_destinations', args: { key: '值' }, callerNativeId: 'child/session' });
    expect(await client.closed).toBe(0);
    expect(client.lines).toEqual([{ isError: false, text: 'reply' }]);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ callerNativeId: 'child/session', args: { key: '值' } }));
  });

  it('cancels a one-shot call when its plugin closes stdin', async () => {
    let started!: () => void;
    let cancelled!: () => void;
    const admission = new Promise<void>(resolve => { started = resolve; });
    const abort = new Promise<void>(resolve => { cancelled = resolve; });
    const route = await server.registerCallRoute(async request => {
      request.signal.addEventListener('abort', cancelled, { once: true });
      started();
      await abort;
      return { isError: true, text: 'cancelled' };
    });
    const client = await connect(route, 'call');
    client.send({ tool: 'claudian_list_destinations', args: {}, callerNativeId: 'native' });
    await admission;
    client.end();
    expect(await client.closed).toBe(0);
    await abort;
    expect(client.lines).toEqual([]);
  });

  it('cannot use a revoked route and never prints its secret', async () => {
    const route = await server.registerMCPRoute(async () => ({ isError: false, text: '' }));
    const client = await connect(route);
    route.dispose();
    client.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(await client.closed).toBe(1);
    expect(client.lines).toEqual([]);
    expect(client.stderr()).not.toContain(route.routeId);
  });
});
