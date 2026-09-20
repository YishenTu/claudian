import '@/providers';

import * as sdkModule from '@anthropic-ai/claude-agent-sdk';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';

const sdkMock = sdkModule as unknown as {
  getLastOptions(): sdkModule.Options | undefined;
  getLastResponse(): { interrupt: jest.Mock } | null;
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

function createContext() {
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const host = {
    app: { vault: { adapter: { basePath: '/vault' } } },
    executionLifecycleRegistry: lifecycleRegistry,
    settings: {
      model: 'claude-sonnet-4-5',
      permissionMode: 'normal',
      effortLevel: 'medium',
      mediaFolder: '',
      systemPrompt: '',
      userName: '',
      loadUserClaudeSettings: false,
    },
    getResolvedProviderCliPath: jest.fn().mockResolvedValue('/bin/claude'),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
  } as unknown as ProviderHost;
  const services = {
    agentManager: { setBuiltinAgentNames: jest.fn() },
  } as unknown as ClaudeWorkspaceServices;
  ProviderWorkspaceRegistry.setServices('claude', services);
  return { host, lifecycleRegistry };
}

describe('Claude auxiliary execution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sdkMock.resetMockMessages();
  });

  it.each(['instruction', 'inline edit'] as const)(
    'keeps %s clarification in one non-persistent query and releases it on reset',
    async (kind) => {
      const context = createContext();
      const service = kind === 'instruction'
        ? ProviderRegistry.createInstructionRefineService(context.host, 'claude')
        : ProviderRegistry.createInlineEditService(context.host, 'claude');
      const start = () => 'refineInstruction' in service
        ? service.refineInstruction('Prefer concise prose', '')
        : service.editText({
          instruction: 'Improve this draft',
          mode: 'selection',
          notePath: 'note.md',
          selectedText: 'Draft',
        });

      try {
        respond('Which tone?');
        await expect(start()).resolves.toMatchObject({
          success: true,
          clarification: 'Which tone?',
        });
        const firstQuery = sdkMock.getLastResponse();
        const firstOptions = sdkMock.getLastOptions();
        expect(firstOptions?.persistSession).toBe(false);
        expect(firstOptions?.resume).toBeUndefined();
        expect(firstOptions?.thinking).toEqual({ type: 'adaptive' });
        expect(firstOptions?.effort).toBe('medium');

        respond(kind === 'instruction'
          ? '<instruction>Use concise formal prose.</instruction>'
          : '<replacement>A concise formal draft.</replacement>');
        await expect(service.continueConversation('Formal')).resolves.toMatchObject(
          kind === 'instruction'
            ? { success: true, refinedInstruction: 'Use concise formal prose.' }
            : { success: true, editedText: 'A concise formal draft.' },
        );
        expect(sdkMock.getLastResponse()).toBe(firstQuery);

        service.resetConversation();
        respond('Which tone for the new request?');
        await expect(start()).resolves.toMatchObject({ success: true });
        expect(firstOptions?.abortController?.signal.aborted).toBe(true);
        expect(sdkMock.getLastResponse()).not.toBe(firstQuery);
        expect(sdkMock.getLastOptions()?.persistSession).toBe(false);
        expect(sdkMock.getLastOptions()?.resume).toBeUndefined();
      } finally {
        service.cancel();
        await context.lifecycleRegistry.dispose();
      }
    },
  );

  it('releases a non-persistent title query after its single response', async () => {
    const context = createContext();
    const service = ProviderRegistry.createTitleGenerationService(context.host, 'claude');
    const callback = jest.fn();
    try {
      respond('A useful title');
      await service.generateTitle('conversation', 'First message', callback);

      expect(callback).toHaveBeenCalledWith('conversation', {
        success: true,
        title: 'A useful title',
      });
      const options = sdkMock.getLastOptions();
      expect(options?.persistSession).toBe(false);
      expect(options?.thinking).toBeUndefined();
      expect(options?.effort).toBeUndefined();
      expect(options?.abortController?.signal.aborted).toBe(true);
    } finally {
      service.cancel();
      await context.lifecycleRegistry.dispose();
    }
  });
});
