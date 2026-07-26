import type { ProviderHost } from '@/core/providers/ProviderHost';
import { KimiInstructionRefineService } from '@/providers/kimi/auxiliary/KimiInstructionRefineService';
import { KimiTaskResultInterpreter } from '@/providers/kimi/auxiliary/KimiTaskResultInterpreter';
import { KimiTitleGenerationService } from '@/providers/kimi/auxiliary/KimiTitleGenerationService';
import { KimiAuxQueryRunner } from '@/providers/kimi/runtime/KimiAuxQueryRunner';

jest.mock('@/providers/kimi/runtime/KimiAuxQueryRunner');

const MockKimiAuxQueryRunner = KimiAuxQueryRunner as jest.MockedClass<typeof KimiAuxQueryRunner>;

function makeHost(titleGenerationModel?: string): ProviderHost {
  return {
    app: { vault: { adapter: { basePath: '/tmp/kimi-aux-vault' } } },
    manifest: { version: '2.0.39-test' },
    settings: {
      providerConfigs: { kimi: { enabled: true } },
      ...(titleGenerationModel !== undefined ? { titleGenerationModel } : {}),
    },
  } as unknown as ProviderHost;
}

describe('KimiTitleGenerationService', () => {
  let query: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    query = jest.fn().mockResolvedValue('Kimi title');
    MockKimiAuxQueryRunner.mockImplementation(() => ({
      query,
      reset: jest.fn(),
    } as unknown as KimiAuxQueryRunner));
  });

  it('decodes a kimi:-scoped titleGenerationModel for the auxiliary query', async () => {
    const service = new KimiTitleGenerationService(makeHost('kimi:kimi-k2-latest'));
    const callback = jest.fn();

    await service.generateTitle('conversation-1', 'Summarize this note', callback);

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'kimi-k2-latest' }),
      expect.any(String),
    );
    expect(callback).toHaveBeenCalledWith('conversation-1', {
      success: true,
      title: 'Kimi title',
    });
  });

  it('ignores title models owned by other providers', async () => {
    for (const foreign of ['grok/grok-4', 'opencode:anthropic/claude-sonnet-4', 'claude-sonnet-4-5']) {
      query.mockClear();
      const service = new KimiTitleGenerationService(makeHost(foreign));

      await service.generateTitle('conversation-1', 'Summarize this note', jest.fn());

      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({ model: undefined }),
        expect.any(String),
      );
    }
  });

  it('uses the native default model when no title model is configured', async () => {
    const service = new KimiTitleGenerationService(makeHost());

    await service.generateTitle('conversation-1', 'Summarize this note', jest.fn());

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined }),
      expect.any(String),
    );
  });
});

describe('KimiInstructionRefineService', () => {
  let query: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    query = jest.fn().mockResolvedValue('<instruction>- Be concise.</instruction>');
    MockKimiAuxQueryRunner.mockImplementation(() => ({
      query,
      reset: jest.fn(),
    } as unknown as KimiAuxQueryRunner));
  });

  it('routes instruction refinement through the Kimi aux query runner', async () => {
    const service = new KimiInstructionRefineService(makeHost());

    const result = await service.refineInstruction('be concise', '');

    expect(MockKimiAuxQueryRunner).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ providerConfigs: { kimi: { enabled: true } } }),
    }));
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: expect.stringContaining('Prompt Engineer') }),
      expect.stringContaining('be concise'),
    );
    expect(result).toEqual({ success: true, refinedInstruction: '- Be concise.' });
  });

  it('surfaces aux query failures as refine errors', async () => {
    query.mockRejectedValue(new Error('kimi exited'));
    const service = new KimiInstructionRefineService(makeHost());

    const result = await service.refineInstruction('be concise', '');

    expect(result).toEqual({ success: false, error: 'kimi exited' });
  });
});

describe('KimiTaskResultInterpreter', () => {
  it('never interprets task results and always falls back', () => {
    const interpreter = new KimiTaskResultInterpreter();

    expect(interpreter.hasAsyncLaunchMarker({ tool: 'Task' })).toBe(false);
    expect(interpreter.extractAgentId({ agentId: 'agent-1' })).toBeNull();
    expect(interpreter.extractStructuredResult('<result>done</result>')).toBeNull();
    expect(interpreter.extractTagValue('<tag>value</tag>', 'tag')).toBeNull();
    expect(interpreter.resolveTerminalStatus({ status: 'error' }, 'completed')).toBe('completed');
    expect(interpreter.resolveTerminalStatus(undefined, 'error')).toBe('error');
  });
});
