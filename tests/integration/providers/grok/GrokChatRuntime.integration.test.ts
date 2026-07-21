import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderCapabilities } from '@/core/providers/types';
import { GrokChatRuntime } from '@/providers/grok/runtime/GrokChatRuntime';

const CAPABILITIES: ProviderCapabilities = {
  providerId: 'grok',
  reasoningControl: 'effort',
  supportsFork: false,
  supportsImageAttachments: false,
  supportsInstructionMode: true,
  supportsLegacySubagentTools: false,
  supportsMcpTools: false,
  supportsNativeHistory: true,
  supportsPersistentRuntime: true,
  supportsPlanMode: false,
  supportsProviderCommands: true,
  supportsRewind: false,
  supportsTurnSteer: false,
};

function createHost(vaultPath: string): ProviderHost {
  const settings = {
    effortLevel: 'high',
    model: 'grok/grok-4.5',
    permissionMode: 'normal',
    providerConfigs: { grok: { enabled: true } },
  };
  return {
    app: { vault: { adapter: { basePath: vaultPath } } },
    manifest: { version: 'integration-test' },
    settings,
    mutateSettings: jest.fn(async mutation => mutation(settings as never)),
    mutateSettingsConditionally: jest.fn(async mutation => { await mutation(settings as never); }),
  } as unknown as ProviderHost;
}

async function collect(runtime: GrokChatRuntime, text: string): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of runtime.query(runtime.prepareTurn({ text }))) chunks.push(chunk);
  return chunks;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fake Grok agent');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('GrokChatRuntime JSON-RPC integration', () => {
  let tempDirectory = '';

  afterEach(async () => {
    if (tempDirectory) await fs.rm(tempDirectory, { force: true, recursive: true });
  });

  it('orders initialize/new/prompt/update/cancel and initializes/load on resume', async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-grok-agent-'));
    const logPath = path.join(tempDirectory, 'requests.jsonl');
    const executablePath = path.join(tempDirectory, 'fake-grok');
    await fs.writeFile(executablePath, fakeAgentSource(logPath), 'utf8');
    await fs.chmod(executablePath, 0o755);
    const host = createHost(tempDirectory);

    const first = new GrokChatRuntime(host, {
      capabilities: CAPABILITIES,
      cliResolver: { resolveFromSettings: () => executablePath },
    });
    const chunks = await collect(first, 'live');
    expect(chunks).toContainEqual({ content: 'fake live response', type: 'text' });
    expect(first.getSessionId()).toBe('fake-session');

    const pending = first.query(first.prepareTurn({ text: 'hold' }));
    const next = pending.next();
    await waitFor(async () => (await readMethods(logPath)).filter(method => method === 'session/prompt').length === 2);
    first.cancel();
    const followUp = collect(first, 'follow-up');
    await expect(next).resolves.toEqual({ done: false, value: { type: 'done' } });
    const followUpChunks = await followUp;
    expect(followUpChunks).toContainEqual({ content: 'fake follow-up response', type: 'text' });
    expect(followUpChunks).not.toContainEqual(expect.objectContaining({
      content: expect.stringContaining('late cancelled response'),
    }));
    expect(first.getSessionId()).toBe('fake-session');
    await waitFor(async () => (await readMethods(logPath)).filter(method => method === 'initialize').length === 2);
    const methods = await readMethods(logPath);
    expect(methods).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
      'session/prompt',
      'session/cancel',
      'process/SIGTERM',
      'initialize',
      'session/load',
      'session/prompt',
    ]);
    expect(methods).not.toContain('authenticate');
    first.cleanup();
  });

  it('renders and persists mirrored text and tool events once while preserving repeats', async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-grok-agent-'));
    const logPath = path.join(tempDirectory, 'requests.jsonl');
    const executablePath = path.join(tempDirectory, 'fake-grok');
    await fs.writeFile(executablePath, fakeAgentSource(logPath), 'utf8');
    await fs.chmod(executablePath, 0o755);
    const runtime = new GrokChatRuntime(createHost(tempDirectory), {
      capabilities: CAPABILITIES,
      cliResolver: { resolveFromSettings: () => executablePath },
    });

    const chunks = await collect(runtime, 'mirrors');
    const records = chunks.map(chunk => chunk as Record<string, unknown>);
    expect(records.filter(chunk => chunk.type === 'text').map(chunk => chunk.content)).toEqual([
      '[A]', '[R]', '[R]', '[X]', '[X]', '[A]',
    ]);
    const toolUses = records.filter(chunk => chunk.type === 'tool_use' && chunk.id === 'tool-mirror');
    const toolResults = records.filter(chunk => chunk.type === 'tool_result' && chunk.id === 'tool-mirror');
    expect(toolUses).toHaveLength(2);
    expect(new Set(toolUses.map(chunk => chunk.id))).toEqual(new Set(['tool-mirror']));
    expect(toolResults).toHaveLength(1);
    const persistedTools = new Map(toolUses.map(tool => [tool.id, tool]));
    expect(JSON.parse(JSON.stringify([...persistedTools.values()]))).toEqual([
      expect.objectContaining({
        id: 'tool-mirror',
        providerPayload: expect.objectContaining({ rawName: 'read_file' }),
      }),
    ]);
    runtime.cleanup();
  });
});

