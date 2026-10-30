import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { hasNativeWSL } from '@test/helpers/WSLNativeTarget';

import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { LoopbackSessionToolServer } from '@/core/session-tools/LoopbackSessionToolServer';
import { resolveDeepSeekExecutionContext } from '@/providers/deepseek/runtime/DeepSeekExecutionContext';
import { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';
import { DeepSeekHostProcess } from '@/providers/deepseek/runtime/DeepSeekHostProcess';

// CI uses WSL1. Run this same suite on a WSL2 NAT/mirrored workstation to qualify localhost forwarding.
// Real dsh's authenticated profile and ephemeral storage semantics require separate manual verification.
describe.skipIf(!hasNativeWSL())('DeepSeek fixture Host in native WSL', { timeout: 120_000 }, () => {
  it.each(['drive', 'unc'])('launches from a %s vault with Linux artifacts, authenticated transport and call relay', async location => {
    const target = await resolveExecutionTargetAsync({ settings: { installationMethod: 'wsl', wslDistroOverride: '' } });
    const mapper = createExecutionPathMapper(target);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const run = async (command: string, args: string[]) => {
      const spec = buildTargetLaunchSpec({ target, hostCwd: process.cwd(), command, args, env });
      return runProcessProbe({ ...spec, cwd: spec.spawnCwd }, 20_000);
    };
    const root = location === 'drive' ? await mkdtemp(join(tmpdir(), 'DeepSeek WSL # 文档 '))
      : mapper.toHostPath((await run('/usr/bin/mktemp', ['-d', '/tmp/deepseek WSL # 文档.XXXXXX']))!.trim())!;
    const hostCwd = join(root, 'Vault');
    const home = join(root, 'native home');
    const packageRoot = join(root, 'npm package # 中文');
    const entry = join(packageRoot, 'lib/bin.mjs');
    const exitFile = join(root, 'exit.log');
    const server = new LoopbackSessionToolServer();
    let host: DeepSeekHost | undefined;
    let started: DeepSeekHostProcess | undefined;
    try {
      await Promise.all([mkdir(hostCwd), mkdir(dirname(entry), { recursive: true }), mkdir(join(home, 'profiles/web'), { recursive: true })]);
      await writeFile(join(home, 'profiles/web/package.json'), '{"userProfile":true}');
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.mjs' } }));
      await copyFile(resolve(__dirname, '../../../../fixtures/providers/deepseek/runtime/FakeDeepSeekWSLHost.mjs'), entry);
      const cliPath = mapper.toTargetPath(entry)!;
      expect(await run('/bin/chmod', ['+x', cliPath])).toBe('');
      Object.assign(env, { DSH_HOME: home,
        DSH_FIXTURE_PACKAGE: mapper.toTargetPath(resolve('package.json'))!, DSH_FIXTURE_EXIT: mapper.toTargetPath(exitFile)!,
      });
      const execution = await resolveDeepSeekExecutionContext(target, hostCwd, env, '');
      host = new DeepSeekHost(async () => ({ cliPath, cwd: hostCwd, environment: env, execution }), async (options, signal) => {
        started = await DeepSeekHostProcess.start(options, signal); return started;
      }, undefined, server);
      const lease = await host.attach();
      const calls: Array<{ caller: string; input: unknown }> = [];
      let cancelled = false;
      const lifetime = new AbortController();
      lease.claim('root', () => {}, call => ({ signal: lifetime.signal, invoke: async () => {
        calls.push({ caller: call.callerNativeId, input: call.args });
        if ((call.args as { hold?: boolean }).hold) {
          await new Promise<void>(resolve => call.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
        }
        return { isError: false, text: 'Windows route answered 中文' };
      } }));
      await lease.writePrompt('root', 'literal {{prompt}} $HOME 中文');
      await lease.writeCodeMode(true);
      const withdraw = await started!.offerEphemeralFork('root', 7);
      const info = await lease.client.call('fixture/inspect') as Record<string, any>;
      expect(info).toMatchObject({ relayHasCredentials: false, platform: 'linux', cwd: mapper.toTargetPath(hostCwd),
        prompt: 'literal {{prompt}} $HOME 中文', presentation: ['both'], spill: 'Linux artifact', attachment: 'Linux artifact',
        forks: [{ parent: 'root', atSeq: 7 }],
      });
      expect(info.executable).toMatch(/^\//);
      expect(info.plugins).toContain('tool-bash'); expect(info.plugins).not.toContain('tool-pwsh');
      expect(info.httpAuth).toBeGreaterThan(0); expect(info.websocketAuth).toBeGreaterThan(0);
      expect(await readFile(mapper.toHostPath(info.promptFile)!, 'utf8')).toBe('literal {{prompt}} $HOME 中文');
      await withdraw();
      const tool = (id: string, caller: string, input: unknown) => lease.client.call('fixture/tool', { id, caller, input, tool: 'claudian_list_destinations' });
      expect(await tool('success', 'child', { includeProviders: true })).toEqual({ text: 'Windows route answered 中文', isError: false });
      expect(calls).toEqual([{ caller: 'child', input: { includeProviders: true } }]);
      await expect(tool('denied', 'unbound', {})).rejects.toThrow(/Unbound/);
      const pending = tool('held', 'child', { hold: true });
      const rejected = pending.catch((error: Error) => error);
      await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 20_000 });
      await lease.client.call('fixture/cancel', { id: 'held' });
      expect(await rejected).toMatchObject({ message: expect.stringMatching(/cancelled/) });
      await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 20_000 });
      // Descriptor credentials are absent from artifacts other than the existing private endpoint file.
      const artifactRoot = dirname(mapper.toHostPath(info.patchPath)!);
      const endpoint = JSON.parse(await readFile(join(artifactRoot, 'session-tools.json'), 'utf8'));
      for (const file of await readdir(artifactRoot, { withFileTypes: true })) {
        if (!file.isFile() || file.name === 'session-tools.json') continue;
        expect(await readFile(join(artifactRoot, file.name), 'utf8')).not.toContain(endpoint.routeId);
      }
      await server.close();
      await expect(tool('revoked', 'child', {})).rejects.toThrow(/relay/);
      lease.release(); await host.dispose();
      expect(await readFile(exitFile, 'utf8')).toBe('owner\n');
      await expect(readdir(artifactRoot)).rejects.toThrow();
    } finally { await host?.dispose(); await server.close(); await rm(root, { recursive: true, force: true }); }
  });
});
