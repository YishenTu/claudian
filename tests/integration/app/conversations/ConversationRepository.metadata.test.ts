import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { testDate } from '@test/helpers/testClock';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import type { Conversation, SessionMetadata, SubagentInfo, UsageInfo } from '@/core/types';
import { claudeProviderRegistration } from '@/providers/claude/registration';

registerProviderModules([claudeProviderRegistration]);

const DEVICE_KEY = `device-${'a'.repeat(64)}`;
let vault: DesktopVault;
let store: ConversationPersistenceStore;
let repository: ConversationRepository;
beforeEach(async () => {
  vault = await DesktopVault.create();
  store = new ConversationPersistenceStore(vault.files, DEVICE_KEY);
  repository = new ConversationRepository({
    providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => ({}), getVaultPath: () => vault.root,
    persistence: store, onConversationDeleted: async () => undefined,
  });
});
afterEach(async () => { vi.restoreAllMocks(); await vault.dispose(); });

async function persistMetadata(conversation: Conversation): Promise<SessionMetadata> {
  repository.replaceAll([conversation]);
  const snapshot = repository.getSync(conversation.id)!;
  await repository.persistConversations([snapshot]);
  expect(repository.getSync(conversation.id)).toEqual(snapshot);
  const metadata = await store.metadataReader.loadMetadata(conversation.id);
  expect(metadata).not.toBeNull();
  return metadata!;
}

  describe('public metadata persistence - subagents', () => {
    it('extracts subagent data from Agent toolCalls', async () => {
      const conversation: Conversation = {
        id: 'conv-subagent',
        providerId: 'claude',
        title: 'Subagent Test',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 1000 }).getTime(),
        sessionId: 'sdk-session',
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: testDate({ milliseconds: 100 }).getTime() },
          {
            id: 'msg-2',
            role: 'assistant',
            content: 'Working...',
            timestamp: testDate({ milliseconds: 200 }).getTime(),
            toolCalls: [
              {
                id: 'task-1',
                name: 'Agent',
                input: { description: 'Test subagent' },
                status: 'completed',
                result: 'Done',
                subagent: {
                  id: 'task-1',
                  description: 'Test subagent',
                  isExpanded: false,
                  status: 'completed' as const,
                  toolCalls: [],
                  result: 'Done',
                },
              },
            ],
          },
        ],
      };

      const metadata = (await persistMetadata(conversation));

      expect((metadata.providerState)?.subagentData).toBeDefined();
      expect((metadata.providerState?.subagentData as Record<string, unknown> | undefined)?.['task-1']).toEqual(expect.objectContaining({
        id: 'task-1',
        description: 'Test subagent',
        status: 'completed',
      }));
    });

    it.each(['sync', 'async'] as const)('omits base64 images from persisted %s subagent results without changing live results', async mode => {
      const now = testDate().getTime();
      const imageData = 'a'.repeat(512 * 1024);
      const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } };
      const text = { type: 'text', text: 'Archive scan transcription' };
      const imageResult = JSON.stringify([text, image]);
      const nested: SubagentInfo = {
        id: 'nested', description: 'Nested reader', status: 'completed', isExpanded: false,
        result: JSON.stringify([image]),
        toolCalls: [{ id: 'read-nested', name: 'Read', input: { file_path: '/scan.png' }, status: 'completed', result: imageResult }],
      };
      const subagent: SubagentInfo = {
        id: 'task-images', description: 'Read scans', status: 'completed', isExpanded: false, mode,
        toolCalls: [
          { id: 'read', name: 'Read', input: { file_path: '/scan.png' }, status: 'completed', result: imageResult },
          { id: 'text', name: 'Read', input: {}, status: 'completed', result: 'plain text mentioning "base64"' },
          { id: 'json', name: 'Read', input: {}, status: 'completed', result: '[ {"type":"text","text":"base64"} ]' },
          { id: 'nested', name: 'Agent', input: {}, status: 'completed', result: 'Done', subagent: nested },
        ],
      };
      const conversation: Conversation = {
        id: 'images', providerId: 'claude', title: 'Scans', createdAt: now, lastActivityAt: now, sessionId: 'native',
        messages: [{ id: 'msg', role: 'assistant', content: '', timestamp: now,
          toolCalls: [{ id: subagent.id, name: 'Agent', input: {}, status: 'completed', subagent }],
        }],
      };

      const metadata = (await persistMetadata(conversation));
      const persisted = (metadata.providerState?.subagentData as Record<string, SubagentInfo>)[subagent.id];
      const strippedImage = { ...image, source: { ...image.source, data: '' } };

      expect(JSON.stringify(metadata).includes(imageData)).toBe(false);
      expect(JSON.parse(persisted.toolCalls[0].result!)).toEqual([text, strippedImage]);
      expect(persisted.toolCalls[0].input).toEqual({ file_path: '/scan.png' });
      expect(persisted.toolCalls[1].result).toBe(subagent.toolCalls[1].result);
      expect(persisted.toolCalls[2].result).toBe(subagent.toolCalls[2].result);
      expect(JSON.parse(persisted.toolCalls[3].subagent!.result!)).toEqual([strippedImage]);
      expect(JSON.parse(persisted.toolCalls[3].subagent!.toolCalls[0].result!)).toEqual([text, strippedImage]);
    });

    it('returns undefined subagentData when no subagents present', async () => {
      const conversation: Conversation = {
        id: 'conv-no-subagent',
        providerId: 'claude',
        title: 'No Subagent',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 1000 }).getTime(),
        sessionId: null,
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: testDate({ milliseconds: 100 }).getTime() },
          { id: 'msg-2', role: 'assistant', content: 'Hi!', timestamp: testDate({ milliseconds: 200 }).getTime() },
        ],
      };

      const metadata = (await persistMetadata(conversation));

      expect((metadata.providerState)?.subagentData).toBeUndefined();
    });

    it('ignores Agent toolCalls without linked subagent', async () => {
      const conversation: Conversation = {
        id: 'conv-task-subagent',
        providerId: 'claude',
        title: 'Task Subagent Test',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 1000 }).getTime(),
        sessionId: 'sdk-session',
        messages: [
          {
            id: 'msg-1',
            role: 'assistant',
            content: '',
            timestamp: testDate({ milliseconds: 200 }).getTime(),
            toolCalls: [
              {
                id: 'task-1',
                name: 'Agent',
                input: { description: 'Background task', run_in_background: true },
                status: 'completed',
                result: 'Task running',
              },
            ],
          },
        ],
      };

      const metadata = (await persistMetadata(conversation));

      expect((metadata.providerState)?.subagentData).toBeUndefined();
    });
  });

  describe('public metadata persistence - rewind', () => {
    it('includes resumeAtMessageId when set', async () => {
      const conversation: Conversation = {
        id: 'conv-rewind',
        providerId: 'claude',
        title: 'Rewind Test',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 1000 }).getTime(),
        sessionId: 'sdk-session',
        messages: [],
        resumeAtMessageId: 'assistant-uuid-123',
      };

      const metadata = (await persistMetadata(conversation));

      expect(metadata.resumeAtMessageId).toBe('assistant-uuid-123');
    });

    it('omits resumeAtMessageId when not set', async () => {
      const conversation: Conversation = {
        id: 'conv-no-rewind',
        providerId: 'claude',
        title: 'No Rewind',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 1000 }).getTime(),
        sessionId: null,
        messages: [],
      };

      const metadata = (await persistMetadata(conversation));

      expect(metadata.resumeAtMessageId).toBeUndefined();
    });
  });

  describe('public metadata persistence - projections', () => {
    it('does not fall back to unsanitized state when the provider rejects it', async () => {
      const service = ProviderRegistry.getConversationHistoryService('claude');
      const sanitizer = vi.spyOn(service, 'buildPersistedProviderState').mockReturnValue(undefined);
      const conversation: Conversation = {
        id: 'conv-rejected-provider-state',
        providerId: 'claude',
        title: 'Rejected state',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate().getTime(),
        sessionId: null,
        messages: [],
        providerState: { untrustedPath: '/outside/root/session.jsonl' },
      };

      expect((await persistMetadata(conversation)).providerState).toBeUndefined();
      sanitizer.mockRestore();
    });

    it('converts Conversation to SessionMetadata', async () => {
      const usage: UsageInfo = {
        model: 'claude-opus-4-5',
        inputTokens: 5000,
        cacheCreationInputTokens: 1000,
        cacheReadInputTokens: 500,
        contextWindow: 200000,
        contextTokens: 6500,
        percentage: 3,
      };

      const conversation: Conversation = {
        id: 'conv-convert',
        providerId: 'claude',
        title: 'Convert Test',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 900 }).getTime(),
        sessionId: 'sdk-session',
        providerState: { providerSessionId: 'current-sdk-session' },
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: testDate({ milliseconds: 100 }).getTime() },
        ],
        linkedContentPath: 'notes/test.md',
        usage,
        titleGenerationStatus: 'success',
      };

      const metadata = (await persistMetadata(conversation));

      expect(metadata.id).toBe('conv-convert');
      expect(metadata.title).toBe('Convert Test');
      expect(metadata.createdAt).toBe(testDate().getTime());
      expect(metadata.lastActivityAt).toBe(testDate({ milliseconds: 900 }).getTime());
      expect(metadata.sessionId).toBe('sdk-session');
      expect((metadata.providerState)?.providerSessionId).toBe('current-sdk-session');
      expect(metadata.linkedContentPath).toBe('notes/test.md');
      expect(metadata.usage).toEqual(usage);
      expect(metadata.titleGenerationStatus).toBe('success');

      // Should not include messages
      expect(metadata).not.toHaveProperty('messages');
    });

    it('includes forkSource when set', async () => {
      const conversation: Conversation = {
        id: 'conv-fork',
        providerId: 'claude',
        title: 'Fork Test',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 1000 }).getTime(),
        sessionId: null,
        messages: [],
        providerState: { forkSource: { sessionId: 'source-session-abc', resumeAt: 'asst-uuid-xyz' } },
      };

      const metadata = (await persistMetadata(conversation));

      expect((metadata.providerState)?.forkSource).toEqual({
        sessionId: 'source-session-abc',
        resumeAt: 'asst-uuid-xyz',
      });
    });

    it('omits forkSource when not set', async () => {
      const conversation: Conversation = {
        id: 'conv-no-fork',
        providerId: 'claude',
        title: 'No Fork',
        createdAt: testDate().getTime(),
        lastActivityAt: testDate({ milliseconds: 1000 }).getTime(),
        sessionId: 'sdk-session',
        messages: [],
      };

      const metadata = (await persistMetadata(conversation));

      expect((metadata.providerState)?.forkSource).toBeUndefined();
    });
  });
