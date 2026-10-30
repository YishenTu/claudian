import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';
import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import type { Mock } from 'vitest';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { updateClaudeProviderSettings } from '@/providers/claude/settings';



let vault: DesktopVault;
beforeAll(async () => { vault = await DesktopVault.create(); });
afterAll(async () => { await vault.dispose(); });

const sdkMock = sdkModule as unknown as {
  getLastOptions(): sdkModule.Options | undefined;
  getLastResponse(): { interrupt: Mock } | null;
  resetMockMessages(): void;
  setMockMessages(messages: unknown[]): void;
};

function respond(text: string): void {
  sdkMock.setMockMessages([
    { type: 'system', subtype: 'init', session_id: 'auxiliary-session' },
    { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success' },
  ]);
}

async function createContext() {
  const fixture = await createProviderHostFixture({ vault,
    beforePersist: () => { throw new Error('Unexpected write in a read-only host fixture'); },
    settings: {
      providerConfigs: { claude: claudeCatalogFixture(
        ['claude-sonnet-4-5', 'claude-opus-4-6', 'claude-haiku-4-5', 'custom-model', 'custom-model-a', 'custom-model-b'],
        ['low', 'medium', 'high'],
      ) },
      model: 'claude-sonnet-4-5',
      titleGenerationModel: 'claude-haiku-4-5',
      permissionMode: 'normal',
      effortLevel: 'medium',
      mediaFolder: '',
      systemPrompt: '',
      userName: '',
    },
    overrides: { workingDirectory: '/vault', getResolvedProviderCliPath: async () => '/bin/claude' },
  });
  return { host: fixture.host, lifecycleRegistry: fixture.lifecycle };
}

describe('Claude auxiliary execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.resetMockMessages();
  });

  it(
    'keeps inline edit clarification in one non-persistent query and releases it on reset',
    async () => {
      const context = await createContext();
      updateClaudeProviderSettings(context.host.settings, { promptSuggestions: true });
      const service = ProviderRegistry.createInlineEditService(context.host, 'claude');
      const send = (instruction: string) => service.send({
        instruction,
        mode: 'selection',
        notePath: 'note.md',
        selectedText: 'Draft',
      });
      const start = () => send('Improve this draft');

      try {
        respond('Which tone?');
        await expect(start()).resolves.toMatchObject({
          success: true,
          clarification: 'Which tone?',
        });
        const firstQuery = sdkMock.getLastResponse();
        const firstOptions = sdkMock.getLastOptions();
        expect(firstOptions?.persistSession).toBe(false);
        expect(firstOptions).not.toHaveProperty('promptSuggestions');
        expect(firstOptions?.resume).toBeUndefined();
        expect(firstOptions?.thinking).toEqual({ type: 'adaptive' });
        expect(firstOptions?.effort).toBe('medium');

        respond('<replacement>A concise formal draft.</replacement>');
        await expect(send('Formal')).resolves.toMatchObject({
          success: true, editedText: 'A concise formal draft.',
        });
        expect(sdkMock.getLastResponse()).toBe(firstQuery);

        service.end();
        respond('Which tone for the new request?');
        await expect(start()).resolves.toMatchObject({ success: true });
        expect(firstOptions?.abortController?.signal.aborted).toBe(true);
        expect(sdkMock.getLastResponse()).not.toBe(firstQuery);
        expect(sdkMock.getLastOptions()?.persistSession).toBe(false);
        expect(sdkMock.getLastOptions()?.resume).toBeUndefined();
      } finally {
        service.end();
        await context.lifecycleRegistry.dispose();
      }
    },
  );

  it('releases a non-persistent title query after its single response', async () => {
    const context = await createContext();
    updateClaudeProviderSettings(context.host.settings, { promptSuggestions: true });
    ProviderWorkspaceRegistry.setServices('claude', {});
    const service = ProviderRegistry.createTitleGenerationService(context.host);
    const callback = vi.fn();
    try {
      respond('A useful title');
      await service.generateTitle('conversation', 'First message', callback);

      expect(callback).toHaveBeenCalledWith('conversation', {
        success: true,
        title: 'A useful title',
      });
      const options = sdkMock.getLastOptions();
      expect(options?.persistSession).toBe(false);
      expect(options).not.toHaveProperty('promptSuggestions');
      expect(options?.thinking).toBeUndefined();
      expect(options?.effort).toBeUndefined();
      expect(options?.abortController?.signal.aborted).toBe(true);
    } finally {
      service.cancel();
      await context.lifecycleRegistry.dispose();
      ProviderWorkspaceRegistry.clear();
    }
  });
});
