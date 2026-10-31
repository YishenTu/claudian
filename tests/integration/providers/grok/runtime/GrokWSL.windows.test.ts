// @test-ci {"inputs":["src/providers/grok/**","tests/{unit,integration}/providers/grok/**","tests/helpers/providers/grok/**","tests/helpers/providers/NativeRPCTestProcess.ts","tests/helpers/testClock.ts"]}
import '@/providers';

import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { writeGrokCatalog } from '@test/helpers/providers/grokSettings';
import { testDate } from '@test/helpers/testClock';
import { provisionWSLPeer } from '@test/helpers/WSLNativePeer';
import { hasNativeWSL } from '@test/helpers/WSLNativeTarget';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderExecutionEvent } from '@/core/execution';
import { parseEnvironmentVariables } from '@/core/process/env';
import { GrokExecutionBackend } from '@/providers/grok/execution/GrokExecutionBackend';
import { GrokConversationHistoryService } from '@/providers/grok/history/GrokConversationHistoryService';

// CI uses WSL1. The real Grok peer executes in Linux; no credentials or vendor CLI are needed.
describe.skipIf(!hasNativeWSL())('native Grok WSL session and history', () => {
  it.each(['drive', 'distro'] as const)('launches, maps live tools and reads the Linux transcript from a %s vault', { timeout: 90_000 }, async location => {
    const peer = await provisionWSLPeer('grok', location, 'tests/helpers/providers/grok/GrokWSLPeer.ts');
    const key = getInstallationKey();
    const fixture = await createProviderHostFixture({
      settings: { providerConfigs: { grok: {
        enabled: true, visibleModels: ['grok-4'],
        cliPathsByHost: { [key]: peer.cli }, installationMethodsByHost: { [key]: 'wsl' },
        wslDistroOverridesByHost: { [key]: peer.target.distroName! },
        // Exercise WSLENV's host-path conversion as well as the Linux environment probe.
        environmentVariables: `GROK_HOME=${peer.home}`,
      } } },
      overrides: { workingDirectory: peer.vault },
    });
    writeGrokCatalog(fixture.settings, { defaultModelId: 'grok-4', fingerprint: 'native-wsl-peer', refreshedAt: testDate().getTime(),
      models: [{ rawId: 'grok-4', displayName: 'Grok 4', supportsReasoning: false, reasoningEfforts: [] }] });
    const host = fixture.host.getRuntimeHost('grok');
    const session = new GrokExecutionBackend(host).createSession({
      lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: peer.vault,
      interactionPort: { requestApproval: async () => { throw new Error('Unexpected approval'); },
        askUserQuestion: async () => { throw new Error('Unexpected question'); }, dismissInteraction() {} },
    });
    try {
      const text = 'Grok WSL round trip: 中文 $HOME # literal';
      const events: ProviderExecutionEvent[] = [];
      for await (const event of session.execute({
        input: [{ type: 'text', text }], configuration: { model: 'grok/grok-4', permissionMode: 'normal',
          systemInstructions: { kind: 'explicit', instructions: 'Reply to the fixture prompt.' } },
        toolPolicy: { kind: 'provider-default' }, signal: AbortSignal.timeout(40_000),
      }).events) events.push(event);
      expect(events.filter(event => event.type === 'execution_error')).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      const reply = events.filter(event => event.type === 'text_delta').map(event => event.text).join('');
      expect(JSON.parse(reply)).toEqual({ platform: 'linux', cwd: peer.targetVault, sessionCwd: peer.targetVault, text, home: peer.targetHome });
      const notes = path.win32.join(peer.vault, 'notes');
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool_started', input: expect.objectContaining({ path: notes }) }));
      const snapshot = session.getSnapshot();
      expect(snapshot.providerSessionId).toMatch(/^[\da-f-]{36}$/u);
      const expectedDirectory = path.win32.join(peer.home, 'sessions', encodeURIComponent(peer.targetVault), snapshot.providerSessionId!);
      // Discover from settings and session identity, so a launch-only path check cannot mask history wiring.
      const history = await new GrokConversationHistoryService().hydrateConversationHistory({
        sessionId: snapshot.providerSessionId ?? null, messages: [],
      }, peer.vault, { config: host.config, environment: { ...process.env, ...parseEnvironmentVariables(host.environmentText) },
        environmentText: host.environmentText, hostPlatform: 'win32', vaultPath: peer.vault });
      expect(history.messages?.filter(message => message.role === 'assistant').map(message => message.content)).toContain(reply);
      expect(history.messages?.flatMap(message => message.toolCalls ?? [])).toContainEqual(expect.objectContaining({ name: 'LS', input: expect.objectContaining({ path: notes }) }));
      expect(history.providerState).toMatchObject({ sessionDirectory: expectedDirectory });
    } finally {
      await session.dispose();
      await fixture.dispose();
    }
  });
});
