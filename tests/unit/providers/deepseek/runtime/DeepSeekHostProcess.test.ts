import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { ManagedStdioProcessOptions } from '@/core/process/ManagedStdioProcess';
import type { DeepSeekExecutionContext } from '@/providers/deepseek/runtime/DeepSeekExecutionContext';
import { DeepSeekHostProcess } from '@/providers/deepseek/runtime/DeepSeekHostProcess';

const { launches } = vi.hoisted(() => ({ launches: [] as ManagedStdioProcessOptions[] }));
// Capture at the process boundary, after the real artifacts and shared launch/environment encoding.
vi.mock('@/core/process/ManagedStdioProcess', async importOriginal => {
  const actual = await importOriginal<typeof import('@/core/process/ManagedStdioProcess')>();
  return { ...actual, ManagedStdioProcess: class extends actual.ManagedStdioProcess {
    constructor(options: ManagedStdioProcessOptions) { super(options); launches.push(options); }
    override start() { throw new Error('Launch captured at OS boundary'); }
  } };
});
vi.mock('@/providers/deepseek/runtime/DeepSeekWSLInstallation', () => ({
  DEEPSEEK_WSL_INSTALLATION_HELP: 'Linux installation required',
  probeDeepSeekWSLInstallation: async () => ({ installation: { path: '/usr/bin/dsh' }, nodePath: '/usr/bin/node', entryPath: '/opt/dsh/lib/bin.js' }),
}));

it('keeps route credentials out of the WSL launch environment and its shell capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'DeepSeek relay env '));
  const profile = join(root, 'profile');
  await mkdir(profile); await writeFile(join(profile, 'package.json'), '{}');
  const target = { method: 'wsl' as const, platformFamily: 'unix' as const, platformOs: 'linux' as const, distroName: 'Ubuntu' };
  // The test's filesystem boundary stands in for the Windows profile/artifact paths. Mapping itself is covered separately.
  const execution: DeepSeekExecutionContext = {
    target, targetCwd: '/mnt/c/Vault', targetHome: '/home/alice/.dsh', home: root, forwardEnvironment: [],
    pathMapper: { target, toTargetPath: path => `/mnt/c/Temp/${basename(path)}`,
      toHostPath: () => profile, mapTargetPathList: paths => paths, canRepresentHostPath: () => true },
  };
  const route = { url: 'http://127.0.0.1:1000/call', routeId: 'private-route-token' };
  try {
    await expect(DeepSeekHostProcess.start({ cliPath: 'dsh', cwd: 'C:\\Vault', execution, environment: {}, sessionToolRoute: route,
      sessionToolRelay: { command: '/mnt/c/Windows/powershell.exe', args: ['-EncodedCommand', 'relay-source'], env: {
        WSLENV: 'CLAUDIAN_SESSION_TOOL_URL:CLAUDIAN_SESSION_TOOL_ROUTE:CLAUDIAN_SESSION_TOOL_MODE',
        CLAUDIAN_SESSION_TOOL_URL: route.url, CLAUDIAN_SESSION_TOOL_ROUTE: route.routeId, CLAUDIAN_SESSION_TOOL_MODE: 'call',
      } },
    }, new AbortController().signal)).rejects.toThrow('Launch captured');
    const launch = launches.at(-1)!;
    expect(JSON.stringify(launch.env)).not.toContain(route.routeId);
    expect(JSON.stringify(launch.env)).not.toContain(route.url);
    expect(JSON.stringify(launch.args)).not.toContain(route.routeId);
    const metadata = JSON.parse(launch.env.CLAUDIAN_DEEPSEEK_SESSION_RELAY!);
    expect(metadata).toMatchObject({ command: '/mnt/c/Windows/powershell.exe', args: ['-EncodedCommand', 'relay-source'], env: { CLAUDIAN_SESSION_TOOL_MODE: 'call' } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
