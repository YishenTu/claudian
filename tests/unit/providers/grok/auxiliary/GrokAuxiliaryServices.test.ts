import type { ProviderHost } from '@/core/providers/ProviderHost';
import { GrokAuxiliaryLifecycleCoordinator } from '@/providers/grok/auxiliary/GrokAuxiliaryLifecycleCoordinator';
import { GrokInlineEditService } from '@/providers/grok/auxiliary/GrokInlineEditService';
import { GrokInstructionRefineService } from '@/providers/grok/auxiliary/GrokInstructionRefineService';
import { GrokTaskResultInterpreter } from '@/providers/grok/auxiliary/GrokTaskResultInterpreter';
import { GrokTitleGenerationService } from '@/providers/grok/auxiliary/GrokTitleGenerationService';
import { GrokAuxQueryRunner } from '@/providers/grok/runtime/GrokAuxQueryRunner';

jest.mock('@/providers/grok/runtime/GrokAuxQueryRunner');

const MockRunner = GrokAuxQueryRunner as jest.MockedClass<typeof GrokAuxQueryRunner>;

function makeHost(titleGenerationModel = 'grok/custom-title'): ProviderHost {
  return {
    settings: { titleGenerationModel },
  } as unknown as ProviderHost;
}

function makeRunner(query: jest.Mock = jest.fn()) {
  return {
    quiesceForEnvironmentChange: jest.fn().mockResolvedValue(undefined),
    query,
    reset: jest.fn(),
  };
}

function makePendingRunner() {
  let rejectQuery!: (error: Error) => void;
  let releaseShutdown!: () => void;
  const shutdown = new Promise<void>(resolve => { releaseShutdown = resolve; });
  const runner = makeRunner(jest.fn(() => new Promise<string>((_resolve, reject) => {
    rejectQuery = reject;
  })));
  runner.quiesceForEnvironmentChange.mockImplementation(() => {
    rejectQuery(new Error('Cancelled'));
    return shutdown;
  });
  return { releaseShutdown, runner };
}

