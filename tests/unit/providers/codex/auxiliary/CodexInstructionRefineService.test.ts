import { CodexInstructionRefineService } from '@/providers/codex/auxiliary/CodexInstructionRefineService';
import { CodexAuxQueryRunner } from '@/providers/codex/runtime/CodexAuxQueryRunner';

jest.mock('@/providers/codex/runtime/CodexAuxQueryRunner');

const MockRunner = CodexAuxQueryRunner as jest.MockedClass<typeof CodexAuxQueryRunner>;

function createMockPlugin() {
  return { settings: {} } as never;
}

describe('CodexInstructionRefineService', () => {
  let service: CodexInstructionRefineService;
  let mockQuery: jest.Mock;
  let mockReset: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery = jest.fn();
    mockReset = jest.fn();
    MockRunner.mockImplementation(() => ({
      query: mockQuery,
      reset: mockReset,
    }) as unknown as CodexAuxQueryRunner);

    service = new CodexInstructionRefineService(createMockPlugin());
  });

  it('should parse refined instruction from response', async () => {
    mockQuery.mockResolvedValue('<instruction>Use TypeScript</instruction>');
    const result = await service.refineInstruction('use ts', '');
    expect(result.success).toBe(true);
    expect(result.refinedInstruction).toBe('Use TypeScript');
  });

  it('should return clarification when no instruction tags', async () => {
    mockQuery.mockResolvedValue('Could you be more specific?');
    const result = await service.refineInstruction('do stuff', '');
    expect(result.success).toBe(true);
    expect(result.clarification).toBe('Could you be more specific?');
  });

  it('should return error for continueConversation without active thread', async () => {
    const result = await service.continueConversation('follow up');
    expect(result.success).toBe(false);
    expect(result.error).toBe('No active conversation to continue');
  });

  it('should allow continueConversation after refineInstruction', async () => {
    mockQuery.mockResolvedValue('What language?');
    await service.refineInstruction('use typed language', '');

    mockQuery.mockResolvedValue('<instruction>Use TypeScript for all code</instruction>');
    const result = await service.continueConversation('TypeScript');
    expect(result.success).toBe(true);
    expect(result.refinedInstruction).toBe('Use TypeScript for all code');
  });

  it('should reset runner on resetConversation', () => {
    service.resetConversation();
    expect(mockReset).toHaveBeenCalled();
  });

  it('should return error on query failure', async () => {
    mockQuery.mockRejectedValue(new Error('Connection failed'));
    const result = await service.refineInstruction('test', '');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection failed');
  });
});
