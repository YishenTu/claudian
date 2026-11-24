import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';

import { registerProviderModules } from '@/core/providers/registerProviderModules';
import { buildChatExecutionConfiguration } from '@/features/chat/execution/chatExecutionConfiguration';
import { getSessionSettingsSnapshot, updateSessionProviderSettings } from '@/features/chat/sessions/sessionSettings';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { codexProviderRegistration } from '@/providers/codex/registration';
import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { codexChatUIConfig } from '@/providers/codex/ui/CodexChatUIConfig';

registerProviderModules([claudeProviderRegistration, codexProviderRegistration]);

const mockNative = new CodexRuntimeHarness();
vi.mock('cross-spawn', () => ({ default: vi.fn(() => mockNative.createProcess()) }));

const ULTRAFAST_ONLY_NO_DEFAULT = 'gpt-6.2-ultrafast-only';
const ULTRAFAST_ONLY_WITH_DEFAULT = 'gpt-6.2-ultrafast-default';
const FAST_MODEL = TEST_CODEX_MODEL;

let sharedVault: DesktopVault;

beforeAll(async () => {
  sharedVault = await DesktopVault.create();
});

afterAll(async () => {
  await sharedVault.dispose();
});

async function createCodexFixture(savedServiceTier: string, initialModel: string) {
  mockNative.reset();
  mockNative.autoReconcile = true;
  const baseFastModel = TEST_CODEX_CATALOG.find(model => model.model === FAST_MODEL)!;
  const discoveredModels = [
    {
      ...baseFastModel,
      model: ULTRAFAST_ONLY_NO_DEFAULT,
      displayName: 'GPT-6.2 Ultrafast Only',
      serviceTiers: [{ id: 'ultrafast', name: 'Ultrafast', description: 'Lowest latency' }],
      defaultServiceTier: null,
    },
    {
      ...baseFastModel,
      model: ULTRAFAST_ONLY_WITH_DEFAULT,
      displayName: 'GPT-6.2 Ultrafast Default',
      serviceTiers: [{ id: 'ultrafast', name: 'Ultrafast', description: 'Lowest latency' }],
      defaultServiceTier: 'ultrafast',
    },
    ...TEST_CODEX_CATALOG,
  ];

  const codexConfig = {
    enabled: true,
    discoveredModels,
    environmentVariables: `HOME=${sharedVault.root}\nUSERPROFILE=${sharedVault.root}`,
  };
  const sharedSettings = {
    settingsProvider: 'codex' as const,
    model: `openai-codex/${initialModel}`,
    effortLevel: 'high',
    permissionMode: 'yolo',
    serviceTier: savedServiceTier,
    savedProviderModel: { codex: `openai-codex/${initialModel}` },
    savedProviderEffort: { codex: 'high' },
    savedProviderPermissionMode: { codex: 'yolo' },
    savedProviderServiceTier: { codex: savedServiceTier },
    providerConfigs: { codex: codexConfig },
  };

  const chatHost = await createChatFeatureHost({ settings: sharedSettings });
  const providerFixture = await createProviderHostFixture({
    vault: sharedVault,
    overrides: { getResolvedProviderCliPath: async () => '/native/codex' },
    settings: sharedSettings,
  });
  const runtimeHost = providerFixture.host.getRuntimeHost('codex');
  const codexRuntime = new CodexAppServerRuntime(runtimeHost, () => undefined);
  const backend = new CodexExecutionBackend(runtimeHost, () => codexRuntime);

  const tab = {
    conversationId: null,
    providerId: 'codex' as const,
    draftModel: `openai-codex/${initialModel}` as string | null,
    identityRevision: 1,
    admitsConversationOperations: true,
    reasoningSelections: new Map<string, string>(),
    providerSelections: new Map<string, { permissionMode: string; serviceTier: string }>(),
  };

  let turnCount = 0;
  const submitTurn = async (targetTab = tab) => {
    const snapshot = getSessionSettingsSnapshot(targetTab, chatHost);
    const session = backend.createSession({
      lifecycle: 'ephemeral',
      nativePersistence: 'disabled-if-supported',
      workingDirectory: '/vault',
      interactionPort: { requestApproval: vi.fn(), askUserQuestion: vi.fn(), dismissInteraction: vi.fn() },
    });
    try {
      const run = session.execute({
        input: [{ type: 'text', text: 'ping' }],
        configuration: buildChatExecutionConfiguration(snapshot, {
          kind: 'explicit',
          purpose: 'title',
          instructions: 'Be concise.',
        }),
        toolPolicy: { kind: 'provider-default' },
        signal: new AbortController().signal,
      });
      const events = (async () => {
        const collected: unknown[] = [];
        for await (const event of run.events) collected.push(event);
        return collected;
      })();
      const process = await mockNative.waitForRequest('turn/start', 0, ++turnCount);
      const turnStart = process.requests.filter(rpc => rpc.method === 'turn/start')[turnCount - 1]!;
      const threadId = String(turnStart.params?.threadId ?? 'thread-1');
      process.notify('turn/completed', {
        threadId,
        turn: { ...process.turns.get(threadId), status: 'completed' },
      });
      await events;
      return {
        snapshot,
        wireServiceTier: turnStart.params?.serviceTier,
      };
    } finally {
      await session.dispose();
    }
  };

  const dispose = async () => {
    await codexRuntime.dispose();
  };

  return { chatHost, tab, submitTurn, dispose };
}

