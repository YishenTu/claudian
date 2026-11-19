// @test-ci {"inputs":["src/providers/antigravity/**","tests/{unit,integration}/providers/antigravity/**","tests/helpers/providers/antigravity/**","tests/fixtures/providers/antigravity/runtime/**","tests/helpers/providers/NativeRPCTestProcess.ts"]}

import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { provisionWSLPeer } from '@test/helpers/WSLNativePeer';
import { hasNativeWSL } from '@test/helpers/WSLNativeTarget';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderExecutionEvent } from '@/core/execution';
import { parseEnvironmentVariables } from '@/core/process/env';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { AntigravityExecutionBackend } from '@/providers/antigravity/execution/AntigravityExecutionBackend';
import { AntigravityConversationHistoryService } from '@/providers/antigravity/history/AntigravityConversationHistoryService';
import { antigravityProviderRegistration } from '@/providers/antigravity/registration';
import { claudeProviderRegistration } from '@/providers/claude/registration';

registerProviderModules([claudeProviderRegistration, antigravityProviderRegistration]);

// CI uses WSL1. The agy peer executes in Linux; no credentials or vendor CLI are needed.
describe.skipIf(!hasNativeWSL())('native Antigravity WSL session and history', () => {
  it.each(['drive', 'distro'] as const)('launches, maps live tools and reads the Linux transcript from a %s vault', { timeout: 90_000 }, async location => {
    const peer = await provisionWSLPeer('antigravity', location, 'tests/helpers/providers/antigravity/AntigravityWSLPeer.ts');
    const key = getInstallationKey();
    const fixture = await createProviderHostFixture({
      settings: { providerConfigs: { antigravity: {
        enabled: true, visibleModels: ['gemini-4-argon'],
        cliPathsByHost: { [key]: peer.cli }, installationMethodsByHost: { [key]: 'wsl' },
        wslDistroOverridesByHost: { [key]: peer.target.distroName! },
        // agy's store follows the Linux HOME, which the session and history both read from the distro.
        environmentVariables: `HOME=${peer.targetHome}`,
      } } },
      overrides: { workingDirectory: peer.vault },
    });
    const host = fixture.host.getRuntimeHost('antigravity');
    const session = new AntigravityExecutionBackend(host).createSession({
      lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: peer.vault,
      interactionPort: { requestApproval: async () => { throw new Error('Unexpected approval'); },
        askUserQuestion: async () => { throw new Error('Unexpected question'); }, dismissInteraction() {} },
    });
    try {
      const text = 'Antigravity WSL round trip: 中文 $HOME # literal';
      const events: ProviderExecutionEvent[] = [];
      for await (const event of session.execute({
        input: [{ type: 'text', text }],
        configuration: { model: 'antigravity/gemini-4-argon', permissionMode: 'normal', reasoning: 'medium',
          systemInstructions: { kind: 'main-agent', instructions: 'Reply to the fixture prompt.' } },
        toolPolicy: { kind: 'provider-default' }, signal: AbortSignal.timeout(40_000),
      }).events) events.push(event);
      expect(events.filter(event => event.type === 'execution_error')).toEqual([]);
      expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
      const reply = events.filter(event => event.type === 'text_delta').map(event => event.text).join('');
      expect(JSON.parse(reply)).toEqual({ platform: 'linux', cwd: peer.targetVault, sessionCwd: peer.targetVault, text, home: peer.targetHome });
      const notes = path.win32.join(peer.vault, 'notes.md');
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool_started', input: expect.objectContaining({ file_path: notes }) }));
      const sessionId = session.getSnapshot().providerSessionId;
      expect(sessionId).toMatch(/^wsl-\d+$/u);
      // Discover from settings and session identity, so a launch-only path check cannot mask history wiring.
      const history = await new AntigravityConversationHistoryService().hydrateConversationHistory({
        sessionId: sessionId ?? null, messages: [],
      }, peer.vault, { config: host.config, environment: { ...process.env, ...parseEnvironmentVariables(host.environmentText) },
        environmentText: host.environmentText, hostPlatform: 'win32', vaultPath: peer.vault });
      expect(history.messages?.filter(message => message.role === 'assistant').map(message => message.content)).toContain(reply);
      expect(history.messages?.flatMap(message => message.toolCalls ?? []))
        .toContainEqual(expect.objectContaining({ input: expect.objectContaining({ file_path: notes }) }));
    } finally {
      await session.dispose();
      await fixture.dispose();
    }
  });
});
