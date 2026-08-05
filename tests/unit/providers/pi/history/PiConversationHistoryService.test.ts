import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Conversation } from '@/core/types';
import { PiConversationHistoryService } from '@/providers/pi/history/PiConversationHistoryService';

function createConversation(sessionFile: string): Conversation {
  return {
    createdAt: 1,
    id: 'conv-1',
    messages: [],
    providerId: 'pi',
    providerState: { sessionFile, sessionId: 's1' },
    sessionId: 's1',
    title: 'Pi',
    updatedAt: 1,
  };
}

describe('PiConversationHistoryService', () => {
  it('hydrates from providerState sessionFile', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    const sessionFile = path.join(dir, 'session.jsonl');
    await fs.writeFile(sessionFile, JSON.stringify({
      id: 'u1',
      message: { content: 'Hello', role: 'user' },
      type: 'entry',
    }));
    const conversation = createConversation(sessionFile);
    const service = new PiConversationHistoryService();

    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({
      content: 'Hello',
      role: 'user',
    });
  });

  it('rejects an out-of-root metadata path and re-resolves by logical session id', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-home-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-outside-'));
    const trustedDir = path.join(home, '.pi', 'agent', 'sessions');
    await fs.mkdir(trustedDir, { recursive: true });
    const trustedFile = path.join(trustedDir, 's1.jsonl');
    const outsideFile = path.join(outside, 's1.jsonl');
    await fs.writeFile(trustedFile, JSON.stringify({
      id: 'trusted',
      message: { content: 'Trusted', role: 'user' },
      type: 'entry',
    }));
    await fs.writeFile(outsideFile, JSON.stringify({
      id: 'outside',
      message: { content: 'Outside', role: 'user' },
      type: 'entry',
    }));
    const conversation = createConversation(outsideFile);
    conversation.providerState!.futureResumeCursor = { token: 'cursor-1' };

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: home } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Trusted']);
    expect(conversation.providerState).toEqual({
      futureResumeCursor: { token: 'cursor-1' },
      sessionFile: trustedFile,
      sessionId: 's1',
    });
  });

  it('hydrates trusted file-only Pi sessions without a logical session id', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-file-only-'));
    const trustedDir = path.join(home, '.pi', 'agent', 'sessions');
    await fs.mkdir(trustedDir, { recursive: true });
    const sessionFile = path.join(trustedDir, 'file-only.jsonl');
    await fs.writeFile(sessionFile, JSON.stringify({
      id: 'file-only',
      message: { content: 'File only', role: 'user' },
      type: 'entry',
    }));
    const conversation = createConversation(sessionFile);
    conversation.providerState = { sessionFile };
    conversation.sessionId = null;

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: home } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['File only']);
    expect(conversation.providerState).toEqual({ sessionFile });
  });

  it('hydrates detached previous sessions without making them active resume state', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-detached-'));
    const trustedDir = path.join(home, '.pi', 'agent', 'sessions');
    await fs.mkdir(trustedDir, { recursive: true });
    const sessionFile = path.join(trustedDir, 'detached.jsonl');
    await fs.writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'detached-session' }),
      JSON.stringify({
        id: 'u1',
        message: { content: 'Detached history', role: 'user', timestamp: 1 },
        type: 'message',
      }),
    ].join('\n'));
    const conversation = createConversation(sessionFile);
    conversation.providerState = {
      previousSessions: [{
        leafEntryId: 'u1',
        sessionFile,
        sessionId: 'detached-session',
      }],
    };
    conversation.sessionId = null;
    const service = new PiConversationHistoryService();

    await service.hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: home } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Detached history']);
    expect(service.resolveSessionIdForConversation(conversation)).toBe(sessionFile);
    expect(conversation.providerState).toEqual({
      previousSessions: [{
        leafEntryId: 'u1',
        sessionFile,
        sessionId: 'detached-session',
      }],
    });
  });

  it('hydrates previous and active Pi session segments in chronological order', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-segments-'));
    const trustedDir = path.join(home, '.pi', 'agent', 'sessions');
    await fs.mkdir(trustedDir, { recursive: true });
    const previousFile = path.join(trustedDir, 'previous.jsonl');
    const activeFile = path.join(trustedDir, 'active.jsonl');
    await fs.writeFile(previousFile, [
      JSON.stringify({ type: 'session', id: 'previous-session' }),
      JSON.stringify({
        id: 'previous-user',
        message: { content: 'Previous', role: 'user', timestamp: 1 },
        type: 'message',
      }),
    ].join('\n'));
    await fs.writeFile(activeFile, [
      JSON.stringify({ type: 'session', id: 'active-session' }),
      JSON.stringify({
        id: 'active-user',
        message: { content: 'Active', role: 'user', timestamp: 2 },
        type: 'message',
      }),
    ].join('\n'));
    const conversation = createConversation(activeFile);
    conversation.providerState = {
      previousSessions: [{
        leafEntryId: 'previous-user',
        sessionFile: previousFile,
        sessionId: 'previous-session',
      }],
      sessionFile: activeFile,
      sessionId: 'active-session',
    };
    conversation.sessionId = 'active-session';

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: home } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Previous', 'Active']);
  });

  it('preserves unrelated id-less messages from different session segments', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-idless-segments-'));
    const trustedDir = path.join(home, '.pi', 'agent', 'sessions');
    await fs.mkdir(trustedDir, { recursive: true });
    const previousFile = path.join(trustedDir, 'previous.jsonl');
    const activeFile = path.join(trustedDir, 'active.jsonl');
    await fs.writeFile(previousFile, [
      JSON.stringify({ type: 'session', id: 'previous-session' }),
      JSON.stringify({ type: 'custom_message', content: 'Previous notice' }),
    ].join('\n'));
    await fs.writeFile(activeFile, [
      JSON.stringify({ type: 'session', id: 'active-session' }),
      JSON.stringify({ type: 'custom_message', content: 'Active notice' }),
    ].join('\n'));
    const conversation = createConversation(activeFile);
    conversation.providerState = {
      previousSessions: [{
        sessionFile: previousFile,
        sessionId: 'previous-session',
      }],
      sessionFile: activeFile,
      sessionId: 'active-session',
    };

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: home } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual([
      'Previous notice',
      'Active notice',
    ]);
  });

  it('builds a fork from the segment that contains the selected checkpoint', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-segment-'));
    const trustedDir = path.join(home, '.pi', 'agent', 'sessions');
    await fs.mkdir(trustedDir, { recursive: true });
    const previousFile = path.join(trustedDir, 'previous.jsonl');
    const activeFile = path.join(trustedDir, 'active.jsonl');
    await fs.writeFile(previousFile, [
      JSON.stringify({ type: 'session', id: 'previous-session' }),
      JSON.stringify({
        id: 'previous-assistant',
        message: { content: 'Previous', role: 'assistant', timestamp: 1 },
        type: 'message',
      }),
    ].join('\n'));
    await fs.writeFile(activeFile, [
      JSON.stringify({ type: 'session', id: 'active-session' }),
      JSON.stringify({
        id: 'active-assistant',
        message: { content: 'Active', role: 'assistant', timestamp: 2 },
        type: 'message',
      }),
    ].join('\n'));
    const providerState = {
      previousSessions: [{
        leafEntryId: 'previous-assistant',
        sessionFile: previousFile,
        sessionId: 'previous-session',
      }],
      sessionFile: activeFile,
      sessionId: 'active-session',
    };
    const conversation = createConversation(activeFile);
    conversation.providerState = providerState;
    conversation.sessionId = 'active-session';
    const service = new PiConversationHistoryService();

    await service.hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: home } },
    );

    await expect(service.buildForkProviderState(
      'active-session',
      'previous-assistant',
      providerState,
    )).resolves.toEqual({
      forkSource: { sessionId: 'previous-session', resumeAt: 'previous-assistant' },
      forkSourceSessionFile: previousFile,
    });
    await expect(service.buildForkProviderState(
      'active-session',
      'active-assistant',
      providerState,
    )).resolves.toEqual({
      forkSource: { sessionId: 'active-session', resumeAt: 'active-assistant' },
      forkSourceSessionFile: activeFile,
    });
  });

  it('does not probe an archived fork source that fails path identity validation', async () => {
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-vault-'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-safe-home-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-unsafe-'));
    const trustedDir = path.join(home, '.pi', 'agent', 'sessions');
    await fs.mkdir(trustedDir, { recursive: true });
    const activeFile = path.join(trustedDir, 'active.jsonl');
    const outsideFile = path.join(outside, 'previous.jsonl');
    await fs.writeFile(activeFile, [
      JSON.stringify({ type: 'session', id: 'active-session', cwd: vault }),
      JSON.stringify({ id: 'active-assistant', type: 'message', message: { role: 'assistant' } }),
    ].join('\n'));
    await fs.writeFile(outsideFile, [
      JSON.stringify({ type: 'session', id: 'previous-session', cwd: outside }),
      JSON.stringify({ id: 'target-assistant', type: 'message', message: { role: 'assistant' } }),
    ].join('\n'));
    const service = new PiConversationHistoryService();

    await expect((service.buildForkProviderState as any)(
      'active-session',
      'target-assistant',
      {
        previousSessions: [{
          sessionFile: outsideFile,
          sessionId: 'previous-session',
        }],
        sessionFile: activeFile,
        sessionId: 'active-session',
      },
      vault,
      { environment: { HOME: home }, vaultPath: vault },
    )).resolves.toEqual({
      forkSource: { sessionId: 'active-session', resumeAt: 'target-assistant' },
      forkSourceSessionFile: activeFile,
    });
  });

  it('hydrates an archived transcript after the configured session root changes', async () => {
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-archive-vault-'));
    const oldRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-archive-old-'));
    const newRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-archive-new-'));
    const safeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-archive-home-'));
    const sessionFile = path.join(oldRoot, 'archived.jsonl');
    await fs.writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'archived-session', cwd: vault }),
      JSON.stringify({
        id: 'archived-user',
        message: { content: 'Archived history', role: 'user', timestamp: 1 },
        type: 'message',
      }),
    ].join('\n'));
    const conversation = createConversation(sessionFile);
    conversation.providerState = {
      previousSessions: [{
        leafEntryId: 'archived-user',
        sessionFile,
        sessionId: 'archived-session',
      }],
    };
    conversation.sessionId = null;

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      vault,
      {
        environment: {
          HOME: safeHome,
          PI_CODING_AGENT_SESSION_DIR: newRoot,
        },
      },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Archived history']);
    expect(conversation.providerState).toEqual({
      previousSessions: [{
        leafEntryId: 'archived-user',
        sessionFile,
        sessionId: 'archived-session',
      }],
    });
  });

  it('does not replace an archived path with a mismatched logical-id candidate', async () => {
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-identity-vault-'));
    const oldRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-identity-old-'));
    const newRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-identity-new-'));
    const safeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-identity-home-'));
    const archivedPath = path.join(oldRoot, 'archived-session.jsonl');
    const mismatchedPath = path.join(newRoot, 'archived-session.jsonl');
    await fs.writeFile(mismatchedPath, [
      JSON.stringify({ type: 'session', id: 'different-session', cwd: vault }),
      JSON.stringify({
        id: 'wrong-user',
        message: { content: 'Wrong history', role: 'user', timestamp: 1 },
        type: 'message',
      }),
    ].join('\n'));
    const conversation = createConversation(archivedPath);
    conversation.providerState = {
      previousSessions: [{
        leafEntryId: 'archived-user',
        sessionFile: archivedPath,
        sessionId: 'archived-session',
      }],
    };
    conversation.sessionId = null;

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      vault,
      {
        environment: {
          HOME: safeHome,
          PI_CODING_AGENT_SESSION_DIR: newRoot,
        },
      },
    );

    expect(conversation.messages).toEqual([]);
    expect(conversation.providerState).toEqual({
      previousSessions: [{
        leafEntryId: 'archived-user',
        sessionFile: archivedPath,
        sessionId: 'archived-session',
      }],
    });
  });

  it('accepts a metadata path under the explicitly configured session directory', async () => {
    const configuredDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-configured-'));
    const sessionFile = path.join(configuredDir, 'session.jsonl');
    await fs.writeFile(sessionFile, JSON.stringify({
      id: 'configured',
      message: { content: 'Configured', role: 'user' },
      type: 'entry',
    }));
    const conversation = createConversation(sessionFile);

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { PI_CODING_AGENT_SESSION_DIR: configuredDir } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Configured']);
  });

  it('does not trust a vault-local session root that is a symlink outside the vault', async () => {
    if (process.platform === 'win32') return;

    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-vault-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-symlink-target-'));
    const safeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-safe-home-'));
    const agentDir = path.join(vault, '.pi', 'agent');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.symlink(outside, path.join(agentDir, 'sessions'));
    const outsideFile = path.join(outside, 's1.jsonl');
    await fs.writeFile(outsideFile, JSON.stringify({
      id: 'outside',
      message: { content: 'Outside', role: 'user' },
      type: 'entry',
    }));
    const conversation = createConversation(outsideFile);

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      vault,
      { environment: { HOME: safeHome } },
    );

    expect(conversation.messages).toEqual([]);
  });

  it('builds pending fork state from source session metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-state-'));
    const sessionFile = path.join(dir, 'session.jsonl');
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ id: 'checkpoint', type: 'message', message: { role: 'assistant' } }),
    ].join('\n'));
    await fs.writeFile(sourceFile, [
      JSON.stringify({ type: 'session', id: 'source-session' }),
      JSON.stringify({ id: 'checkpoint', type: 'message', message: { role: 'assistant' } }),
    ].join('\n'));
    const service = new PiConversationHistoryService();
    const conversation = createConversation(sessionFile);
    conversation.providerState = {
      forkSource: { sessionId: 'source-session', resumeAt: 'assistant-1' },
      forkSourceSessionFile: sourceFile,
    };
    conversation.sessionId = null;

    expect(service.isPendingForkConversation(conversation)).toBe(true);
    expect(service.resolveSessionIdForConversation(conversation)).toBe('source-session');
    await expect(service.buildForkProviderState('s1', 'checkpoint', {
      sessionFile,
    })).resolves.toEqual({
      forkSource: { sessionId: 's1', resumeAt: 'checkpoint' },
      forkSourceSessionFile: sessionFile,
    });
    await expect(service.buildForkProviderState('source-session', 'checkpoint', {
      forkSource: { sessionId: 'source-session', resumeAt: 'assistant-1' },
      forkSourceSessionFile: sourceFile,
    })).resolves.toEqual({
      forkSource: { sessionId: 'source-session', resumeAt: 'checkpoint' },
      forkSourceSessionFile: sourceFile,
    });
  });

  it('resolves file-only Pi sessions as fork sources', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-file-fork-'));
    const sessionFile = path.join(dir, 'session.jsonl');
    await fs.writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'file-session' }),
      JSON.stringify({ id: 'checkpoint', type: 'message', message: { role: 'assistant' } }),
    ].join('\n'));
    const service = new PiConversationHistoryService();
    const conversation = createConversation(sessionFile);
    conversation.providerState = { sessionFile };
    conversation.sessionId = null;

    expect(service.resolveSessionIdForConversation(conversation)).toBe(sessionFile);
    await expect(service.buildForkProviderState(sessionFile, 'checkpoint', {
      sessionFile,
    })).resolves.toEqual({
      forkSource: { sessionId: sessionFile, resumeAt: 'checkpoint' },
      forkSourceSessionFile: sessionFile,
    });
  });

  it('hydrates pending forks from the source session truncated at the checkpoint', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-'));
    const sessionFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'source-session' }),
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', type: 'message', message: { role: 'user', content: 'Later' } }),
    ].join('\n'));
    const conversation = createConversation(sessionFile);
    conversation.messages = [];
    conversation.providerState = {
      forkSource: { sessionId: 'source-session', resumeAt: 'a1' },
      forkSourceSessionFile: sessionFile,
    };
    conversation.sessionId = null;
    const service = new PiConversationHistoryService();

    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages.map(message => message.content)).toEqual(['First', 'Done']);
  });

  it('replaces an untrusted pending-fork path with the resolved local source', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-home-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-outside-'));
    const trustedDir = path.join(home, '.pi', 'agent', 'sessions');
    await fs.mkdir(trustedDir, { recursive: true });
    const trustedFile = path.join(trustedDir, 'source-session.jsonl');
    const outsideFile = path.join(outside, 'source-session.jsonl');
    const trustedContent = [
      JSON.stringify({ type: 'session', id: 'source-session' }),
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'Trusted' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
    ].join('\n');
    await fs.writeFile(trustedFile, trustedContent);
    await fs.writeFile(outsideFile, trustedContent.replace('Trusted', 'Outside'));
    const conversation = createConversation(outsideFile);
    conversation.providerState = {
      forkSource: { sessionId: 'source-session', resumeAt: 'a1' },
      forkSourceSessionFile: outsideFile,
    };
    conversation.sessionId = null;

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: home } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Trusted', 'Done']);
    expect(conversation.providerState).toEqual({
      forkSource: { sessionId: 'source-session', resumeAt: 'a1' },
      forkSourceSessionFile: trustedFile,
    });
  });

  it('sanitizes a pending-fork path even when messages are already hydrated', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-loaded-home-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-loaded-outside-'));
    const trustedDir = path.join(home, '.pi', 'agent', 'sessions');
    await fs.mkdir(trustedDir, { recursive: true });
    const trustedFile = path.join(trustedDir, 'source-session.jsonl');
    const outsideFile = path.join(outside, 'source-session.jsonl');
    await fs.writeFile(trustedFile, JSON.stringify({ type: 'session', id: 'source-session' }));
    await fs.writeFile(outsideFile, JSON.stringify({ type: 'session', id: 'source-session' }));
    const conversation = createConversation(outsideFile);
    conversation.messages = [{
      content: 'Already loaded',
      id: 'loaded',
      role: 'user',
      timestamp: 1,
    }];
    conversation.providerState = {
      forkSource: { sessionId: 'source-session', resumeAt: 'a1' },
      forkSourceSessionFile: outsideFile,
    };
    conversation.sessionId = null;

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: home } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Already loaded']);
    expect(conversation.providerState).toEqual({
      forkSource: { sessionId: 'source-session', resumeAt: 'a1' },
      forkSourceSessionFile: trustedFile,
    });
  });

  it('does not hydrate pending forks when the checkpoint is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-missing-'));
    const sessionFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'source-session' }),
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', type: 'message', message: { role: 'user', content: 'Later' } }),
    ].join('\n'));
    const conversation = createConversation(sessionFile);
    conversation.messages = [];
    conversation.providerState = {
      forkSource: { sessionId: 'source-session', resumeAt: 'missing-checkpoint' },
      forkSourceSessionFile: sessionFile,
    };
    conversation.sessionId = null;
    const service = new PiConversationHistoryService();

    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toEqual([]);
  });

  it('sanitizes known fields while preserving unknown provider state', () => {
    const service = new PiConversationHistoryService();
    const conversation = createConversation('/tmp/session.jsonl');
    conversation.providerState = {
      empty: '',
      futureResumeCursor: { token: 'cursor-1' },
      leafEntryId: 'leaf-1',
      parentSession: '/tmp/source.jsonl',
      previousSessions: [
        {
          leafEntryId: 'previous-leaf',
          sessionFile: '/tmp/previous.jsonl',
          sessionId: 'previous-session',
        },
        { sessionId: ' ' },
        { ignored: true },
      ],
      sessionFile: '/tmp/session.jsonl',
      sessionId: 's1',
    };

    expect(service.buildPersistedProviderState?.(conversation)).toEqual({
      empty: '',
      futureResumeCursor: { token: 'cursor-1' },
      leafEntryId: 'leaf-1',
      parentSession: '/tmp/source.jsonl',
      previousSessions: [{
        leafEntryId: 'previous-leaf',
        sessionFile: '/tmp/previous.jsonl',
        sessionId: 'previous-session',
      }],
      sessionFile: '/tmp/session.jsonl',
      sessionId: 's1',
    });
  });

  describe('resolveMissingConversationSession', () => {
    it('removes only the exact stale path before falling back to its logical session id', async () => {
      const conversation = createConversation('/trusted/missing.jsonl');
      conversation.sessionId = '/trusted/missing.jsonl';
      conversation.providerState = {
        futureResumeCursor: { token: 'keep-me' },
        leafEntryId: 'assistant-1',
        parentSession: '/trusted/parent.jsonl',
        sessionFile: '/trusted/missing.jsonl',
        sessionId: 's1',
      };
      const service = new PiConversationHistoryService();

      await expect(service.resolveMissingConversationSession?.(
        conversation,
        '/vault',
        '/trusted/missing.jsonl',
      )).resolves.toBe('reset');

      expect(conversation.sessionId).toBeNull();
      expect(conversation.providerState).toEqual({
        futureResumeCursor: { token: 'keep-me' },
        leafEntryId: 'assistant-1',
        parentSession: '/trusted/parent.jsonl',
        previousSessions: [{
          leafEntryId: 'assistant-1',
          sessionFile: '/trusted/missing.jsonl',
          sessionId: '/trusted/missing.jsonl',
        }],
        sessionId: 's1',
      });
      expect(service.resolveSessionIdForConversation(conversation)).toBe('s1');
    });

    it('does not restore a stale path after reset and persistence reconstruction', async () => {
      const missingPath = '/trusted/missing.jsonl';
      const conversation = createConversation(missingPath);
      conversation.providerState = {
        futureResumeCursor: { token: 'keep-me' },
        leafEntryId: 'assistant-1',
        parentSession: '/trusted/parent.jsonl',
        sessionFile: missingPath,
        sessionId: missingPath,
      };
      conversation.sessionId = missingPath;
      const service = new PiConversationHistoryService();

      await expect(service.resolveMissingConversationSession?.(
        conversation,
        '/vault',
        missingPath,
      )).resolves.toBe('reset');

      const recreatedConversation: Conversation = {
        ...conversation,
        providerState: service.buildPersistedProviderState?.(conversation),
      };
      expect(recreatedConversation.sessionId).toBeNull();
      expect(recreatedConversation.providerState).toEqual({
        futureResumeCursor: { token: 'keep-me' },
        previousSessions: [{
          leafEntryId: 'assistant-1',
          sessionFile: missingPath,
          sessionId: missingPath,
        }],
      });
      expect(
        new PiConversationHistoryService().resolveSessionIdForConversation(
          recreatedConversation,
        ),
      ).toBe(missingPath);
    });

    it('clears an exact stale logical binding while preserving unknown state and native files', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-missing-reset-'));
      const nativeFile = path.join(dir, 'unrelated.jsonl');
      const nativeContent = '{"type":"session","id":"other"}\n';
      await fs.writeFile(nativeFile, nativeContent);
      const conversation = createConversation('/trusted/absent.jsonl');
      conversation.providerState = {
        futureResumeCursor: { token: 'keep-me' },
        leafEntryId: 'assistant-1',
        parentSession: '/trusted/parent.jsonl',
        sessionId: 's1',
      };
      const service = new PiConversationHistoryService();

      await expect(service.resolveMissingConversationSession?.(
        conversation,
        '/vault',
        's1',
      )).resolves.toBe('reset');

      expect(conversation.sessionId).toBeNull();
      expect(conversation.providerState).toEqual({
        futureResumeCursor: { token: 'keep-me' },
        previousSessions: [{
          leafEntryId: 'assistant-1',
          sessionId: 's1',
        }],
      });
      await expect(fs.readFile(nativeFile, 'utf8')).resolves.toBe(nativeContent);
    });

    it('preserves a newer binding when the reported target is not current', async () => {
      const conversation = createConversation('/trusted/current.jsonl');
      conversation.providerState = {
        futureResumeCursor: { token: 'keep-me' },
        sessionFile: '/trusted/current.jsonl',
        sessionId: 'current-id',
      };
      const providerState = conversation.providerState;
      const service = new PiConversationHistoryService();

      await expect(service.resolveMissingConversationSession?.(
        conversation,
        '/vault',
        'stale-id',
      )).resolves.toBe('preserve');

      expect(conversation.sessionId).toBe('s1');
      expect(conversation.providerState).toBe(providerState);
    });
  });
});
