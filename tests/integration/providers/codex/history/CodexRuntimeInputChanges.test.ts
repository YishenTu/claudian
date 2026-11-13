import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { testDate } from '@test/helpers/testClock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { RuntimeSettingsCoordinator } from '@/app/settings/RuntimeSettingsCoordinator';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import type { ProviderSessionEvent } from '@/core/execution';
import { SessionSnapshotState } from '@/core/execution/SessionSnapshotState';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import type { Conversation } from '@/core/types';
import { ExecutionSessionSupervisor } from '@/features/chat/execution/ExecutionSessionSupervisor';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import { createCodexWorkspaceServices } from '@/providers/codex/app/CodexWorkspaceServices';
import { codexProviderRegistration } from '@/providers/codex/registration';

registerProviderModules([claudeProviderRegistration, codexProviderRegistration]);

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

async function fixture() {
  const providerFixture = await createProviderHostFixture({ settings: {
    providerConfigs: { codex: {
      enabled: true, discoveredModels: TEST_CODEX_CATALOG, environmentVariables: `CODEX_HOME=${codexHome}`,
    } },
  } });
  const { settings, lifecycle } = providerFixture;
  const persistence = new ConversationPersistenceStore(providerFixture.vault.files, providerFixture.storage.installationKey);
  const repository = new ConversationRepository({
    providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings, getVaultPath: () => providerFixture.vault.root,
    persistence, onConversationDeleted: async () => undefined,
  });
  const runtimeSettings = new RuntimeSettingsCoordinator({
    settings: providerFixture.coordinator,
    getSettings: () => settings,
  });
  // Record the configured runtime before the closed conversations exist.
  runtimeSettings.reconcile(['codex']);
  repository.replaceAll([
    closedConversation('conv-a', 'thread-a', 'Question A', 'Answer A'),
    closedConversation('conv-b', 'thread-b', 'Question B', 'Answer B'),
  ]);
  return { lifecycle, repository, runtimeSettings, host: providerFixture.host };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A live Codex session for conv-a whose state changes the chat coordinator persists. */
function startLiveSession({ lifecycle, repository }: Fixture, readThreadId: () => string | null) {
  const live = new SessionSnapshotState({
    providerId: 'codex',
    sessionInstanceId: 'live-session',
    providerState: repository.getCachedConversation('conv-a')!.providerState,
    readProviderSessionId: readThreadId,
  });
  const persistedSnapshots: Array<Promise<boolean>> = [];
  const supervisor = new ExecutionSessionSupervisor(lifecycle);
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
  repository.registerExecutionBinding('conv-a', 'binding-a', generation);
  const emitSnapshot = (status: 'executing' | 'idle') => {
    live.setStatus(status);
    live.emit({ type: 'session_state_changed', snapshot: live.getSnapshot() } as never);
    return Promise.all(persistedSnapshots);
  };
  return { emitSnapshot, live, supervisor };
}

async function visibleHistory(repository: ConversationRepository, id: string): Promise<string[]> {
  const conversation = await repository.ensureHydrated(id);
  return (conversation?.messages ?? []).map(message => message.content);
}

type CodexConfigChange = (codex: Record<string, unknown>) => void;

// Each change with whether the recorded rollouts stay readable: history is read only under
// the configured CODEX_HOME, so moving it hides them while the binding is kept.
const runtimeInputChanges: Array<[string, CodexConfigChange, boolean]> = [
  ['a CLI path change', (codex) => { codex.cliPath = '/opt/codex/bin/codex'; }, true],
  ['an endpoint change', (codex) => {
    codex.environmentVariables = `CODEX_HOME=${codexHome}\nOPENAI_BASE_URL=https://new.example.com/v1`;
  }, true],
  ['a CODEX_HOME change', (codex) => { codex.environmentVariables = `CODEX_HOME=${codexHome}-moved`; }, false],
];

// Running sessions survive every runtime-input change; disabling Codex ends them.
const runningSessionChanges: Array<[string, CodexConfigChange, boolean, boolean]> = [
  ...runtimeInputChanges.map(([label, change, readable]): [string, CodexConfigChange, boolean, boolean] => [label, change, readable, true]),
  ['disabling Codex', (codex) => { codex.enabled = false; }, true, false],
];

const historyA = (readable: boolean) => (readable ? ['Question A', 'Answer A'] : []);

describe('Codex runtime-input changes', () => {
  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-runtime-'));
  });

  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it.each(runtimeInputChanges)('restarts the runtime and keeps closed conversations bound after %s', async (_change, change, readable) => {
    const { repository, runtimeSettings } = await fixture();

    const reconciliation = await runtimeSettings.commit(['codex'], (settings) => {
      change(settings.providerConfigs.codex!);
    }, { failureMessage: 'Failed to save settings' });

    expect(reconciliation).toEqual({ changed: true, environmentChangedProviderIds: ['codex'] });
    expect(await visibleHistory(repository, 'conv-a')).toEqual(historyA(readable));
    expect(await visibleHistory(repository, 'conv-b')).toEqual(readable ? ['Question B', 'Answer B'] : []);
    for (const [id, threadId] of [['conv-a', 'thread-a'], ['conv-b', 'thread-b']]) {
      expect(repository.getCachedConversation(id)).toMatchObject({
        sessionId: threadId,
        providerState: { threadId, nativeConversationContextEstablished: true },
      });
    }
  });

  it.each(runningSessionChanges)('keeps the binding of a session running through %s', async (_change, change, readable, preserved) => {
    const context = await fixture();
    const { lifecycle, repository, runtimeSettings, host } = context;
    const workspace = await createCodexWorkspaceServices(host);
    const { emitSnapshot, supervisor } = startLiveSession(context, () => 'thread-a');
    try {
      await emitSnapshot('executing');

      await lifecycle.runTransition(['codex'], async () => {
        await runtimeSettings.commit(['codex'], (draft) => {
          change(draft.providerConfigs.codex!);
        }, { failureMessage: 'Failed to save settings' });
      });
      expect(supervisor.current !== null).toBe(preserved);

      await emitSnapshot('idle');
      expect(await visibleHistory(repository, 'conv-a')).toEqual(historyA(readable));
      expect(repository.getCachedConversation('conv-a')?.sessionId).toBe('thread-a');
    } finally {
      await supervisor.release();
      await workspace.dispose();
      await lifecycle.dispose();
    }
  });

  it.each(runningSessionChanges)('binds a first thread adopted during %s', async (_change, change, readable, preserved) => {
    const context = await fixture();
    const { lifecycle, repository, runtimeSettings, host } = context;
    repository.replaceAll(['conv-a', 'conv-b'].map(id => repository.getCachedConversation(id)!).map(conversation => conversation.id === 'conv-a'
      ? { ...conversation, sessionId: null, providerState: undefined, messages: [] }
      : conversation));
    let adoptedThreadId: string | null = null;
    const workspace = await createCodexWorkspaceServices(host);
    const { emitSnapshot, live, supervisor } = startLiveSession(context, () => adoptedThreadId);
    try {
      await emitSnapshot('executing');

      await lifecycle.runTransition(['codex'], async () => {
        await runtimeSettings.commit(['codex'], (draft) => {
          change(draft.providerConfigs.codex!);
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

      await emitSnapshot('idle');
      expect(await visibleHistory(repository, 'conv-a')).toEqual(historyA(readable));
      expect(repository.getCachedConversation('conv-a')?.sessionId).toBe('thread-a');
    } finally {
      await supervisor.release();
      await workspace.dispose();
      await lifecycle.dispose();
    }
  });

  it('binds a fork child adopted during an endpoint change and shows its history once', async () => {
    const context = await fixture();
    const { lifecycle, repository, runtimeSettings, host } = context;
    const sourcePath = repository.getCachedConversation('conv-a')!.providerState!.sessionFilePath as string;
    const childPath = sourcePath.replace('thread-a.jsonl', 'thread-child.jsonl');
    repository.replaceAll(['conv-a', 'conv-b'].map(id => repository.getCachedConversation(id)!).map(conversation => conversation.id === 'conv-a'
      ? { ...conversation, sessionId: null, providerState: {
          forkSource: { sessionId: 'thread-a', resumeAt: 'thread-a-turn' },
          forkSourceSessionFilePath: sourcePath,
        }, messages: [] }
      : conversation));
    let adoptedThreadId: string | null = null;
    const workspace = await createCodexWorkspaceServices(host);
    const { emitSnapshot, live, supervisor } = startLiveSession(context, () => adoptedThreadId);
    try {
      await emitSnapshot('executing');

      await lifecycle.runTransition(['codex'], async () => {
        await runtimeSettings.commit(['codex'], (draft) => {
          draft.providerConfigs.codex!.environmentVariables
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
      expect(supervisor.current).not.toBeNull();

      // The child replays the source prefix; it is shown once, not after a copy of the source.
      await emitSnapshot('idle');
      expect(repository.getCachedConversation('conv-a')?.sessionId).toBe('thread-child');
      expect(await visibleHistory(repository, 'conv-a')).toEqual(['Question A', 'Answer A']);
    } finally {
      await supervisor.release();
      await workspace.dispose();
      await lifecycle.dispose();
    }
  });
});
