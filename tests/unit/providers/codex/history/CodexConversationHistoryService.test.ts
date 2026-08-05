import type * as fsType from 'fs';
import type * as osType from 'os';
import type * as pathType from 'path';

const fs = jest.requireActual<typeof fsType>('fs');
const os = jest.requireActual<typeof osType>('os');
const path = jest.requireActual<typeof pathType>('path');

import type { ProviderConversationHistoryService } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';

async function resolveMissingConversationSession(
  service: CodexConversationHistoryService,
  conversation: Conversation,
  missingProviderSessionId?: string,
): Promise<'delete' | 'reset' | 'preserve' | 'unimplemented'> {
  const resolver = (service as ProviderConversationHistoryService)
    .resolveMissingConversationSession;
  return resolver
    ? resolver.call(service, conversation, null, missingProviderSessionId)
    : 'unimplemented';
}

describe('CodexConversationHistoryService', () => {
  let homeDirSpy: jest.SpyInstance<string, []>;
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-home-'));
    homeDirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    homeDirSpy.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('hydrates history by resolving the transcript path from thread id', async () => {
    const threadId = 'thread-123';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Summarize this file.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Here is the summary.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-1',
      providerId: 'codex',
      title: 'Codex Transcript',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Summarize this file.',
    });
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Here is the summary.',
    });
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(transcriptPath);
  });

  it('recovers the last Codex model from turn context without catalog validation', async () => {
    const transcriptPath = path.join(tempHome, 'historical-model.jsonl');
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      ].join('\n'),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'historical-model',
      providerId: 'codex',
      title: 'Historical model',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: 'thread-1',
      providerState: { sessionFilePath: transcriptPath, threadId: 'thread-1' },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection?.(conversation, null))
      .resolves.toBe('openai-codex/gpt-5.5');
  });

  it('does not recover a Codex model past a missing rewind checkpoint', async () => {
    const transcriptPath = path.join(tempHome, 'stale-checkpoint-model.jsonl');
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-5.4-mini', turn_id: 'turn-1' },
        }),
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-5.5', turn_id: 'turn-2' },
        }),
      ].join('\n'),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'stale-checkpoint-model',
      providerId: 'codex',
      title: 'Stale checkpoint model',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: 'thread-stale-checkpoint',
      resumeAtMessageId: 'missing-turn',
      providerState: {
        sessionFilePath: transcriptPath,
        threadId: 'thread-stale-checkpoint',
      },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection(conversation, null))
      .resolves.toBeNull();
  });

  it('does not recover an established fork model past a missing source checkpoint', async () => {
    const sourcePath = path.join(tempHome, 'fork-source-model.jsonl');
    const forkPath = path.join(tempHome, 'established-fork-model.jsonl');
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-5.4-mini', turn_id: 'source-turn-1' },
      }),
      'utf8',
    );
    fs.writeFileSync(
      forkPath,
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-5.5', turn_id: 'fork-turn-1' },
      }),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'established-fork-stale-source-checkpoint',
      providerId: 'codex',
      title: 'Established fork stale source checkpoint',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: 'fork-thread',
      providerState: {
        threadId: 'fork-thread',
        sessionFilePath: forkPath,
        forkSource: {
          sessionId: 'source-thread',
          resumeAt: 'missing-source-turn',
        },
        forkSourceSessionFilePath: sourcePath,
      },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection(conversation, null))
      .resolves.toBeNull();
  });

  it('recovers a model after Codex moves the transcript into archived_sessions', async () => {
    const threadId = 'thread-archived-model';
    const codexDir = path.join(tempHome, '.codex');
    const sessionsDir = path.join(codexDir, 'sessions');
    const archivedDir = path.join(codexDir, 'archived_sessions');
    const stalePath = path.join(sessionsDir, `rollout-stale-${threadId}.jsonl`);
    const archivedPath = path.join(
      archivedDir,
      `rollout-2026-08-05T00-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(
      archivedPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'archived-model',
      providerId: 'codex',
      title: 'Archived model',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: threadId,
      providerState: {
        sessionFilePath: stalePath,
        threadId,
        transcriptRootPath: sessionsDir,
      },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection(conversation, null))
      .resolves.toBe('openai-codex/gpt-5.5');
  });

  it('recovers an archived model from legacy metadata containing only a thread id', async () => {
    const threadId = 'thread-archived-legacy-model';
    const archivedDir = path.join(tempHome, '.codex', 'archived_sessions');
    const archivedPath = path.join(
      archivedDir,
      `rollout-2026-08-05T00-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(
      archivedPath,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
      'utf8',
    );
    const conversation: Conversation = {
      id: 'archived-legacy-model',
      providerId: 'codex',
      title: 'Archived legacy model',
      createdAt: 1,
      lastActivityAt: 2,
      sessionId: threadId,
      providerState: { threadId },
      messages: [],
    };

    await expect(new CodexConversationHistoryService()
      .recoverConversationModelSelection(conversation, null))
      .resolves.toBe('openai-codex/gpt-5.5');
  });

  it('marks native context established after recovering a non-empty owned transcript', async () => {
    const threadId = 'thread-crash-recovery';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Committed before crash.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Native response.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );
    const conversation: Conversation = {
      id: 'conv-crash-recovery',
      providerId: 'codex',
      title: 'Crash recovery',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: {
        threadId,
        sessionFilePath: transcriptPath,
        nativeConversationContextEstablished: false,
        futureProviderState: { token: 'preserve' },
      },
      messages: [],
    };

    await new CodexConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
    );

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.providerState).toEqual(expect.objectContaining({
      nativeConversationContextEstablished: true,
      futureProviderState: { token: 'preserve' },
    }));
  });

  it('rehydrates when the same conversation id is restored with empty messages', async () => {
    const threadId = 'thread-456';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'First prompt' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'First answer' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-2',
      providerId: 'codex',
      title: 'Reloaded Codex Transcript',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: transcriptPath },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);
    expect(conversation.messages).toHaveLength(2);

    conversation.messages = [];
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'First answer',
    });
  });

  it('hydrates by searching transcriptRootPath when sessionFilePath is missing', async () => {
    const threadId = 'thread-rooted';
    const sessionsDir = path.join(tempHome, 'custom-codex-root', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Recovered from transcript root.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-rooted',
      providerId: 'codex',
      title: 'Transcript Root',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: {
        threadId,
        transcriptRootPath: path.join(tempHome, 'custom-codex-root', 'sessions'),
      },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Recovered from transcript root.',
    });
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(transcriptPath);
  });

  it('backfills transcriptRootPath from sessionFilePath when only the session path is known', async () => {
    const threadId = 'thread-backfill-root';
    const sessionsDir = path.join(tempHome, 'custom-codex-root', 'sessions', '2026', '03', '28');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-28T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-28T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Recovered from session path.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-backfill-root',
      providerId: 'codex',
      title: 'Backfill Transcript Root',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: {
        threadId,
        sessionFilePath: transcriptPath,
      },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(1);
    expect((conversation.providerState as Record<string, unknown>).transcriptRootPath).toBe(
      path.join(tempHome, 'custom-codex-root', 'sessions'),
    );
  });

  it('does not open an out-of-root metadata path and re-resolves by thread id', async () => {
    const threadId = 'thread-untrusted-path';
    const trustedDir = path.join(tempHome, '.codex', 'sessions', '2026', '07', '11');
    const outsideDir = path.join(tempHome, 'synced-other-device');
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    const trustedPath = path.join(trustedDir, `rollout-${threadId}.jsonl`);
    const outsidePath = path.join(outsideDir, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(trustedPath, JSON.stringify({
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Trusted transcript.' }],
      },
    }));
    fs.writeFileSync(outsidePath, JSON.stringify({
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Untrusted transcript.' }],
      },
    }));
    const conversation: Conversation = {
      id: 'conv-untrusted-path',
      providerId: 'codex',
      title: 'Synced metadata path',
      createdAt: 1,
      lastActivityAt: 1,
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: outsidePath },
      messages: [],
    };

    await new CodexConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: tempHome } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Trusted transcript.']);
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(trustedPath);
  });

  it('accepts a metadata path under the explicitly configured Codex home', async () => {
    const configuredHome = path.join(tempHome, 'configured-codex-home');
    const transcriptPath = path.join(configuredHome, 'sessions', 'session.jsonl');
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, JSON.stringify({
      timestamp: '2026-07-11T00:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Configured transcript.' }],
      },
    }));
    const conversation: Conversation = {
      id: 'conv-configured-path',
      providerId: 'codex',
      title: 'Configured path',
      createdAt: 1,
      lastActivityAt: 1,
      sessionId: 'configured-thread',
      providerState: { threadId: 'configured-thread', sessionFilePath: transcriptPath },
      messages: [],
    };

    await new CodexConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { CODEX_HOME: configuredHome, HOME: tempHome } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Configured transcript.']);
  });

  describe('buildForkProviderState', () => {
    it('stores forkSource with sessionId and resumeAt in providerState', () => {
      const service = new CodexConversationHistoryService();
      const result = service.buildForkProviderState('source-thread-id', 'turn-uuid-2');

      expect(result).toEqual({
        forkSource: { sessionId: 'source-thread-id', resumeAt: 'turn-uuid-2' },
      });
    });

    it('preserves source transcript hints when provided', () => {
      const service = new CodexConversationHistoryService();
      const result = service.buildForkProviderState(
        'source-thread-id',
        'turn-uuid-2',
        {
          sessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\03\\27\\rollout-thread.jsonl',
          transcriptRootPath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
        },
      );

      expect(result).toEqual({
        forkSource: { sessionId: 'source-thread-id', resumeAt: 'turn-uuid-2' },
        forkSourceSessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\03\\27\\rollout-thread.jsonl',
        forkSourceTranscriptRootPath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
      });
    });

    it('preserves workspace dependency tool provenance from the source thread', () => {
      const service = new CodexConversationHistoryService();
      const result = service.buildForkProviderState(
        'source-thread-id',
        'turn-uuid-2',
        { workspaceDependencyToolVersion: 1 },
      );

      expect(result).toEqual({
        forkSource: { sessionId: 'source-thread-id', resumeAt: 'turn-uuid-2' },
        workspaceDependencyToolVersion: 1,
      });
    });

    it('derives the source transcript root from sessionFilePath when only the session path is stored', () => {
      const service = new CodexConversationHistoryService();
      const result = service.buildForkProviderState(
        'source-thread-id',
        'turn-uuid-2',
        {
          sessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\03\\27\\rollout-thread.jsonl',
        },
      );

      expect(result).toEqual({
        forkSource: { sessionId: 'source-thread-id', resumeAt: 'turn-uuid-2' },
        forkSourceSessionFilePath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions\\2026\\03\\27\\rollout-thread.jsonl',
        forkSourceTranscriptRootPath: '\\\\wsl$\\Ubuntu\\home\\user\\.codex\\sessions',
      });
    });
  });

  describe('isPendingForkConversation', () => {
    it('returns true when forkSource exists, no threadId, no sessionId', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork',
        providerId: 'codex',
        title: 'Pending Fork',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source', resumeAt: 'turn-1' } },
        messages: [],
      };

      expect(service.isPendingForkConversation(conversation)).toBe(true);
    });

    it('returns false when threadId exists (established fork)', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork-est',
        providerId: 'codex',
        title: 'Established Fork',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: 'fork-thread-1',
          forkSource: { sessionId: 'source', resumeAt: 'turn-1' },
        },
        messages: [],
      };

      expect(service.isPendingForkConversation(conversation)).toBe(false);
    });

    it('returns false when no forkSource', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-normal',
        providerId: 'codex',
        title: 'Normal',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: 'thread-1',
        providerState: { threadId: 'thread-1' },
        messages: [],
      };

      expect(service.isPendingForkConversation(conversation)).toBe(false);
    });
  });

  describe('resolveSessionIdForConversation', () => {
    it('falls back to forkSource.sessionId', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork-resolve',
        providerId: 'codex',
        title: 'Fork Resolve',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: 'source-thread', resumeAt: 'turn-1' } },
        messages: [],
      };

      expect(service.resolveSessionIdForConversation(conversation)).toBe('source-thread');
    });

    it('prefers threadId over forkSource.sessionId', () => {
      const service = new CodexConversationHistoryService();
      const conversation: Conversation = {
        id: 'conv-fork-pref',
        providerId: 'codex',
        title: 'Fork Pref',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: 'my-thread',
          forkSource: { sessionId: 'source-thread', resumeAt: 'turn-1' },
        },
        messages: [],
      };

      expect(service.resolveSessionIdForConversation(conversation)).toBe('my-thread');
    });
  });

  describe('resolveMissingConversationSession', () => {
    it('resets only the exact stale live thread identity and preserves replay evidence', async () => {
      const conversation: Conversation = {
        id: 'conv-missing-thread',
        providerId: 'codex',
        title: 'Missing thread',
        createdAt: 1,
        lastActivityAt: 1,
        sessionId: 'thread-missing',
        resumeAtMessageId: 'fork-checkpoint',
        providerState: {
          threadId: 'thread-missing',
          nativeConversationContextEstablished: true,
          pendingForkTarget: {
            threadId: 'thread-missing',
            sessionFilePath: '/codex/sessions/thread-missing.jsonl',
          },
          sessionFilePath: '/codex/sessions/thread-missing.jsonl',
          transcriptRootPath: '/codex/sessions',
          forkSource: {
            sessionId: 'thread-source',
            resumeAt: 'fork-checkpoint',
          },
          forkSourceSessionFilePath: '/codex/sessions/thread-source.jsonl',
          forkSourceTranscriptRootPath: '/codex/sessions',
          workspaceDependencyToolVersion: 1,
          futureProviderState: { token: 'keep-me' },
        },
        messages: [],
      };

      await expect(resolveMissingConversationSession(
        new CodexConversationHistoryService(),
        conversation,
        'thread-missing',
      )).resolves.toBe('reset');

      expect(conversation.sessionId).toBeNull();
      expect(conversation.resumeAtMessageId).toBe('fork-checkpoint');
      expect(conversation.providerState).toEqual({
        sessionFilePath: '/codex/sessions/thread-missing.jsonl',
        transcriptRootPath: '/codex/sessions',
        forkSource: {
          sessionId: 'thread-source',
          resumeAt: 'fork-checkpoint',
        },
        forkSourceSessionFilePath: '/codex/sessions/thread-source.jsonl',
        forkSourceTranscriptRootPath: '/codex/sessions',
        workspaceDependencyToolVersion: 1,
        futureProviderState: { token: 'keep-me' },
      });
    });

    it.each([
      ['another reported thread', 'thread-newer'],
      ['no reported thread', undefined],
    ])('preserves current state for %s', async (_case, missingSessionId) => {
      const providerState = {
        threadId: 'thread-current',
        nativeConversationContextEstablished: true,
        sessionFilePath: '/codex/sessions/thread-current.jsonl',
        futureProviderState: { token: 'keep-me' },
      };
      const conversation: Conversation = {
        id: 'conv-current-thread',
        providerId: 'codex',
        title: 'Current thread',
        createdAt: 1,
        lastActivityAt: 1,
        sessionId: 'thread-current',
        providerState,
        messages: [],
      };

      await expect(resolveMissingConversationSession(
        new CodexConversationHistoryService(),
        conversation,
        missingSessionId,
      )).resolves.toBe('preserve');

      expect(conversation.sessionId).toBe('thread-current');
      expect(conversation.providerState).toBe(providerState);
    });
  });

  describe('pending-fork hydration', () => {
    it('hydrates from source transcript truncated at resumeAt', async () => {
      const sourceThreadId = 'source-thread-pf';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const transcriptPath = path.join(
        sessionsDir,
        `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`,
      );

      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-3' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:07.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-3' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-pf',
        providerId: 'codex',
        title: 'Pending Fork',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: sourceThreadId, resumeAt: 'turn-uuid-2' } },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      await service.hydrateConversationHistory(conversation, null);

      // Should only have messages from turn 1 and turn 2 (truncated at resumeAt)
      expect(conversation.messages).toHaveLength(4);
      expect(conversation.messages[0].content).toBe('Turn 1');
      expect(conversation.messages[1].content).toBe('Reply 1');
      expect(conversation.messages[2].content).toBe('Turn 2');
      expect(conversation.messages[3].content).toBe('Reply 2');
    });

    it('does not widen pending-fork history when resumeAt is missing', async () => {
      const sourceThreadId = 'source-thread-pf-missing';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-uuid-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Turn 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reply 2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-uuid-2' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-pf-missing',
        providerId: 'codex',
        title: 'Pending Fork Missing Checkpoint',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: sourceThreadId, resumeAt: 'turn-uuid-missing' } },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      await service.hydrateConversationHistory(conversation, null);

      expect(conversation.messages).toEqual([]);
    });

    it('keeps in-memory messages on pending fork', async () => {
      const conversation: Conversation = {
        id: 'conv-pf-mem',
        providerId: 'codex',
        title: 'Pending Fork In Memory',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: { forkSource: { sessionId: 'nonexistent', resumeAt: 'turn-1' } },
        messages: [
          { id: 'msg-1', role: 'user', content: 'Cloned message', timestamp: Date.now() },
        ],
      };

      const service = new CodexConversationHistoryService();
      await service.hydrateConversationHistory(conversation, null);

      expect(conversation.messages).toHaveLength(1);
      expect(conversation.messages[0].content).toBe('Cloned message');
    });
  });

  describe('established-fork hydration', () => {
    it('hydrates as source prefix through resumeAt plus fork-only turns', async () => {
      const sourceThreadId = 'source-thread-ef';
      const forkThreadId = 'fork-thread-ef';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      // Source transcript: 3 turns
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-3' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:06.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:07.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA3' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:08.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-3' } }),
        ].join('\n'),
        'utf-8',
      );

      // Fork transcript: copied turns 1-3 + new fork turn
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
        [
          // Copied source turns (have same turn IDs)
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-2' } }),
          // New fork-only turn
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'fork-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ForkQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ForkA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fork-turn-1' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-ef',
        providerId: 'codex',
        title: 'Established Fork',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: forkThreadId,
          sessionFilePath: path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
          forkSource: { sessionId: sourceThreadId, resumeAt: 'src-turn-2' },
        },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      await service.hydrateConversationHistory(conversation, null);

      // Expected: source prefix (turns 1+2) + fork-only turn
      // = SrcQ1, SrcA1, SrcQ2, SrcA2, ForkQ1, ForkA1
      expect(conversation.messages).toHaveLength(6);
      expect(conversation.messages[0].content).toBe('SrcQ1');
      expect(conversation.messages[1].content).toBe('SrcA1');
      expect(conversation.messages[2].content).toBe('SrcQ2');
      expect(conversation.messages[3].content).toBe('SrcA2');
      expect(conversation.messages[4].content).toBe('ForkQ1');
      expect(conversation.messages[5].content).toBe('ForkA1');
    });

    it('does not widen established-fork history when resumeAt is missing', async () => {
      const sourceThreadId = 'source-thread-ef-missing';
      const forkThreadId = 'fork-thread-ef-missing';
      const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
      fs.mkdirSync(sessionsDir, { recursive: true });

      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${sourceThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-2' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:03.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA2' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-2' } }),
        ].join('\n'),
        'utf-8',
      );

      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
        [
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SrcQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SrcA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'src-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'fork-turn-1' } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ForkQ1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ForkA1' }] } }),
          JSON.stringify({ timestamp: '2026-03-27T01:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'fork-turn-1' } }),
        ].join('\n'),
        'utf-8',
      );

      const conversation: Conversation = {
        id: 'conv-ef-missing',
        providerId: 'codex',
        title: 'Established Fork Missing Checkpoint',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        sessionId: null,
        providerState: {
          threadId: forkThreadId,
          sessionFilePath: path.join(sessionsDir, `rollout-2026-03-27T00-00-00-${forkThreadId}.jsonl`),
          forkSource: { sessionId: sourceThreadId, resumeAt: 'src-turn-missing' },
        },
        messages: [],
      };

      const service = new CodexConversationHistoryService();
      await service.hydrateConversationHistory(conversation, null);

      expect(conversation.messages).toEqual([]);
    });
  });

  it('retries hydration after an empty transcript parse', async () => {
    const threadId = 'thread-789';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(transcriptPath, '', 'utf-8');

    const conversation: Conversation = {
      id: 'conv-3',
      providerId: 'codex',
      title: 'Eventually Written Transcript',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: transcriptPath },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);
    expect(conversation.messages).toEqual([]);

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Second prompt' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Second answer' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Second prompt',
    });
  });
});
