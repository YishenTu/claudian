import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { testDate } from '@test/helpers/testClock';

import type { ProviderExecutionContext } from '@/core/execution';
import { decodeRecoveryPrompt } from '@/core/prompt/recoveryPrompt';
import type { ChatMessage } from '@/core/types';
import { PiExecutionBackend } from '@/providers/pi/execution/PiExecutionBackend';
import { PiRPCSessionKernel } from '@/providers/pi/execution/PiExecutionKernel';

const MODEL = 'pi:anthropic/claude-sonnet-4';
const selection = (selectedText: string): ProviderExecutionContext => ({
  selections: [{ kind: 'editor', selection: { mode: 'selection', notePath: 'note.md', selectedText } }],
});
const previous = selection('previous selection');
const cases: Array<{ label: string; context?: ProviderExecutionContext; expected: string | null; nativeFailure?: boolean }> = [
  { label: 'changed selection', context: selection('current selection'), expected: 'Refactor this\n\n<editor_selection path="note.md">\n<![CDATA[current selection]]>\n</editor_selection>' },
  { label: 'same selection', context: previous, expected: null },
  { label: 'removed selection', expected: 'Refactor this' },
  { label: 'same selection when the native prompt is rejected', context: previous, expected: null, nativeFailure: true },
];

it.each(cases)('sends a repeated unanswered request with its $label during Pi recovery', async ({ context, expected, nativeFailure }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'claudian-pi-recovery-context-'));
  const script = path.join(root, 'native.cjs');
  const captured = path.join(root, 'prompt.json');
  await writeFile(script, `
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const data = request.type === 'get_state' ? { sessionId: 'native-session' }
    : request.type === 'prompt' ? { disposition: 'started' }
    : request.type === 'get_commands' ? { commands: [] } : {};
  if (request.type === 'prompt') fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify(request));
  const rejected = ${Boolean(nativeFailure)} && request.type === 'prompt';
  process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: !rejected,
    ...(rejected ? { error: 'Native refused prompt' } : { data }) }) + '\\n');
  if (request.type === 'prompt' && !rejected) setTimeout(() => {
    for (const type of ['agent_start', 'agent_end', 'agent_settled']) process.stdout.write(JSON.stringify({ type }) + '\\n');
  }, 0);
});
`);
  const host = (await createProviderHostFixture({ settings: { model: MODEL, providerConfigs: { pi: { enabled: true, visibleModels: [MODEL], discoveredModels: [
      { encodedId: MODEL, id: 'claude-sonnet-4', provider: 'anthropic', label: 'Claude Sonnet 4', reasoning: false, thinkingLevels: ['off'] },
    ] } } }, overrides: { getResolvedProviderCliPath: async () => process.execPath, workingDirectory: root } })).host;
  const backend = new PiExecutionBackend(host.getRuntimeHost('pi'), { createKernel: (spec, callbacks, ui) => new PiRPCSessionKernel({
    ...spec, command: process.execPath, args: [script], cwd: root, enableTreeBridge: false, enableSessionTools: false,
  }, callbacks, ui) });
  const session = backend.createSession({ lifecycle: 'ephemeral', nativePersistence: 'disabled-if-supported', workingDirectory: root,
    interactionPort: { askUserQuestion: vi.fn(), dismissInteraction: vi.fn(), requestApproval: vi.fn() } });
  const history: ChatMessage[] = [{ id: 'previous', role: 'user', content: 'Refactor this', timestamp: testDate().getTime(),
    executionInput: { schemaVersion: 1, canonicalText: 'Refactor this', context: previous } }];
  try {
    const run = session.execute({ configuration: { model: MODEL, reasoning: null, systemInstructions: { kind: 'explicit', instructions: '' } },
      input: [{ type: 'text', text: 'Refactor this' }], context, conversationHistory: history,
      signal: new AbortController().signal, toolPolicy: { kind: 'provider-default' } });
    const events = [];
    for await (const event of run.events) events.push(event);
    const executionErrors = events.filter(event => event.type === 'execution_error');
    const nativeError = expect.objectContaining({ type: 'execution_error', message: expect.stringContaining('Native refused prompt') });
    expect(executionErrors).toEqual(nativeFailure ? [nativeError] : []);
    expect(events.at(-1)?.type).toBe(nativeFailure ? 'execution_error' : 'turn_completed');
    const request = JSON.parse(await readFile(captured, 'utf8'));
    expect(decodeRecoveryPrompt(request.message)).toEqual({ currentInput: expected });
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
