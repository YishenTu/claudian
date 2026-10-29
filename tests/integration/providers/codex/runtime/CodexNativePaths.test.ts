import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { resolveCodexRolloutFile } from '@/providers/codex/history/CodexHistoryPathResolver';
import { deriveCodexSessionsRootFromSessionPath, findCodexSessionFileAsync } from '@/providers/codex/history/CodexHistoryStore';
import { buildCodexLaunchSpec } from '@/providers/codex/runtime/CodexLaunchSpecBuilder';
import { createCodexRuntimeContext } from '@/providers/codex/runtime/CodexRuntimeContext';
import { resolveCodexWorkspaceDependencies } from '@/providers/codex/runtime/CodexWorkspaceDependencyResolver';
import { getCodexProviderSettings } from '@/providers/codex/settings';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('native Codex paths containing literal backslashes', () => {
  let root: string;
  let vault: string;
  let home: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-codex-posix-'));
    vault = path.join(root, 'vault\\name');
    home = path.join(root, 'home\\name');
    await Promise.all([fs.mkdir(vault), fs.mkdir(home)]);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  function context() {
    const launch = buildCodexLaunchSpec({
      codexSettings: getCodexProviderSettings({}), resolvedCliCommand: 'codex',
      hostVaultPath: vault, env: { HOME: home }, hostPlatform: process.platform,
    });
    return createCodexRuntimeContext(launch, {
      userAgent: 'native-path-test', platformFamily: 'unix',
      platformOs: process.platform === 'darwin' ? 'macos' : 'linux',
      codexHome: path.join(home, '.codex'),
    });
  }

  it('launches the actual vault and retains the initialized native home', async () => {
    const runtime = context();
    expect(runtime.launchSpec.targetCwd).toBe(vault);
    expect((await fs.stat(runtime.launchSpec.targetCwd)).isDirectory()).toBe(true);
    expect(runtime.codexHomeHost).toBe(path.join(home, '.codex'));
    expect(runtime.sessionsDirHost).toBe(path.join(home, '.codex', 'sessions'));
  });

  it('admits and rediscovers a transcript in the actual native home', async () => {
    const sessions = path.join(home, '.codex', 'sessions');
    await fs.mkdir(sessions, { recursive: true });
    const transcript = path.join(sessions, 'rollout-thread.jsonl');
    await fs.writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'thread' } }) + '\n');
    expect(deriveCodexSessionsRootFromSessionPath(transcript)).toBe(sessions);
    await expect(resolveCodexRolloutFile(transcript, 'thread', null, {
      environment: { HOME: home }, hostPlatform: process.platform, vaultPath: vault,
    })).resolves.toBe(transcript);
    await expect(findCodexSessionFileAsync('thread', sessions)).resolves.toBe(transcript);
    expect(JSON.parse((await fs.readFile(transcript, 'utf8')).trim()).payload.id).toBe('thread');
  });

  it('finds the actual bundled dependencies under that native home', async () => {
    const runtimeRoot = path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime');
    const dependencies = path.join(runtimeRoot, 'dependencies');
    for (const directory of ['node/bin', 'node/node_modules/@oai/artifact-tool', 'python/bin', 'bin/override', 'bin/fallback']) {
      await fs.mkdir(path.join(dependencies, directory), { recursive: true });
    }
    await Promise.all([
      fs.writeFile(path.join(runtimeRoot, 'runtime.json'), JSON.stringify({ bundleVersion: 'test', targetPlatform: process.platform })),
      fs.writeFile(path.join(dependencies, 'node/bin/node'), ''),
      fs.writeFile(path.join(dependencies, 'python/bin/python3'), ''),
      fs.writeFile(path.join(dependencies, 'node/node_modules/@oai/artifact-tool/package.json'), JSON.stringify({ version: 'test' })),
    ]);
    const result = await resolveCodexWorkspaceDependencies(context());
    expect(result?.runtimeRoot).toBe(runtimeRoot);
    expect(result?.nodeExecutable).toBe(path.join(dependencies, 'node/bin/node'));
    expect((await fs.stat(result!.nodeExecutable)).isFile()).toBe(true);
  });
});
