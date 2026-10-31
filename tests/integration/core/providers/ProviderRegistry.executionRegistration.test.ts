import '@/providers';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { ClaudeExecutionBackend } from '@/providers/claude/execution/ClaudeExecutionBackend';
import { ClaudeSubagentHistoryService } from '@/providers/claude/history/ClaudeSubagentHistoryService';
import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { GrokExecutionBackend } from '@/providers/grok/execution/GrokExecutionBackend';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { PiExecutionBackend } from '@/providers/pi/execution/PiExecutionBackend';

async function createHost() {
  return (await createProviderHostFixture({ settings: {
    providerConfigs: { codex: { enabled: true }, grok: { enabled: true }, opencode: { enabled: true }, pi: { enabled: true } },
  } })).host;
}

describe('provider execution registration', () => {
  afterEach(async () => { await ProviderWorkspaceRegistry.disposeInitialized(); });

  it('constructs every registered backend over its real initialized workspace services', async () => {
    const host = await createHost();
    for (const id of ['codex', 'grok', 'opencode', 'pi'] as const) {
      await ProviderWorkspaceRegistry.ensureInitialized(host, id, 'registration-test');
    }

    expect(ProviderRegistry.createExecutionBackend(host, 'claude'))
      .toBeInstanceOf(ClaudeExecutionBackend);
    expect(ProviderRegistry.createExecutionBackend(host, 'codex'))
      .toBeInstanceOf(CodexExecutionBackend);
    expect(ProviderRegistry.createExecutionBackend(host, 'grok'))
      .toBeInstanceOf(GrokExecutionBackend);
    expect(ProviderRegistry.createExecutionBackend(host, 'opencode'))
      .toBeInstanceOf(OpencodeExecutionBackend);
    expect(ProviderRegistry.createExecutionBackend(host, 'pi'))
      .toBeInstanceOf(PiExecutionBackend);
  });

  it('registers Claude transcript recovery without provider parity placeholders', async () => {
    const host = await createHost();

    expect(ProviderRegistry.createSubagentHistoryService(host, 'claude'))
      .toBeInstanceOf(ClaudeSubagentHistoryService);
    expect(ProviderRegistry.createSubagentHistoryService(host, 'codex')).toBeNull();
    expect(ProviderRegistry.createSubagentHistoryService(host, 'grok')).toBeNull();
    expect(ProviderRegistry.createSubagentHistoryService(host, 'opencode')).toBeNull();
    expect(ProviderRegistry.createSubagentHistoryService(host, 'pi')).toBeNull();
  });
});
