import '@/providers';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { ClaudeExecutionBackend } from '@/providers/claude/execution/ClaudeExecutionBackend';
import { ClaudeSubagentHistoryService } from '@/providers/claude/history/ClaudeSubagentHistoryService';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { codexProviderRegistration } from '@/providers/codex/registration';
import { GrokCommandCatalog } from '@/providers/grok/commands/GrokCommandCatalog';
import { GrokExecutionBackend } from '@/providers/grok/execution/GrokExecutionBackend';
import { grokProviderRegistration } from '@/providers/grok/registration';
import { OpencodeCommandCatalog } from '@/providers/opencode/commands/OpencodeCommandCatalog';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { opencodeProviderRegistration } from '@/providers/opencode/registration';
import { PiCommandCatalog } from '@/providers/pi/commands/PiCommandCatalog';
import { PiExecutionBackend } from '@/providers/pi/execution/PiExecutionBackend';
import { piProviderRegistration } from '@/providers/pi/registration';

function createHost(): any {
  const executionLifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  return {
    app: {
      vault: { adapter: { basePath: '/tmp/provider-registration' } },
    },
    executionLifecycleRegistry,
    getActiveEnvironmentVariables: jest.fn(() => ''),
    getResolvedProviderCliPath: jest.fn(),
    manifest: { version: 'test' },
    runProviderExecutionTransition: (
      providerIds: string[],
      mutation: () => Promise<unknown>,
    ) => executionLifecycleRegistry.runTransition(providerIds as any, mutation),
    settings: {
      providerConfigs: {
        codex: { enabled: true },
        grok: { enabled: true },
        opencode: { enabled: true },
        pi: { enabled: true },
      },
    },
  };
}

describe('provider execution registration', () => {
  afterEach(() => {
    ProviderWorkspaceRegistry.setServices('claude', undefined);
    ProviderWorkspaceRegistry.setServices('codex', undefined);
    ProviderWorkspaceRegistry.setServices('grok', undefined);
    ProviderWorkspaceRegistry.setServices('opencode', undefined);
    ProviderWorkspaceRegistry.setServices('pi', undefined);
  });

  it('exposes exactly one execution factory per provider registration', () => {
    for (const registration of [
      claudeProviderRegistration,
      codexProviderRegistration,
      grokProviderRegistration,
      opencodeProviderRegistration,
      piProviderRegistration,
    ]) {
      expect(registration).toHaveProperty('createExecutionBackend', expect.any(Function));
      expect(
        Object.keys(registration).filter(key => (
          key.startsWith('create') && key.endsWith('Backend')
        )),
      ).toEqual(['createExecutionBackend']);
    }
  });

  it('constructs every registered backend without creating a provider session', () => {
    const host = createHost();
    ProviderWorkspaceRegistry.setServices('claude', {
      agentManager: {},
      commandCatalog: {},
      mcpManager: {},
      pluginManager: {},
    } as any);
    ProviderWorkspaceRegistry.setServices('codex', {} as any);
    ProviderWorkspaceRegistry.setServices('grok', {
      commandCatalog: new GrokCommandCatalog(),
      modelCatalogCoordinator: {},
    } as any);
    ProviderWorkspaceRegistry.setServices('opencode', {
      commandCatalog: new OpencodeCommandCatalog(),
    } as any);
    ProviderWorkspaceRegistry.setServices('pi', {
      commandCatalog: new PiCommandCatalog(),
    } as any);

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

  it('registers Claude transcript recovery without provider parity placeholders', () => {
    const host = createHost();

    expect(ProviderRegistry.createSubagentHistoryService(host, 'claude'))
      .toBeInstanceOf(ClaudeSubagentHistoryService);
    expect(ProviderRegistry.createSubagentHistoryService(host, 'codex')).toBeNull();
    expect(ProviderRegistry.createSubagentHistoryService(host, 'grok')).toBeNull();
    expect(ProviderRegistry.createSubagentHistoryService(host, 'opencode')).toBeNull();
    expect(ProviderRegistry.createSubagentHistoryService(host, 'pi')).toBeNull();
  });
});
