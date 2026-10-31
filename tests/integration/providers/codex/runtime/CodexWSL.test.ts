import '@/providers';

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';
import { testTime } from '@test/helpers/testClock';
import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderExecutionEvent } from '@/core/execution';
import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';
import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof fs>() }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fsPromises>() }));
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

// The native suite owns OS fidelity; this keeper makes provider wiring faults reproducible on POSIX.
describe.skipIf(process.platform === 'win32')('Codex WSL session history wiring', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each([
    ['C:\\vault', '/mnt/c/vault'],
    ['\\\\wsl$\\Ubuntu\\home\\alice\\vault', '/home/alice/vault'],
  ])('persists a host-readable rollout after launching from %s', async (vault, targetVault) => {
    const hostFS = createWindowsHostFS({ fs, fsPromises });
    const id = randomUUID();
    const targetFile = `/opt/codex/sessions/rollout-${id}.jsonl`;
    const hostFile = `\\\\wsl$\\Ubuntu\\opt\\codex\\sessions\\rollout-${id}.jsonl`;
    const harness = new CodexRuntimeHarness();
    harness.autoReconcile = true;
    const native = harness.createProcess({ platformFamily: 'unix', platformOs: 'linux' });
    harness.requestOverride = (peer, request) => {
      if (request.method === 'initialize') {
        peer.respond(request.id, { userAgent: 'codex-wsl-peer', codexHome: '/opt/codex', platformFamily: 'unix', platformOs: 'linux' });
        return true;
      }
      if (request.method === 'thread/start') {
        peer.respond(request.id, { thread: { id, path: targetFile, turns: [] }, sandbox: { type: 'dangerFullAccess' } });
        return true;
      }
      if (request.method === 'turn/start') {
        const turn = { id: `turn-${id}`, status: 'completed', items: [] };
        peer.respond(request.id, { turn: { ...turn, status: 'inProgress' } });
        peer.notify('item/agentMessage/delta', { threadId: id, turnId: turn.id, itemId: 'answer', delta: 'Linux reply' });
        peer.notify('turn/completed', { threadId: id, turn });
        return true;
      }
      return false;
    };
    const wsl = new WSLProcessFixture();
    wsl.reply = request => {
      if (request.executable !== '/opt/bin/codex') return undefined;
      native.stdout.on('data', chunk => request.write(String(chunk)));
      request.onStdin(chunk => native.stdin.write(chunk));
      return { hold: true };
    };
    vi.mocked(spawn).mockReset().mockImplementation(wsl.spawn);
    const key = getInstallationKey();
    const fixture = await createProviderHostFixture({ settings: { providerConfigs: { codex: {
      enabled: true, discoveredModels: TEST_CODEX_CATALOG,
      installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' },
      environmentVariables: 'CODEX_HOME=/opt/codex',
    } } }, overrides: { workingDirectory: vault, getResolvedProviderCliPath: async () => '/opt/bin/codex' } });
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    const host = fixture.host.getRuntimeHost('codex');
    const runtime = new CodexAppServerRuntime(host, () => undefined);
    const session = new CodexExecutionBackend(host, () => runtime).createSession({
      lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: vault,
      interactionPort: { requestApproval: async () => { throw new Error('Unexpected approval'); },
        askUserQuestion: async () => { throw new Error('Unexpected question'); }, dismissInteraction() {} },
    });
    try {
      await hostFS.write(hostFile, [
        { type: 'session_meta', payload: { id, cwd: targetVault } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Linux reply' }] } },
      ].map(record => JSON.stringify({ timestamp: testTime(), ...record })).join('\n'));
      const events: ProviderExecutionEvent[] = [];
      for await (const event of session.execute({ input: [{ type: 'text', text: 'hello' }],
        configuration: { model: TEST_CODEX_MODEL, permissionMode: 'yolo', systemInstructions: { kind: 'explicit', instructions: 'Reply.' } },
        toolPolicy: { kind: 'provider-default' }, signal: AbortSignal.timeout(5_000),
      }).events) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      expect(native.requests.find(request => request.method === 'thread/start')?.params.cwd).toBe(targetVault);
      expect(wsl.requests[0].args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', targetVault]));
      const snapshot = session.getSnapshot();
      expect(snapshot.providerState).toMatchObject({ sessionFilePath: hostFile, transcriptRootPath: '\\\\wsl$\\Ubuntu\\opt\\codex\\sessions' });
      const history = await new CodexConversationHistoryService().hydrateConversationHistory({
        sessionId: snapshot.providerSessionId ?? null, providerState: snapshot.providerState, messages: [],
      }, vault, { config: host.config, environment: { CODEX_HOME: '/opt/codex' }, environmentText: host.environmentText,
        hostPlatform: 'win32', vaultPath: vault });
      expect(history.messages?.map(message => message.content)).toEqual(['Linux reply']);
      expect(history.providerState).toMatchObject({ sessionFilePath: hostFile });
    } finally {
      await session.dispose();
      await runtime.dispose();
      await fixture.dispose();
    }
  });
});