describe('Grok auxiliary services', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('generates a title with the selected Grok model and releases its one-shot runner', async () => {
    const runner = makeRunner(jest.fn(async () => 'Refine Grok adapter'));
    MockRunner.mockImplementation(() => runner as unknown as GrokAuxQueryRunner);
    const service = new GrokTitleGenerationService(makeHost());
    const callback = jest.fn();

    await service.generateTitle('conversation-1', 'Please improve the Grok adapter', callback);

    expect(runner.query).toHaveBeenCalledWith(expect.objectContaining({
      model: 'grok/custom-title',
      systemPrompt: expect.stringContaining('Generate a **concise, descriptive title**'),
    }), expect.stringContaining('Please improve the Grok adapter'));
    expect(callback).toHaveBeenCalledWith('conversation-1', {
      success: true,
      title: 'Refine Grok adapter',
    });
    expect(runner.reset).toHaveBeenCalledTimes(1);
  });

  it('uses native default title generation when the configured model belongs elsewhere', async () => {
    const runner = makeRunner(jest.fn(async () => 'Use native Grok model'));
    MockRunner.mockImplementation(() => runner as unknown as GrokAuxQueryRunner);
    const service = new GrokTitleGenerationService(makeHost('codex/gpt-5'));

    await service.generateTitle('conversation-1', 'Use the default', jest.fn());

    expect(runner.query).toHaveBeenCalledWith(expect.objectContaining({
      model: undefined,
    }), expect.any(String));
  });

  it('aborts an in-flight title and awaits its owned runner shutdown', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const { releaseShutdown, runner } = makePendingRunner();
    MockRunner.mockImplementation(() => runner as unknown as GrokAuxQueryRunner);
    const service = new GrokTitleGenerationService(makeHost(), { lifecycle });
    const callback = jest.fn();
    const generation = service.generateTitle('conversation-1', 'Pending title', callback);
    await Promise.resolve();
    lifecycle.track(runner);

    let settled = false;
    const quiescence = lifecycle.quiesceForEnvironmentChange().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseShutdown();
    await quiescence;
    await generation;

    expect(callback).toHaveBeenCalledWith('conversation-1', {
      error: 'Cancelled',
      success: false,
    });
    expect(runner.reset).toHaveBeenCalledTimes(1);
  });

  it('retains one runner across instruction refinement continuation and resets a new workflow', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce('<instruction>Use TypeScript.</instruction>')
      .mockResolvedValueOnce('<instruction>Use strict TypeScript.</instruction>')
      .mockResolvedValueOnce('<instruction>Use Rust.</instruction>');
    const runner = makeRunner(query);
    MockRunner.mockImplementation(() => runner as unknown as GrokAuxQueryRunner);
    const service = new GrokInstructionRefineService(makeHost());

    await expect(service.refineInstruction('use ts', 'Keep code concise.')).resolves.toEqual({
      refinedInstruction: 'Use TypeScript.',
      success: true,
    });
    await expect(service.continueConversation('Make it strict')).resolves.toEqual({
      refinedInstruction: 'Use strict TypeScript.',
      success: true,
    });
    await service.refineInstruction('use rust', 'Keep code concise.');

    expect(MockRunner).toHaveBeenCalledTimes(1);
    expect(runner.reset).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1, expect.objectContaining({
      systemPrompt: expect.stringContaining('Keep code concise.'),
    }), 'Please refine this instruction: "use ts"');
    expect(query).toHaveBeenNthCalledWith(2, expect.any(Object), 'Make it strict');
  });

  it('keeps instruction continuation retryable after environment quiescence', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    let rejectActive!: (error: Error) => void;
    const runner = makeRunner(jest.fn()
      .mockResolvedValueOnce('<instruction>Initial.</instruction>')
      .mockImplementationOnce(() => new Promise<string>((_resolve, reject) => {
        rejectActive = reject;
      }))
      .mockResolvedValueOnce('<instruction>Retried.</instruction>'));
    let releaseShutdown!: () => void;
    const shutdown = new Promise<void>(resolve => { releaseShutdown = resolve; });
    runner.quiesceForEnvironmentChange.mockImplementation(() => {
      rejectActive(new Error('Cancelled'));
      return shutdown;
    });
    MockRunner.mockImplementation(() => runner as unknown as GrokAuxQueryRunner);
    const service = new GrokInstructionRefineService(makeHost(), { lifecycle });
    await service.refineInstruction('initial', 'existing');
    const active = service.continueConversation('pending');
    await Promise.resolve();
    lifecycle.track(runner);
    const quiescence = lifecycle.quiesceForEnvironmentChange();
    await Promise.resolve();
    releaseShutdown();

    await quiescence;
    await expect(active).resolves.toEqual({ error: 'Cancelled', success: false });
    await expect(service.continueConversation('retry')).resolves.toEqual({
      refinedInstruction: 'Retried.',
      success: true,
    });
  });

  it('retains inline edit context and session across continuation calls', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce('<replacement>Revised text</replacement>')
      .mockResolvedValueOnce('<replacement>Final text</replacement>');
    const runner = makeRunner(query);
    MockRunner.mockImplementation(() => runner as unknown as GrokAuxQueryRunner);
    const service = new GrokInlineEditService(makeHost());

    await expect(service.editText({
      contextFiles: ['notes/context.md'],
      instruction: 'Improve this',
      mode: 'selection',
      notePath: 'notes/draft.md',
      selectedText: 'Draft text',
    })).resolves.toEqual({ editedText: 'Revised text', success: true });
    await expect(service.continueConversation('Make it shorter', ['notes/style.md'])).resolves.toEqual({
      editedText: 'Final text',
      success: true,
    });

    expect(MockRunner).toHaveBeenCalledTimes(1);
    expect(runner.reset).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(1, expect.any(Object), expect.stringContaining(
      '<editor_selection path="notes/draft.md">\nDraft text\n</editor_selection>',
    ));
    expect(query.mock.calls[0][1]).toContain('<context_files>');
    expect(query).toHaveBeenNthCalledWith(2, expect.any(Object), expect.stringContaining(
      'Make it shorter\n\n<context_files>\nnotes/style.md\n</context_files>',
    ));
  });

  it('keeps inline-edit continuation retryable after environment quiescence', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    let rejectActive!: (error: Error) => void;
    const runner = makeRunner(jest.fn()
      .mockResolvedValueOnce('<replacement>Initial</replacement>')
      .mockImplementationOnce(() => new Promise<string>((_resolve, reject) => {
        rejectActive = reject;
      }))
      .mockResolvedValueOnce('<replacement>Retried</replacement>'));
    let releaseShutdown!: () => void;
    const shutdown = new Promise<void>(resolve => { releaseShutdown = resolve; });
    runner.quiesceForEnvironmentChange.mockImplementation(() => {
      rejectActive(new Error('Cancelled'));
      return shutdown;
    });
    MockRunner.mockImplementation(() => runner as unknown as GrokAuxQueryRunner);
    const service = new GrokInlineEditService(makeHost(), { lifecycle });
    await service.editText({
      instruction: 'initial',
      mode: 'selection',
      notePath: 'note.md',
      selectedText: 'Initial text',
    });
    const active = service.continueConversation('pending');
    await Promise.resolve();
    lifecycle.track(runner);
    const quiescence = lifecycle.quiesceForEnvironmentChange();
    await Promise.resolve();
    releaseShutdown();

    await quiescence;
    await expect(active).resolves.toEqual({ error: 'Cancelled', success: false });
    await expect(service.continueConversation('retry')).resolves.toEqual({
      editedText: 'Retried',
      success: true,
    });
  });

  it('provides a no-op task result interpreter', () => {
    const interpreter = new GrokTaskResultInterpreter();
    const payload = { agentId: 'native-task', result: '<result>done</result>' };

    expect(interpreter.hasAsyncLaunchMarker(payload)).toBe(false);
    expect(interpreter.extractAgentId(payload)).toBeNull();
    expect(interpreter.extractStructuredResult(payload)).toBeNull();
    expect(interpreter.resolveTerminalStatus(payload, 'completed')).toBe('completed');
    expect(interpreter.extractTagValue('<result>done</result>', 'result')).toBeNull();
  });
});
