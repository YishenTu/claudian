import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { SESSION_TOOL_ROUTE_HEADER } from '@/core/session-tools/SessionToolEndpoint';
import { createWSLSessionToolRelay } from '@/core/session-tools/WSLSessionToolRelay';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const target = { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' } as const;
const route = { url: 'http://127.0.0.1:1234/mcp', routeId: 'secret-route', headers: { [SESSION_TOOL_ROUTE_HEADER]: 'secret-route' }, dispose: vi.fn() };
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

let native: WSLProcessFixture;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  native = new WSLProcessFixture();
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });

it('probes Windows interop and sends credentials only in forwarded environment', async () => {
  const relay = await createWSLSessionToolRelay({ target, hostCwd: 'C:\\vault', env: { WSLENV: 'EXISTING/p' }, route, mode: 'mcp' });
  expect(relay.command).toBe('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  expect(relay.args).toContain('-EncodedCommand');
  expect(JSON.stringify(relay.args)).not.toContain('secret-route');
  expect(Buffer.from(relay.args.at(-1)!, 'base64').toString('utf16le')).not.toContain('secret-route');
  expect(relay.env).toEqual({
    WSLENV: 'EXISTING/p:CLAUDIAN_SESSION_TOOL_URL:CLAUDIAN_SESSION_TOOL_ROUTE:CLAUDIAN_SESSION_TOOL_MODE',
    CLAUDIAN_SESSION_TOOL_URL: route.url, CLAUDIAN_SESSION_TOOL_ROUTE: 'secret-route', CLAUDIAN_SESSION_TOOL_MODE: 'mcp',
  });
  // The probe runs the same program through the same interop path, without the route.
  const [probe] = native.requests;
  expect(native.requests).toHaveLength(1);
  expect([probe.executable, ...probe.argv]).toEqual([relay.command, ...relay.args]);
  expect(probe.options.cwd).toBe('C:\\vault');
  expect(JSON.stringify([probe.command, probe.args, probe.options.env])).not.toContain('secret-route');
  expect([probe.command, ...probe.args].join(' ').length).toBeLessThan(32_767);
  expect(route.dispose).not.toHaveBeenCalled();
});

it('replaces stale relay declarations instead of duplicating them', async () => {
  const relay = await createWSLSessionToolRelay({ target, hostCwd: 'C:\\vault', env: { WSLENV: 'CLAUDIAN_SESSION_TOOL_ROUTE/p::KEEP' }, route: { ...route, url: 'http://127.0.0.1:1234/call' }, mode: 'call' });
  expect(relay.env.WSLENV).toBe('KEEP:CLAUDIAN_SESSION_TOOL_URL:CLAUDIAN_SESSION_TOOL_ROUTE:CLAUDIAN_SESSION_TOOL_MODE');
  expect(relay.env.CLAUDIAN_SESSION_TOOL_MODE).toBe('call');
  const fresh = await createWSLSessionToolRelay({ target, hostCwd: 'C:\\vault', env: {}, route, mode: 'mcp' });
  expect(fresh.env.WSLENV).toBe('CLAUDIAN_SESSION_TOOL_URL:CLAUDIAN_SESSION_TOOL_ROUTE:CLAUDIAN_SESSION_TOOL_MODE');
});

it('reports an actionable error when interop is unavailable', async () => {
  native.interop = false;
  await expect(createWSLSessionToolRelay({ target, hostCwd: 'C:\\vault', env: {}, route, mode: 'mcp' }))
    .rejects.toThrow(/WSL interop.*PowerShell/);
});

it('requires SystemRoot to locate Windows PowerShell before launching anything', async () => {
  vi.stubEnv('SystemRoot', undefined);
  vi.stubEnv('SYSTEMROOT', undefined);
  await expect(createWSLSessionToolRelay({ target, hostCwd: 'C:\\vault', env: {}, route, mode: 'mcp' }))
    .rejects.toThrow(/SystemRoot/);
  expect(native.requests).toEqual([]);
});

it.each([
  ['http://192.168.1.1:1234/mcp', 'mcp'], ['http://127.0.0.1:1234/mcp?token=secret', 'mcp'], ['http://127.0.0.1:1234/call', 'mcp'],
  ['https://127.0.0.1:1234/mcp', 'mcp'], ['http://127.0.0.1/mcp', 'mcp'], ['http://user:pass@127.0.0.1:1234/mcp', 'mcp'],
  ['http://127.0.0.1:1234/mcp#fragment', 'mcp'], ['http://127.0.0.1:1234/mcp', 'call'],
] as const)('rejects a mismatched endpoint %s for %s before launching anything', async (url, mode) => {
  await expect(createWSLSessionToolRelay({ target, hostCwd: 'C:\\vault', env: {}, route: { ...route, url }, mode })).rejects.toThrow(/loopback/);
  expect(native.requests).toEqual([]);
});

it.each([
  { method: 'host-native', platformFamily: 'windows', platformOs: 'windows' },
  // A stale distro name must not turn a native target into an interop relay.
  { method: 'host-native', platformFamily: 'windows', platformOs: 'windows', distroName: 'Ubuntu' },
  { method: 'wsl', platformFamily: 'unix', platformOs: 'linux' },
] as const)('requires a resolved WSL distro (%o)', async invalid => {
  await expect(createWSLSessionToolRelay({ target: invalid, hostCwd: 'C:\\vault', env: {}, route, mode: 'mcp' })).rejects.toThrow(/resolved distro/);
  expect(native.requests).toEqual([]);
});
