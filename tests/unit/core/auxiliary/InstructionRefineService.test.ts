import type { AuxQueryRunner } from '@/core/auxiliary/AuxQueryRunner';
import { InstructionRefineService } from '@/core/auxiliary/InstructionRefineService';

describe('InstructionRefineService', () => {
  let service: InstructionRefineService;
  let mockQuery: jest.Mock;
  let mockReset: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery = jest.fn();
    mockReset = jest.fn();
    const backend = {
      query: mockQuery,
      reset: mockReset,
    } as AuxQueryRunner;

    service = new InstructionRefineService(backend);
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

  it('passes a model override through to the aux runner', async () => {
    mockQuery.mockResolvedValue('<instruction>Use TypeScript</instruction>');

    service.setModelOverride('gpt-5.4');
    await service.refineInstruction('use ts', '');

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.4',
    }), 'Please refine this instruction: "use ts"');
  });

  it('does not allow continuation when the backend has no resumable conversation', async () => {
    const backend = {
      canContinue: jest.fn(() => false),
      query: jest.fn().mockResolvedValue('What language?'),
      reset: jest.fn(),
    } as AuxQueryRunner;
    service = new InstructionRefineService(backend);

    await service.refineInstruction('use typed language', '');

    await expect(service.continueConversation('TypeScript')).resolves.toEqual({
      error: 'No active conversation to continue',
      success: false,
    });
  });
});
