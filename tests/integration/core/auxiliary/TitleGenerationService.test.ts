import {
  FakeAuxiliaryBackend,
  waitFor,
} from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';

import { TitleGenerationService } from '@/core/auxiliary/TitleGenerationService';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';

function createService() {
  const backend = new FakeAuxiliaryBackend();
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const service = new TitleGenerationService({
    backend,
    interactionPort: {
      askUserQuestion: vi.fn(),
      dismissInteraction: vi.fn(),
      requestApproval: vi.fn(),
    },
    lifecycleRegistry,
    resolveLocale: () => 'ja',
    resolveModel: () => 'title-model',
    nativePersistence: 'disabled-if-supported',
    workingDirectory: '/vault',
  });
  return { backend, lifecycleRegistry, service };
}

describe('TitleGenerationService', () => {
  it('uses a one-shot passive session and preserves prompt parsing', async () => {
    const { backend, service } = createService();
    const callback = vi.fn();
    const generation = service.generateTitle('conversation-1', 'First request', callback);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);

    expect(backend.sessions[0].requests[0]).toMatchObject({
      configuration: {
        model: 'title-model',
        systemInstructions: {
          instructions: expect.stringContaining('Write the title in Japanese'),
          kind: 'explicit',
        },
      },
      toolPolicy: { kind: 'passive' },
    });
    expect(backend.configs).toEqual([expect.objectContaining({
      lifecycle: 'ephemeral',
      nativePersistence: 'disabled-if-supported',
    })]);

    backend.sessions[0].emitText('First title');
    backend.sessions[0].complete();
    await generation;

    expect(callback).toHaveBeenCalledWith('conversation-1', { success: true, title: 'First title' });
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });

  it('cancels only the matching active generation and releases its lease', async () => {
    const { backend, service } = createService();
    const callback = vi.fn();
    const generation = service.generateTitle('conversation-1', 'Request', callback);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);

    service.cancel();
    await generation;

    expect(backend.sessions[0].cancelCalls).toBeGreaterThan(0);
    expect(backend.sessions[0].disposeCalls).toBe(1);
    expect(callback).toHaveBeenCalledWith('conversation-1', {
      error: 'Cancelled',
      success: false,
    });
  });

  it('completes an in-flight title call when a provider transition invalidates it', async () => {
    const { backend, lifecycleRegistry, service } = createService();
    const callback = vi.fn();
    const generation = service.generateTitle('conversation-1', 'Request', callback);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);

    await lifecycleRegistry.runTransition(['claude'], async () => undefined);
    await generation;

    expect(callback).toHaveBeenCalledWith('conversation-1', {
      error: 'Cancelled',
      success: false,
    });
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });

  it('does not acquire a session when cancelled during asynchronous startup', async () => {
    const { backend, service } = createService();
    const callback = vi.fn();

    const generation = service.generateTitle('conversation-1', 'Request', callback);
    service.cancel();
    await generation;

    expect(backend.sessions).toHaveLength(0);
    expect(callback).toHaveBeenCalledWith('conversation-1', {
      error: 'Cancelled',
      success: false,
    });
  });

  it.each([
    ['double-quoted spaces', '"   "'],
    ['single-quoted tab and space', "'\t '"],
    ['quoted whitespace longer than the maximum title length', `"${' '.repeat(60)}"`],
    ['quoted whitespace with trailing punctuation', '"   ."'],
    ['quoted punctuation-only blank with trailing spaces', '"...   "'],
  ])('rejects %s as a parse failure instead of a blank success title', async (_name, payload) => {
    const { backend, service } = createService();
    const callback = vi.fn();
    const generation = service.generateTitle('conversation-1', 'Request', callback);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);

    backend.sessions[0].emitText(payload);
    backend.sessions[0].complete();
    await generation;

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('conversation-1', {
      success: false,
      error: 'Failed to parse title from response',
    });
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });

  it.each([
    ['"  Fix login bug  "', 'Fix login bug'],
    ["'\tFix login bug.  '", 'Fix login bug'],
    ['"  Fix   login bug.  "', 'Fix   login bug'],
  ])('removes quote-boundary padding before returning a generated title: %s', async (payload, title) => {
    const { backend, service } = createService();
    const callback = vi.fn();
    const generation = service.generateTitle('conversation-1', 'Request', callback);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);

    backend.sessions[0].emitText(payload);
    backend.sessions[0].complete();
    await generation;

    expect(callback).toHaveBeenCalledWith('conversation-1', { success: true, title });
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });

  it('keeps quoted nonblank titles with meaningful internal spaces', async () => {
    const { backend, service } = createService();
    const callback = vi.fn();
    const generation = service.generateTitle('conversation-1', 'Request', callback);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);

    backend.sessions[0].emitText('"Fix   login bug."');
    backend.sessions[0].complete();
    await generation;

    expect(callback).toHaveBeenCalledWith('conversation-1', {
      success: true,
      title: 'Fix   login bug',
    });
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });

  it('keeps truncating nonblank titles at fifty characters', async () => {
    const { backend, service } = createService();
    const callback = vi.fn();
    const generation = service.generateTitle('conversation-1', 'Request', callback);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);

    backend.sessions[0].emitText('"Summarize provider session lease cleanup across auxiliary executions"');
    backend.sessions[0].complete();
    await generation;

    expect(callback).toHaveBeenCalledWith('conversation-1', {
      success: true,
      title: 'Summarize provider session lease cleanup across...',
    });
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });

  it.each([
    [
      'backs off one unit when the input cut splits a surrogate pair',
      `${'x'.repeat(499)}\uD83D\uDE00tail`,
      `User's request:\n"""\n${'x'.repeat(499)}...\n"""\n\nGenerate a title for this conversation:`,
    ],
    [
      'keeps a complete pair that fits before the input cut',
      `${'x'.repeat(498)}\uD83D\uDE00tail`,
      `User's request:\n"""\n${'x'.repeat(498)}\uD83D\uDE00...\n"""\n\nGenerate a title for this conversation:`,
    ],
  ])('truncates the captured prompt input safely: %s', async (_name, input, expectedPrompt) => {
    const { backend, service } = createService();
    const callback = vi.fn();
    const generation = service.generateTitle('conversation-1', input, callback);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);

    backend.sessions[0].emitText('Title');
    backend.sessions[0].complete();
    await generation;

    expect(backend.sessions[0].requests[0].input[0]).toEqual({
      text: expectedPrompt,
      type: 'text',
    });
    expect(callback).toHaveBeenCalledWith('conversation-1', {
      success: true,
      title: 'Title',
    });
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });

  it.each([
    [
      'backs off one unit when the title cut splits a surrogate pair',
      `${'x'.repeat(46)}\uD83D\uDE00tail`,
      `${'x'.repeat(46)}...`,
    ],
    [
      'keeps a complete pair that fits before the title cut',
      `${'x'.repeat(45)}\uD83D\uDE00tail`,
      `${'x'.repeat(45)}\uD83D\uDE00...`,
    ],
  ])('truncates the generated title safely: %s', async (_name, payload, expectedTitle) => {
    const { backend, service } = createService();
    const callback = vi.fn();
    const generation = service.generateTitle('conversation-1', 'Request', callback);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);

    backend.sessions[0].emitText(payload);
    backend.sessions[0].complete();
    await generation;

    expect(callback).toHaveBeenCalledWith('conversation-1', {
      success: true,
      title: expectedTitle,
    });
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });
});
