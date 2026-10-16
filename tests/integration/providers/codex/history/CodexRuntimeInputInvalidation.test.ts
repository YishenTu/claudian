import '@/providers';

import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { testDate } from '@test/helpers/testClock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { RuntimeSettingsCoordinator } from '@/app/settings/RuntimeSettingsCoordinator';
import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ProviderSessionEvent } from '@/core/execution';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution/ProviderExecutionLifecycleRegistry';
import { SessionSnapshotState } from '@/core/execution/SessionSnapshotState';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ClaudianSettings, Conversation } from '@/core/types';
import { ExecutionSessionSupervisor } from '@/features/chat/execution/ExecutionSessionSupervisor';
import { createCodexWorkspaceServices } from '@/providers/codex/app/CodexWorkspaceServices';

let codexHome: string;

function writeRollout(threadId: string, question: string, answer: string): string {
  const sessions = path.join(codexHome, 'sessions', '2026', '03', '27');
  fs.mkdirSync(sessions, { recursive: true });
  const filePath = path.join(sessions, `rollout-2026-03-27T00-00-00-${threadId}.jsonl`);
  fs.writeFileSync(filePath, [
    { type: 'session_meta', payload: { id: threadId } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: `${threadId}-turn` } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: `${threadId}-turn` } },
  ].map((record, seconds) => JSON.stringify({ timestamp: testDate({ seconds }).toISOString(), ...record })).join('\n'));
  return filePath;
}

function closedConversation(id: string, threadId: string, question: string, answer: string): Conversation {
  return {
    id, providerId: 'codex', title: id, selectedModel: TEST_CODEX_MODEL,
    createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
    sessionId: threadId, messages: [], isPinned: false,
    providerState: {
      threadId,
      sessionFilePath: writeRollout(threadId, question, answer),
      transcriptRootPath: path.join(codexHome, 'sessions'),
      nativeConversationContextEstablished: true,
    },
  };
}

function fixture() {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS) as ClaudianSettings & Record<string, any>;
  settings.providerConfigs = {
    ...settings.providerConfigs,
    codex: {
      enabled: true,
      discoveredModels: TEST_CODEX_CATALOG,
      environmentVariables: `CODEX_HOME=${codexHome}`,
    },
  };
  const saveMetadata = jest.fn().mockResolvedValue(undefined);
  const repository = new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings,
    getVaultPath: () => '/vault',
    persistence: {
      metadataReader: {
        revalidate: jest.fn().mockResolvedValue([]),
        load: jest.fn().mockResolvedValue(null),
        scan: jest.fn().mockResolvedValue({ records: [], complete: true, invalidMetadataCount: 0 }),
        loadMetadata: jest.fn().mockResolvedValue(null),
        scanMetadata: jest.fn().mockResolvedValue({ metadata: [], complete: true, invalidMetadataCount: 0 }),
        listMetadata: jest.fn().mockResolvedValue([]),
      },
      saveMetadata,
      deleteCurrentMetadata: jest.fn().mockResolvedValue(undefined),
      assignMetadataToDevice: jest.fn().mockResolvedValue(undefined),
    } as never,
    onConversationDeleted: async () => undefined,
  });
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  const runtimeSettings = new RuntimeSettingsCoordinator({
    settings: new SettingsCoordinator(settings, async () => undefined),
    conversations: repository,
    executionLifecycle: lifecycle,
    getSettings: () => settings,
    canCompleteInvalidations: () => false,
  });
  // Record the configured runtime before the closed conversations exist.
  runtimeSettings.reconcile(['codex']);
  repository.replaceAll([
    closedConversation('conv-a', 'thread-a', 'Question A', 'Answer A'),
    closedConversation('conv-b', 'thread-b', 'Question B', 'Answer B'),
  ]);
  return { lifecycle, repository, runtimeSettings, saveMetadata, settings };
}

async function visibleHistory(repository: ConversationRepository, id: string): Promise<string[]> {
  const conversation = await repository.ensureHydrated(id);
  return (conversation?.messages ?? []).map(message => message.content);
}

