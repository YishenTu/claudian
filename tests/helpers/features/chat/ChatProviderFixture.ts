import { FakeSession } from '@test/helpers/ChatExecutionHarness';

import type { ProviderExecutionBackend, ProviderSessionConfig } from '@/core/execution';
import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ProviderCapabilities, ProviderChatUIConfig, ProviderCommandLoader, ProviderConversationHistoryService, ProviderId, ProviderModelPolicy, ProviderUIOption, ProviderWorkspaceRegistration, ProviderWorkspaceServices } from '@/core/providers/types';
import { BUILT_IN_PROVIDER_MODULES } from '@/providers';

export interface ChatTestProviderOptions {
  models?: readonly ProviderUIOption[];
  capabilities?: Partial<ProviderCapabilities>;
  modelPolicy?: Partial<ProviderModelPolicy>;
  chatUIConfig?: Partial<ProviderChatUIConfig>;
  historyService?: Partial<ProviderConversationHistoryService>;
  workspace?: ProviderWorkspaceServices;
  initialize?: ProviderWorkspaceRegistration['initialize'];
}

/** Real registries and provider policies; only provider replies/catalog inputs cross a controlled boundary. */
export function registerChatTestProvider(providerId: ProviderId, options: ChatTestProviderOptions = {}) {
  const base = BUILT_IN_PROVIDER_MODULES.find(provider => provider.id === providerId)!;
  const sessions: FakeSession[] = [];
  const createSession = vi.fn((config: ProviderSessionConfig) => {
    const session = new FakeSession(providerId, `${providerId}-session-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  const backend: ProviderExecutionBackend = { providerId, createSession };
  const models = options.models;
  const modelPolicy: ProviderModelPolicy = {
    ...base.modelPolicy,
    ...(models ? {
      getModelOptions: () => [...models],
      getDefaultModel: () => models[0]?.value ?? null,
      ownsModel: (model: string) => models.some(option => option.value === model),
      normalizeModelVariant: (model: string) => model,
    } : {}),
    ...options.modelPolicy,
  };
  const history = {
    ...base.historyService,
    buildForkProviderState: vi.fn<ProviderConversationHistoryService['buildForkProviderState']>(() => ({ fork: true })),
    hydrateConversationHistory: vi.fn<ProviderConversationHistoryService['hydrateConversationHistory']>(async () => {
      throw new Error('Supply native history hydration for this test.');
    }),
    resolveSessionIdForConversation: base.historyService.resolveSessionIdForConversation.bind(base.historyService),
    isPendingForkConversation: base.historyService.isPendingForkConversation.bind(base.historyService),
    ...options.historyService,
  } satisfies ProviderConversationHistoryService;
  const catalog = new RuntimeCommandCatalog({
    dropdownConfig: { providerId, triggerChars: ['/'], builtInPrefix: '/', skillPrefix: '/', commandPrefix: '/' },
    projectEntry: command => ({
      ...command, providerId, kind: 'command', scope: 'runtime', source: 'sdk',
      isEditable: false, isDeletable: false, displayPrefix: '/', insertPrefix: '/',
    }),
  });
  const loadCommands = vi.fn<ProviderCommandLoader['loadCommands']>(async () => ({
    status: 'ready', items: [{ id: 'review', name: 'review', description: 'Review changes', content: '', source: 'sdk' }],
  }));
  const commandLoader: ProviderCommandLoader = {
    getCacheFingerprint: () => 'commands-v1',
    isAvailable: () => true,
    loadCommands,
  };
  const workspace: ProviderWorkspaceServices = { commandCatalog: catalog, commandLoader, ...options.workspace };
  const initialize = vi.fn<ProviderWorkspaceRegistration['initialize']>(options.initialize ?? (async () => workspace));
  ProviderRegistry.register(providerId, {
    ...base,
    modelPolicy,
    chatUIConfig: { ...base.chatUIConfig, ...modelPolicy, ...options.chatUIConfig },
    capabilities: { ...base.capabilities, ...options.capabilities },
    createExecutionBackend: () => backend,
    createSubagentHistoryService: undefined,
    historyService: history,
  });
  ProviderWorkspaceRegistry.register(providerId, { initialize });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    // Registries have no per-provider removal; restore the built-ins after releasing test workspaces.
    await ProviderWorkspaceRegistry.disposeInitialized();
    ProviderWorkspaceRegistry.clear();
    for (const registration of BUILT_IN_PROVIDER_MODULES) {
      ProviderRegistry.register(registration.id, registration);
      ProviderWorkspaceRegistry.register(registration.id, registration.workspace);
    }
  };
  onTestFinished(dispose);
  return { backend, sessions, createSession, history, catalog, commandLoader, loadCommands, workspace, initialize, dispose };
}