describe('Codex session service-tier initialization and wire resolution', () => {
  it('seeds a fresh tab from the saved provider preference so switching models does not lose it', async () => {
    const fixture = await createCodexFixture('priority', ULTRAFAST_ONLY_WITH_DEFAULT);
    try {
      // Fresh tab (empty providerSelections) opens on an Ultrafast-default model.
      const onUltrafastModel = await fixture.submitTurn();
      expect(codexChatUIConfig.getServiceTierToggle!(onUltrafastModel.snapshot)?.selection).toMatchObject({
        kind: 'accelerated',
        option: { value: 'ultrafast' },
      });
      expect(onUltrafastModel.wireServiceTier).toBe('ultrafast');

      // Switching to a Fast-capable model (no catalog default) still uses saved Fast ('priority').
      fixture.tab.draftModel = `openai-codex/${FAST_MODEL}`;
      const onFastModel = await fixture.submitTurn();
      expect(codexChatUIConfig.getServiceTierToggle!(onFastModel.snapshot)?.selection).toMatchObject({
        kind: 'accelerated',
        option: { value: 'priority' },
      });
      expect(onFastModel.wireServiceTier).toBe('priority');
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps an unsupported tier selection unset on the wire rather than turning it into explicit Standard', async () => {
    const fastSelection = await createCodexFixture('priority', FAST_MODEL);
    try {
      // Initialize on Fast-capable model, then switch to Ultrafast-only model with no default.
      expect(codexChatUIConfig.getServiceTierToggle!(getSessionSettingsSnapshot(fastSelection.tab, fastSelection.chatHost))?.selection)
        .toMatchObject({ kind: 'accelerated', option: { value: 'priority' } });

      fastSelection.tab.draftModel = `openai-codex/${ULTRAFAST_ONLY_NO_DEFAULT}`;
      const afterSwitch = await fastSelection.submitTurn();
      expect(codexChatUIConfig.getServiceTierToggle!(afterSwitch.snapshot)?.selection).toMatchObject({
        kind: 'standard',
      });
      expect(afterSwitch.wireServiceTier).toBeNull();

      // Explicitly choosing Standard persists 'default' even when the model already displays Standard,
      // so a fresh tab on the same model sends explicit 'default' on the wire.
      await updateSessionProviderSettings(fastSelection.tab, fastSelection.chatHost, settings => {
        settings.serviceTier = 'default';
      });
      expect(fastSelection.chatHost.settings.savedProviderServiceTier.codex).toBe('default');
      const freshTab = {
        conversationId: null,
        providerId: 'codex' as const,
        draftModel: `openai-codex/${ULTRAFAST_ONLY_NO_DEFAULT}` as string | null,
        identityRevision: 1,
        admitsConversationOperations: true,
        reasoningSelections: new Map<string, string>(),
        providerSelections: new Map<string, { permissionMode: string; serviceTier: string }>(),
      };
      const freshResult = await fastSelection.submitTurn(freshTab);
      expect(freshResult.wireServiceTier).toBe('default');
    } finally {
      await fastSelection.dispose();
    }
  });

  it('drops stale saved service tiers on fresh sessions for providers without a service-tier policy', async () => {
    const host = await createChatFeatureHost({
      settings: {
        settingsProvider: 'claude',
        model: '',
        effortLevel: 'high',
        serviceTier: 'priority',
        savedProviderModel: {},
        savedProviderEffort: { claude: 'high' },
        savedProviderServiceTier: { claude: 'priority' },
        providerConfigs: {
          claude: {
            ...claudeCatalogFixture(['claude-sonnet-4-5'], ['low', 'high']),
            visibleModels: [],
          },
        },
      },
    });
    const tab = {
      conversationId: null,
      providerId: 'claude' as const,
      draftModel: null as string | null,
      identityRevision: 1,
      admitsConversationOperations: true,
      reasoningSelections: new Map<string, string>(),
      providerSelections: new Map<string, { permissionMode: string; serviceTier: string }>(),
    };

    // Even before a model is available, a provider without a service-tier policy projects 'default'.
    expect(getSessionSettingsSnapshot(tab, host).serviceTier).toBe('default');

    tab.draftModel = 'claude-code/claude-sonnet-4-5';
    expect(getSessionSettingsSnapshot(tab, host).serviceTier).toBe('default');
  });
});
