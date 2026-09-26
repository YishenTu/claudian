import '@/providers';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { App } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ConversationPersistenceStore } from '@/core/bootstrap/ConversationPersistenceStore';
import { type ProviderExecutionBackend, ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { ChatMessage, Conversation, ProviderId } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { handleForkRequest } from '@/features/chat/tabs/TabForking';
import type { AssembledTabRuntime } from '@/features/chat/tabs/types';
import { updateCurrentGrokCatalog } from '@/providers/grok/settings';

/** Real persistence/orchestration with only the Obsidian filesystem boundary supplied by the test. */
export async function createForkTestEnvironment() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-fork-integration-'));
  const app = new App();
  app.vault.adapter = {
    basePath: root,
    exists: async (file: string) => fs.access(path.join(root, file)).then(() => true, () => false),
    read: (file: string) => fs.readFile(path.join(root, file), 'utf8'),
    write: (file: string, data: string) => fs.writeFile(path.join(root, file), data),
    mkdir: (file: string) => fs.mkdir(path.join(root, file), { recursive: true }),
    remove: (file: string) => fs.rm(path.join(root, file), { force: true }),
    list: async () => ({ files: [], folders: [] }),
  } as unknown as App['vault']['adapter'];
  const adapter = new VaultFileAdapter(app);
  const settings = {
    model: 'claude-sonnet-4-5', permissionMode: 'ask', mediaFolder: 'media',
    providerConfigs: {
      claude: claudeCatalogFixture(['claude-sonnet-4-5']),
      pi: { enabled: true, visibleModels: ['pi:anthropic/claude-sonnet-4'], discoveredModels: [{
        encodedId: 'pi:anthropic/claude-sonnet-4', id: 'claude-sonnet-4', provider: 'anthropic', label: 'Sonnet', input: ['text'],
      }] },
      codex: { enabled: true, visibleModels: ['gpt-5'], discoveredModels: [{ model: 'gpt-5', displayName: 'GPT-5', description: '', supportedReasoningEfforts: [{ value: 'medium', description: '' }], defaultReasoningEffort: 'medium', inputModalities: ['text'], isDefault: true }] }, grok: { enabled: true, visibleModels: ['grok-code-fast-1'], environmentVariables: `GROK_HOME=${path.join(root, 'grok')}` },
    },
  };
  updateCurrentGrokCatalog(settings, { fingerprint: 'test', refreshedAt: 1, defaultModelId: 'grok-code-fast-1', models: [{ rawId: 'grok-code-fast-1', displayName: 'Grok', supportsReasoning: false, reasoningEfforts: [] }] });
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const host = {
    app, settings, executionLifecycleRegistry: lifecycleRegistry,
    storage: {},
    getResolvedProviderCliPath: async (providerId: string) => `/bin/${providerId}`,
    getActiveEnvironmentVariables: () => `CLAUDE_CONFIG_DIR=${path.join(root, 'claude')}`,
  } as unknown as ProviderHost;
  const repository = new ConversationRepository({
    getSettings: () => settings,
    getVaultPath: () => root,
    persistence: new ConversationPersistenceStore(adapter, `device-${'a'.repeat(64)}`),
    onConversationDeleted: async () => undefined,
  });
  const plugin = {
    app, settings,
    getConversationSummary(id: string) { return (this as unknown as { getConversationSync: (id: string) => any }).getConversationSync(id); },
    getConversationSync: (id: string) => repository.getSync(id),
  } as unknown as ChatFeatureHost;
  const coordinators: ChatExecutionCoordinator[] = [];
  let sequence = 0;

  async function open(backend: ProviderExecutionBackend, conversation?: Conversation) {
    const current = conversation ?? await repository.create({ providerId: backend.providerId });
    const coordinator = new ChatExecutionCoordinator({
      lifecycleRegistry,
      resolveBackend: () => backend,
      persistence: repository,
      interactionPort: {
        askUserQuestion: async () => { throw new Error('Unexpected question'); },
        requestApproval: async () => { throw new Error('Unexpected approval'); },
        dismissInteraction: () => undefined,
      },
      vaultWorkingDirectory: root,
      createId: () => `execution-${++sequence}`,
      resolveMissingProviderSession: async () => 'preserved',
    });
    coordinators.push(coordinator);
    await coordinator.bindConversation({
      conversationId: current.id, providerId: current.providerId,
      resumeSeed: { providerSessionId: current.sessionId ?? undefined, providerState: current.providerState },
    });
    return { conversation: current, coordinator };
  }

  async function send(chat: Awaited<ReturnType<typeof open>>, text: string, expectedStatus = 'completed') {
    const user: ChatMessage = { id: `user-${++sequence}`, role: 'user', content: text, timestamp: sequence };
    const assistant: ChatMessage = { id: `assistant-${++sequence}`, role: 'assistant', content: '', timestamp: sequence };
    const history = [...chat.conversation.messages];
    chat.conversation.messages.push(user, assistant);
    const result = await chat.coordinator.execute({
      submissionId: user.id,
      timestamp: user.timestamp, rawDisplayText: text, canonicalText: text, images: [],
      conversationHistory: history, messages: { user, assistant },
      configuration: { model: { claude: 'claude-sonnet-4-5', codex: 'gpt-5', grok: 'grok/grok-code-fast-1', pi: 'pi:anthropic/claude-sonnet-4', opencode: 'opencode:test/model' }[chat.conversation.providerId], permissionMode: 'normal', systemInstructions: { kind: 'explicit', instructions: 'Answer the user.' } },
      toolPolicy: { kind: 'provider-default' },
    }).catch(error => { throw new Error(JSON.stringify(error.cause ?? error), { cause: error }); });
    if (result.status !== expectedStatus) throw new Error(JSON.stringify(result));
    await repository.update(chat.conversation.id, { messages: chat.conversation.messages });
    Object.assign(chat.conversation, repository.getSync(chat.conversation.id)!, { messages: chat.conversation.messages });
    return assistant;
  }

  async function fork(chat: Awaited<ReturnType<typeof open>>, message: ChatMessage) {
    let child: Conversation | undefined;
    const tab = {
      conversationId: chat.conversation.id, providerId: chat.conversation.providerId,
      executionCoordinator: chat.coordinator,
      state: { messages: chat.conversation.messages, isStreaming: false, isRewinding: false },
    } as unknown as AssembledTabRuntime;
    await handleForkRequest(tab, plugin, message.id, async context => {
      const providerId = context.providerId as ProviderId;
      // The fork callback's public provider/repository seams are shared with TabManager.
      const providerState = await ProviderRegistry.getConversationHistoryService(providerId)
        .buildForkProviderState(context.sourceSessionId, context.resumeAt, context.sourceProviderState, root);
      child = await repository.create({ providerId });
      await repository.update(child.id, { messages: context.messages, providerState });
      child = repository.getSync(child.id)!;
    }, () => true);
    return child;
  }

  return {
    root, app, adapter, host, repository, open, send, fork,
    async dispose() {
      await Promise.all(coordinators.map(coordinator => coordinator.dispose()));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export type ForkTestEnvironment = Awaited<ReturnType<typeof createForkTestEnvironment>>;
