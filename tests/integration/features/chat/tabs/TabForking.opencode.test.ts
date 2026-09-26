import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import spawn from 'cross-spawn';

jest.mock('cross-spawn', () => jest.fn());

import { createForkTestEnvironment, type ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import { createNativeRPCProcess, createNativeVersionProcess } from '@test/helpers/providers/NativeRPCTestProcess';

import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

interface NativeMessage {
  info: { id: string; role: string };
  parts: Array<{ type: string; text: string }>;
}

// OpenCode v1.18.31 ACP forks all messages and assigns new IDs to the copies.
async function createNativeOpencode(env: ForkTestEnvironment) {
  const sessions = new Map<string, NativeMessage[]>([['ses-source', []]]);
  const prompts: Array<{ sessionId: string; context: string[] }> = [];
  const processes: ReturnType<typeof createNativeRPCProcess>[] = [];
  new DatabaseSync(path.join(env.root, 'opencode.db')).close();
  let ordinal = 0;
  let forkOrdinal = 0;
  let rejectFork = false;
  let supportsFork = true;
  jest.mocked(spawn).mockImplementation((_command, args) => {
    if (args?.includes('--version')) return createNativeVersionProcess('1.18.31');
    const proc = createNativeRPCProcess((method, params, notify) => {
      if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: supportsFork ? { fork: {} } : {} } };
      if (method === 'session/fork') {
        if (rejectFork) throw new Error('Native fork failed');
        const messages = sessions.get(params.sessionId)!;
        const sessionId = `ses-child-${++forkOrdinal}`;
        sessions.set(sessionId, messages.map((message, index) => ({
          ...message, info: { ...message.info, id: `msg-child-${forkOrdinal}-${index}` },
        })));
        const db = new DatabaseSync(path.join(env.root, 'opencode.db'));
        try {
          db.exec('CREATE TABLE IF NOT EXISTS message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE IF NOT EXISTS part(id TEXT, session_id TEXT, message_id TEXT, data TEXT);');
          sessions.get(sessionId)!.forEach((message, index) => {
            db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(message.info.id, sessionId, index, JSON.stringify(message.info));
            message.parts.forEach((part, partIndex) => db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)')
              .run(`${message.info.id}-${partIndex}`, sessionId, message.info.id, JSON.stringify(part)));
          });
        } finally { db.close(); }
        // Fork replay must not become live output or trigger a new prompt.
        notify('session/update', { sessionId, update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Replayed history' },
        } });
        return { sessionId };
      }
      if (method === 'session/new') return { sessionId: 'ses-source' };
      if (method === 'session/load') {
        if (!sessions.has(params.sessionId)) throw new Error('Session not found');
        return {};
      }
      if (method === 'session/set_config_option') return {};
      if (method === 'session/prompt') {
        const messages = sessions.get(params.sessionId)!;
        prompts.push({ sessionId: params.sessionId, context: messages.flatMap(message => message.parts.map(part => part.text)) });
        const id = ++ordinal;
        messages.push(
          { info: { id: `msg-user-${id}`, role: 'user' }, parts: [{ type: 'text', text: params.prompt[0].text }] },
          { info: { id: `msg-assistant-${id}`, role: 'assistant' }, parts: [{ type: 'text', text: `Reply ${id}` }] },
        );
        notify('session/update', { sessionId: params.sessionId, update: {
          sessionUpdate: 'agent_message_chunk', messageId: `msg-assistant-${id}`, content: { type: 'text', text: `Reply ${id}` },
        } });
        return { stopReason: 'end_turn' };
      }
      throw new Error(`Unexpected OpenCode method: ${method}`);
    });
    processes.push(proc);
    return proc;
  });
  env.host.settings.providerConfigs.opencode = {
    enabled: true, visibleModels: ['test/model'], discoveredModels: [{ rawId: 'test/model', label: 'Test' }],
    environmentVariables: `OPENCODE_DB=${path.join(env.root, 'opencode.db')}`,
  };
  return {
    backend: new OpencodeExecutionBackend(env.host, { serverService: new OpencodeServerService() }), sessions, prompts, processes,
    rejectFork: () => { rejectFork = true; },
    disableFork: () => { supportsFork = false; },
  };
}

