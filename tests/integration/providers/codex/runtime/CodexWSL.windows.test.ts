// @test-ci {"inputs":["src/providers/codex/**","tests/{unit,integration}/providers/codex/**","tests/helpers/providers/codex/**","tests/helpers/testClock.ts"]}
import '@/providers';

import * as path from 'node:path';

import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { provisionWSLPeer } from '@test/helpers/WSLNativePeer';
import { hasNativeWSL } from '@test/helpers/WSLNativeTarget';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderExecutionEvent } from '@/core/execution';
import { parseEnvironmentVariables } from '@/core/process/env';
import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';
import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';

// CI uses WSL1. This proves Windows/WSL launch and filesystem mechanics with the native peer.
describe.skipIf(!hasNativeWSL())('native Codex WSL session and history', () => {
  it.each(['drive', 'distro'] as const)('launches, exchanges a turn and reads the Linux rollout from a %s vault', { timeout: 90_000 }, async location => {
    const peer = await provisionWSLPeer('codex', location, 'tests/helpers/providers/codex/CodexWSLPeer.ts');
    const key = getInstallationKey();
    const fixture = await createProviderHostFixture({
      settings: { providerConfigs: { codex: {
        enabled: true, discoveredModels: TEST_CODEX_CATALOG,
        cliPathsByHost: { [key]: peer.cli }, installationMethodsByHost: { [key]: 'wsl' },
        wslDistroOverridesByHost: { [key]: peer.target.distroName! },
        environmentVariables: `CODEX_HOME=${peer.targetHome}`,
      } } },
      overrides: { workingDirectory: peer.vault, getResolvedProviderCliPath: async () => peer.cli },
    });
    const host = fixture.host.getRuntimeHost('codex');
    const runtime = new CodexAppServerRuntime(host, () => undefined);
    const session = new CodexExecutionBackend(host, () => runtime).createSession({
      lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: peer.vault,
      interactionPort: { requestApproval: async () => { throw new Error('Unexpected approval'); },
        askUserQuestion: async () => { throw new Error('Unexpected question'); }, dismissInteraction() {} },
    });
    try {
      const text = 'Codex WSL round trip: 中文 $HOME # literal';
      const events: ProviderExecutionEvent[] = [];
      for await (const event of session.execute({
        input: [{ type: 'text', text }], configuration: { model: TEST_CODEX_MODEL, reasoning: 'high', permissionMode: 'yolo',
          systemInstructions: { kind: 'explicit', instructions: 'Reply to the fixture prompt.' } },
        toolPolicy: { kind: 'provider-default' }, signal: AbortSignal.timeout(40_000),
      }).events) events.push(event);
      expect(events.filter(event => event.type === 'execution_error')).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      const reply = events.filter(event => event.type === 'text_delta').map(event => event.text).join('');
      expect(JSON.parse(reply)).toEqual({ platform: 'linux', cwd: peer.targetVault, threadCwd: peer.targetVault, text, home: peer.targetHome });
      const snapshot = session.getSnapshot();
      expect(snapshot.providerSessionId).toMatch(/^[\da-f-]{36}$/u);
      const expectedFile = path.win32.join(peer.home, 'sessions', `rollout-${snapshot.providerSessionId}.jsonl`);
      expect(snapshot.providerState).toMatchObject({ sessionFilePath: expectedFile, transcriptRootPath: path.win32.join(peer.home, 'sessions') });
      // Read through the provider boundary with the persisted snapshot and the same settings.
      // The peer wrote this file in Linux; the test never creates or rewrites its transcript.
      const history = await new CodexConversationHistoryService().hydrateConversationHistory({
        sessionId: snapshot.providerSessionId ?? null, providerState: snapshot.providerState, messages: [],
      }, peer.vault, { config: host.config, environment: parseEnvironmentVariables(host.environmentText),
        environmentText: host.environmentText, hostPlatform: 'win32', vaultPath: peer.vault });
      expect(history.messages?.map(message => [message.role, message.content])).toEqual([['user', text], ['assistant', reply]]);
      expect(history.providerState).toMatchObject({ sessionFilePath: expectedFile });
    } finally {
      await session.dispose();
      await runtime.dispose();
      await fixture.dispose();
    }
  });
});