describe('Codex runtime-input changes', () => {
  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-runtime-'));
  });

  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it('keeps closed conversations bound and readable after a CLI path change', async () => {
    const { repository, runtimeSettings } = fixture();

    const reconciliation = await runtimeSettings.commit(['codex'], (settings) => {
      (settings.providerConfigs as any).codex.cliPath = '/opt/codex/bin/codex';
    }, { failureMessage: 'Failed to save settings' });

    expect(reconciliation).toMatchObject({
      environmentChangedProviderIds: ['codex'],
      sessionInvalidationProviderIds: [],
    });
    for (const [id, threadId] of [['conv-a', 'thread-a'], ['conv-b', 'thread-b']]) {
      expect(repository.getCachedConversation(id)).toMatchObject({
        sessionId: threadId,
        providerState: { threadId, nativeConversationContextEstablished: true },
      });
    }
    expect(await visibleHistory(repository, 'conv-a')).toEqual(['Question A', 'Answer A']);
    expect(await visibleHistory(repository, 'conv-b')).toEqual(['Question B', 'Answer B']);
  });

  it('invalidates bindings on an endpoint change while closed conversations stay readable', async () => {
    const { repository, runtimeSettings, saveMetadata } = fixture();

    const reconciliation = await runtimeSettings.commit(['codex'], (settings) => {
      (settings.providerConfigs as any).codex.environmentVariables
        = `CODEX_HOME=${codexHome}\nOPENAI_BASE_URL=https://new.example.com/v1`;
    }, { failureMessage: 'Failed to save settings' });

    expect(reconciliation.sessionInvalidationProviderIds).toEqual(['codex']);
    const persisted = saveMetadata.mock.calls.map(([conversation]) => conversation as Conversation);
    expect(persisted.map(conversation => conversation.id).sort()).toEqual(['conv-a', 'conv-b']);
    for (const conversation of persisted) {
      expect(conversation.sessionId).toBeNull();
      expect(conversation.providerState).not.toHaveProperty('threadId');
      expect(conversation.providerState).toMatchObject({
        nativeConversationContextEstablished: false,
        previousSegments: [expect.objectContaining({ threadId: conversation.id.replace('conv', 'thread') })],
      });
    }
    expect(await visibleHistory(repository, 'conv-a')).toEqual(['Question A', 'Answer A']);
    expect(await visibleHistory(repository, 'conv-b')).toEqual(['Question B', 'Answer B']);
  });

  it.each([
    ['an endpoint change', (codex: Record<string, unknown>) => {
      codex.environmentVariables = `CODEX_HOME=${codexHome}\nOPENAI_BASE_URL=https://new.example.com/v1`;
    }, false, null],
    // Disabling stops execution but does not change where the thread lives.
    ['disabling Codex', (codex: Record<string, unknown>) => { codex.enabled = false; }, false, 'thread-a'],
    ['a CLI path change', (codex: Record<string, unknown>) => { codex.cliPath = '/opt/codex/bin/codex'; }, true, 'thread-a'],
  ])('lets a running session outlive %s only when its binding stays valid', async (_change, change, preserved, binding) => {
    const { lifecycle, repository, runtimeSettings, settings } = fixture();
    const workspace = await createCodexWorkspaceServices({
      settings, executionLifecycleRegistry: lifecycle,
    } as unknown as ProviderHost);
    const live = new SessionSnapshotState({
      providerId: 'codex',
      sessionInstanceId: 'live-session',
      providerState: repository.getCachedConversation('conv-a')!.providerState,
      readProviderSessionId: () => 'thread-a',
    });
    const persistedSnapshots: Array<Promise<boolean>> = [];
    const supervisor = new ExecutionSessionSupervisor(lifecycle);
    // The chat coordinator persists every session state change admitted by the supervisor.
    const { generation } = supervisor.acquire({
      providerId: 'codex',
      createSession: () => ({
        onEvent: (listener: (event: ProviderSessionEvent) => void) => live.onEvent(listener),
        getSnapshot: () => live.getSnapshot(),
        dispose: async () => undefined,
      }),
    } as never, {} as never, () => undefined, (event) => {
      if (event.type !== 'session_state_changed') return;
      persistedSnapshots.push(repository.persistExecutionSnapshot('conv-a', 'binding-a', generation, event.snapshot));
    });
    const emitSnapshot = (status: 'executing' | 'idle') => {
      live.setStatus(status);
      live.emit({ type: 'session_state_changed', snapshot: live.getSnapshot() } as never);
      return Promise.all(persistedSnapshots);
    };
    try {
      repository.registerExecutionBinding('conv-a', 'binding-a', generation);
      await emitSnapshot('executing');

      await lifecycle.runTransition(['codex'], async () => {
        await runtimeSettings.commit(['codex'], (draft) => {
          change((draft.providerConfigs as any).codex);
        }, { failureMessage: 'Failed to save settings' });
      });
      expect(supervisor.current !== null).toBe(preserved);

      // A late completion from the draining process must not revive an invalidated binding.
      await emitSnapshot('idle');
      expect(repository.getCachedConversation('conv-a')?.sessionId).toBe(binding);
      expect(await visibleHistory(repository, 'conv-a')).toEqual(['Question A', 'Answer A']);
    } finally {
      await supervisor.release();
      await workspace.dispose();
      await lifecycle.dispose();
    }
  });

  it.each([
    ['an endpoint change', (codex: Record<string, unknown>) => {
      codex.environmentVariables = `CODEX_HOME=${codexHome}\nOPENAI_BASE_URL=https://new.example.com/v1`;
    }, false, null],
    // Disabling stops execution but does not change where the thread lives.
    ['disabling Codex', (codex: Record<string, unknown>) => { codex.enabled = false; }, false, 'thread-a'],
    ['a CLI path change', (codex: Record<string, unknown>) => { codex.cliPath = '/opt/codex/bin/codex'; }, true, 'thread-a'],
  ])('keeps a first thread adopted during %s as history only when its binding was retired', async (_change, change, preserved, binding) => {
    const { lifecycle, repository, runtimeSettings, settings } = fixture();
    repository.replaceAll(['conv-a', 'conv-b'].map(id => repository.getCachedConversation(id)!).map(conversation => conversation.id === 'conv-a'
      ? { ...conversation, sessionId: null, providerState: undefined, messages: [] }
      : conversation));
    let adoptedThreadId: string | null = null;
    const workspace = await createCodexWorkspaceServices({
      settings, executionLifecycleRegistry: lifecycle,
    } as unknown as ProviderHost);
    const live = new SessionSnapshotState({
      providerId: 'codex',
      sessionInstanceId: 'live-session',
      providerState: repository.getCachedConversation('conv-a')!.providerState,
      readProviderSessionId: () => adoptedThreadId,
    });
    const persistedSnapshots: Array<Promise<boolean>> = [];
    const supervisor = new ExecutionSessionSupervisor(lifecycle);
    // The chat coordinator persists every session state change admitted by the supervisor.
    const { generation } = supervisor.acquire({
      providerId: 'codex',
      createSession: () => ({
        onEvent: (listener: (event: ProviderSessionEvent) => void) => live.onEvent(listener),
        getSnapshot: () => live.getSnapshot(),
        dispose: async () => undefined,
      }),
    } as never, {} as never, () => undefined, (event) => {
      if (event.type !== 'session_state_changed') return;
      persistedSnapshots.push(repository.persistExecutionSnapshot('conv-a', 'binding-a', generation, event.snapshot));
    });
    const emitSnapshot = (status: 'executing' | 'idle') => {
      live.setStatus(status);
      live.emit({ type: 'session_state_changed', snapshot: live.getSnapshot() } as never);
      return Promise.all(persistedSnapshots);
    };
    try {
      repository.registerExecutionBinding('conv-a', 'binding-a', generation);
      await emitSnapshot('executing');

      await lifecycle.runTransition(['codex'], async () => {
        await runtimeSettings.commit(['codex'], (draft) => {
          change((draft.providerConfigs as any).codex);
        }, {
          failureMessage: 'Failed to save settings',
          onSettingsCommitted: async () => {
            adoptedThreadId = 'thread-a';
            live.setProviderStateValue('threadId', adoptedThreadId);
            await emitSnapshot('idle');
          },
        });
      });
      expect(supervisor.current !== null).toBe(preserved);

      // The adopted thread stays readable, but an invalidated binding never becomes live.
      await emitSnapshot('idle');
      expect(repository.getCachedConversation('conv-a')?.sessionId).toBe(binding);
      expect(await visibleHistory(repository, 'conv-a')).toEqual(['Question A', 'Answer A']);
    } finally {
      await supervisor.release();
      await workspace.dispose();
      await lifecycle.dispose();
    }
  });

  it('keeps a fork child adopted during an endpoint change as one history segment', async () => {
    const { lifecycle, repository, runtimeSettings, settings } = fixture();
    const sourcePath = repository.getCachedConversation('conv-a')!.providerState!.sessionFilePath as string;
    const childPath = sourcePath.replace('thread-a.jsonl', 'thread-child.jsonl');
    repository.replaceAll(['conv-a', 'conv-b'].map(id => repository.getCachedConversation(id)!).map(conversation => conversation.id === 'conv-a'
      ? { ...conversation, sessionId: null, providerState: {
          forkSource: { sessionId: 'thread-a', resumeAt: 'thread-a-turn' },
          forkSourceSessionFilePath: sourcePath,
        }, messages: [] }
      : conversation));
    let adoptedThreadId: string | null = null;
    const workspace = await createCodexWorkspaceServices({
      settings, executionLifecycleRegistry: lifecycle,
    } as unknown as ProviderHost);
    const live = new SessionSnapshotState({
      providerId: 'codex',
      sessionInstanceId: 'live-session',
      providerState: repository.getCachedConversation('conv-a')!.providerState,
      readProviderSessionId: () => adoptedThreadId,
    });
    const persistedSnapshots: Array<Promise<boolean>> = [];
    const supervisor = new ExecutionSessionSupervisor(lifecycle);
    // The chat coordinator persists every session state change admitted by the supervisor.
    const { generation } = supervisor.acquire({
      providerId: 'codex',
      createSession: () => ({
        onEvent: (listener: (event: ProviderSessionEvent) => void) => live.onEvent(listener),
        getSnapshot: () => live.getSnapshot(),
        dispose: async () => undefined,
      }),
    } as never, {} as never, () => undefined, (event) => {
      if (event.type !== 'session_state_changed') return;
      persistedSnapshots.push(repository.persistExecutionSnapshot('conv-a', 'binding-a', generation, event.snapshot));
    });
    const emitSnapshot = (status: 'executing' | 'idle') => {
      live.setStatus(status);
      live.emit({ type: 'session_state_changed', snapshot: live.getSnapshot() } as never);
      return Promise.all(persistedSnapshots);
    };
    try {
      repository.registerExecutionBinding('conv-a', 'binding-a', generation);
      await emitSnapshot('executing');

      await lifecycle.runTransition(['codex'], async () => {
        await runtimeSettings.commit(['codex'], (draft) => {
          (draft.providerConfigs as any).codex.environmentVariables
            = `CODEX_HOME=${codexHome}\nOPENAI_BASE_URL=https://new.example.com/v1`;
        }, {
          failureMessage: 'Failed to save settings',
          onSettingsCommitted: async () => {
            adoptedThreadId = 'thread-child';
            fs.writeFileSync(childPath, fs.readFileSync(sourcePath, 'utf8').replace('"id":"thread-a"', '"id":"thread-child"'));
            live.setProviderStateValue('threadId', adoptedThreadId);
            live.setProviderStateValue('sessionFilePath', childPath);
            await emitSnapshot('idle');
            // Completing fork setup consumes the fork metadata for the same child thread.
            for (const key of ['forkSource', 'forkSourceSessionFilePath', 'forkSourceTranscriptRootPath', 'pendingForkTarget']) {
              live.deleteProviderStateValue(key);
            }
            await emitSnapshot('idle');
          },
        });
      });
      expect(supervisor.current).toBeNull();

      // The late fork child supersedes its pending segment instead of repeating the source prefix.
      await emitSnapshot('idle');
      expect(repository.getCachedConversation('conv-a')?.sessionId).toBeNull();
      expect(await visibleHistory(repository, 'conv-a')).toEqual(['Question A', 'Answer A']);
    } finally {
      await supervisor.release();
      await workspace.dispose();
      await lifecycle.dispose();
    }
  });
});
