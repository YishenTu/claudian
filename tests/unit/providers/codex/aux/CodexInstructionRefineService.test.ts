import { CodexInstructionRefineService } from '@/providers/codex/aux/CodexInstructionRefineService';

describe('CodexInstructionRefineService', () => {
  let service: CodexInstructionRefineService;

  beforeEach(() => {
    service = new CodexInstructionRefineService();
  });

  it('should return failure for refineInstruction', async () => {
    const result = await service.refineInstruction('test instruction', '');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return failure for continueConversation', async () => {
    const result = await service.continueConversation('follow up');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should be safe to call resetConversation', () => {
    expect(() => service.resetConversation()).not.toThrow();
  });

  it('should be safe to call cancel', () => {
    expect(() => service.cancel()).not.toThrow();
  });
});