describe('OpenCode fork integration', () => {
  let env: ForkTestEnvironment;
  let native: Awaited<ReturnType<typeof createNativeOpencode>>;
  beforeEach(async () => { env = await createForkTestEnvironment(); native = await createNativeOpencode(env); });
  afterEach(async () => { await env.dispose(); jest.mocked(spawn).mockReset(); });

  it('forks the latest reply immediately and continues source and child independently', async () => {
    const source = await env.open(native.backend);
    await env.send(source, 'Remember apples');
    const selected = await env.send(source, 'Remember pears');
    const sourceHistory = structuredClone(native.sessions.get('ses-source'));
    const child = await env.fork(source, selected);
    expect(child).toBeDefined();
    expect(child!.messages).toHaveLength(4);
    const fork = await env.open(native.backend, child!);
    await env.send(fork, 'Continue here');
    expect(native.prompts.at(-1)).toEqual({ sessionId: 'ses-child-1', context: ['Remember apples', 'Reply 1', 'Remember pears', 'Reply 2'] });
    expect(child!.sessionId).toBe('ses-child-1');
    expect(native.sessions.get('ses-source')).toEqual(sourceHistory);
    await env.send(source, 'Keep original going');
    expect(native.prompts.at(-1)?.context).toEqual(['Remember apples', 'Reply 1', 'Remember pears', 'Reply 2']);
  });

  it('forks an unsent child again after persistence', async () => {
    const source = await env.open(native.backend);
    const selected = await env.send(source, 'Remember apples');
    const child = await env.fork(source, selected);
    expect(child).toBeDefined();
    const service = new OpencodeConversationHistoryService();
    const restored = { ...child!, providerState: JSON.parse(JSON.stringify(service.buildPersistedProviderState(child!))) };
    await service.hydrateConversationHistory(restored, env.root);
    expect(restored.messages[1].assistantMessageId).toBe('msg-child-1-1');
    const fork = await env.open(native.backend, restored);
    const nested = await env.fork(fork, restored.messages[1]);
    expect(nested).toBeDefined();
    const nestedTab = await env.open(native.backend, nested!);
    await env.send(nestedTab, 'Continue nested');
    expect(native.prompts.at(-1)).toEqual({ sessionId: 'ses-child-2', context: ['Remember apples', 'Reply 1'] });
  });

  it('declines older replies without creating a child', async () => {
    const source = await env.open(native.backend);
    const selected = await env.send(source, 'Remember apples');
    await env.send(source, 'Remember pears');
    expect(await env.fork(source, selected)).toBeUndefined();
    expect([...native.sessions.keys()]).toEqual(['ses-source']);
    expect(env.repository.list()).toHaveLength(1);
  });

  it('fails clearly on runtimes that do not advertise ACP forking', async () => {
    const source = await env.open(native.backend);
    const selected = await env.send(source, 'Remember apples');
    native.disableFork();
    await expect(env.fork(source, selected)).rejects.toThrow(/fork.*support|support.*fork/i);
    expect([...native.sessions.keys()]).toEqual(['ses-source']);
    expect(native.processes.at(-1)?.killed).toBe(true);
  });

  it('keeps a configured CLI sibling Node directory on PATH when forking', async () => {
    const source = await env.open(native.backend);
    const selected = await env.send(source, 'Remember apples');
    const cliPath = path.join(env.root, 'opencode');
    await fs.writeFile(cliPath, '#!/usr/bin/env node\n');
    await fs.writeFile(path.join(env.root, process.platform === 'win32' ? 'node.exe' : 'node'), '');
    const settings = { providerConfigs: { opencode: { cliPath } } };
    const service = new OpencodeConversationHistoryService();
    await service.buildForkProviderState('ses-source', selected.assistantMessageId!, source.conversation.providerState, env.root, {
      settings, environment: { ...process.env, OPENCODE_DB: path.join(env.root, 'opencode.db'), PATH: '/restricted' },
    });
    const launch = jest.mocked(spawn).mock.calls.at(-1)!;
    expect(launch[0]).toBe(cliPath);
    expect(launch[2]?.env?.PATH?.split(path.delimiter)).toContain(env.root);
  });

  it('reports native fork errors and shuts down the auxiliary server', async () => {
    const source = await env.open(native.backend);
    const selected = await env.send(source, 'Remember apples');
    native.rejectFork();
    await expect(env.fork(source, selected)).rejects.toThrow(/fork/i);
    expect(native.processes.at(-1)?.killed).toBe(true);
    expect(env.repository.list()).toHaveLength(1);
  });
});