async function readMethods(logPath: string): Promise<string[]> {
  const content = await fs.readFile(logPath, 'utf8').catch(() => '');
  return content.split('\n').filter(Boolean).map((line) => (
    JSON.parse(line) as { method: string }
  ).method);
}

function fakeAgentSource(logPath: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const actualLogPath = ${JSON.stringify(logPath)};
const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
const respond = (message, result) => write({ id: message.id, jsonrpc: '2.0', result });
const session = {
  sessionId: 'fake-session',
  models: {
    currentModelId: 'grok-4.5',
    availableModels: [{ modelId: 'grok-4.5', name: 'Grok 4.5', _meta: {
      reasoningEfforts: ['high', 'medium'], supportsReasoningEffort: true,
    } }],
  },
};
let heldPrompt = null;
process.on('SIGTERM', () => {
  fs.appendFileSync(actualLogPath, JSON.stringify({ method: 'process/SIGTERM' }) + '\\n');
  process.exit(0);
});
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (!message.method) return;
  fs.appendFileSync(actualLogPath, JSON.stringify({ method: message.method }) + '\\n');
  if (message.method === 'session/cancel') {
    write({ jsonrpc: '2.0', method: '_x.ai/session/update', params: {
      sessionId: 'fake-session',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'assistant-late',
        content: { type: 'text', text: 'late cancelled response' } },
    } });
    if (heldPrompt) respond(heldPrompt, { stopReason: 'cancelled' });
    heldPrompt = null;
    return;
  }
  if (message.id === undefined) return;
  if (message.method === 'initialize') return respond(message, {
    protocolVersion: 1,
    agentInfo: { name: 'fake-grok', version: '0.2.106' },
    agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
  });
  if (message.method === 'session/new' || message.method === 'session/load') {
    return respond(message, session);
  }
  if (message.method === 'session/set_model') return respond(message, { _meta: {} });
  if (message.method === 'session/prompt') {
    if (message.params.prompt[0].text === 'hold') {
      heldPrompt = message;
      return;
    }
    if (message.params.prompt[0].text === 'mirrors') {
      const notify = (method, update) => write({ jsonrpc: '2.0', method, params: {
        sessionId: 'fake-session', update,
      } });
      const text = content => ({ sessionUpdate: 'agent_message_chunk',
        messageId: 'assistant-' + content, content: { type: 'text', text: content } });
      const mirroredText = text('[A]');
      notify('session/update', mirroredText);
      notify('_x.ai/session/update', mirroredText);
      notify('session/update', text('[R]'));
      notify('session/update', text('[R]'));
      notify('session/update', text('[X]'));
      notify('_x.ai/session/update', { sessionUpdate: 'future_intervening_update' });
      notify('_x.ai/session/update', text('[X]'));
      notify('session/update', mirroredText);
      const toolCall = { sessionUpdate: 'tool_call', toolCallId: 'tool-mirror',
        title: 'read_file', status: 'in_progress', rawInput: { path: 'note.md' } };
      const toolResult = { sessionUpdate: 'tool_call_update', toolCallId: 'tool-mirror',
        status: 'completed', rawOutput: { content: 'sanitized' } };
      notify('session/update', toolCall);
      notify('_x.ai/session/update', toolCall);
      notify('session/update', toolResult);
      notify('_x.ai/session/update', toolResult);
      return respond(message, { stopReason: 'end_turn', userMessageId: 'user-mirror' });
    }
    const responseText = message.params.prompt[0].text === 'follow-up'
      ? 'fake follow-up response'
      : 'fake live response';
    write({ jsonrpc: '2.0', method: '_x.ai/session/update', params: {
      sessionId: 'fake-session',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'assistant-live',
        content: { type: 'text', text: responseText } },
    } });
    return respond(message, { stopReason: 'end_turn', userMessageId: 'user-live' });
  }
  respond(message, {});
});
`;
}
