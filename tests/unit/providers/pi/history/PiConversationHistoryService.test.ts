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

    await new PiConversationHistoryService().hydrateConversationHistory(
      conversation,
      null,
      { environment: { HOME: home } },
    );

    expect(conversation.messages.map(message => message.content)).toEqual(['Trusted']);
    expect(conversation.providerState).toEqual({ sessionFile: trustedFile, sessionId: 's1' });
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

  it('builds pending fork state from source session metadata', () => {
    const service = new PiConversationHistoryService();
    const conversation = createConversation('/tmp/session.jsonl');
    conversation.providerState = {
      forkSource: { sessionId: 'source-session', resumeAt: 'assistant-1' },
      forkSourceSessionFile: '/tmp/source.jsonl',
    };
    conversation.sessionId = null;

    expect(service.isPendingForkConversation(conversation)).toBe(true);
    expect(service.resolveSessionIdForConversation(conversation)).toBe('source-session');
    expect(service.buildForkProviderState('s1', 'checkpoint', {
      sessionFile: '/tmp/session.jsonl',
    })).toEqual({
      forkSource: { sessionId: 's1', resumeAt: 'checkpoint' },
      forkSourceSessionFile: '/tmp/session.jsonl',
    });
    expect(service.buildForkProviderState('source-session', 'checkpoint', {
      forkSource: { sessionId: 'source-session', resumeAt: 'assistant-1' },
      forkSourceSessionFile: '/tmp/source.jsonl',
    })).toEqual({
      forkSource: { sessionId: 'source-session', resumeAt: 'checkpoint' },
      forkSourceSessionFile: '/tmp/source.jsonl',
    });
  });

  it('resolves file-only Pi sessions as fork sources', () => {
    const service = new PiConversationHistoryService();
    const conversation = createConversation('/tmp/session.jsonl');
    conversation.providerState = { sessionFile: '/tmp/session.jsonl' };
    conversation.sessionId = null;

    expect(service.resolveSessionIdForConversation(conversation)).toBe('/tmp/session.jsonl');
    expect(service.buildForkProviderState('/tmp/session.jsonl', 'checkpoint', {
      sessionFile: '/tmp/session.jsonl',
    })).toEqual({
      forkSource: { sessionId: '/tmp/session.jsonl', resumeAt: 'checkpoint' },
      forkSourceSessionFile: '/tmp/session.jsonl',
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

  it('sanitizes persisted provider state', () => {
    const service = new PiConversationHistoryService();
    const conversation = createConversation('/tmp/session.jsonl');
    conversation.providerState = {
      empty: '',
      leafEntryId: 'leaf-1',
      parentSession: '/tmp/source.jsonl',
      sessionFile: '/tmp/session.jsonl',
      sessionId: 's1',
    };

    expect(service.buildPersistedProviderState?.(conversation)).toEqual({
      leafEntryId: 'leaf-1',
      parentSession: '/tmp/source.jsonl',
      sessionFile: '/tmp/session.jsonl',
      sessionId: 's1',
    });
  });
});
