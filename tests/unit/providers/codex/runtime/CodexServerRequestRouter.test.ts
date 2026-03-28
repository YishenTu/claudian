import type { ApprovalCallback, AskUserQuestionCallback } from '@/core/runtime/types';
import { CodexServerRequestRouter } from '@/providers/codex/runtime/CodexServerRequestRouter';

describe('CodexServerRequestRouter', () => {
  let router: CodexServerRequestRouter;
  let mockApprovalCallback: jest.MockedFunction<ApprovalCallback>;
  let mockAskUserCallback: jest.MockedFunction<AskUserQuestionCallback>;

  beforeEach(() => {
    router = new CodexServerRequestRouter();
    mockApprovalCallback = jest.fn();
    mockAskUserCallback = jest.fn();
    router.setApprovalCallback(mockApprovalCallback);
    router.setAskUserCallback(mockAskUserCallback);
  });

  describe('command execution approval', () => {
    it('routes approval and returns accept decision', async () => {
      mockApprovalCallback.mockResolvedValue('allow');

      const result = await router.handleServerRequest(
        'item/commandExecution/requestApproval',
        {
          threadId: 't1',
          turnId: 'turn1',
          itemId: 'call_abc',
          command: 'echo test',
          cwd: '/workspace',
        },
      );

      expect(mockApprovalCallback).toHaveBeenCalledWith(
        'Bash',
        expect.objectContaining({ command: 'echo test' }),
        expect.any(String),
        expect.any(Object),
      );
      expect(result).toEqual({ decision: 'accept' });
    });

    it('returns deny decision when approval is denied', async () => {
      mockApprovalCallback.mockResolvedValue('deny');

      const result = await router.handleServerRequest(
        'item/commandExecution/requestApproval',
        {
          threadId: 't1',
          turnId: 'turn1',
          itemId: 'call_abc',
          command: 'rm -rf /',
          cwd: '/workspace',
        },
      );

      expect(result).toEqual({ decision: 'deny' });
    });
  });

  describe('file change approval', () => {
    it('routes file change approval with changes info', async () => {
      mockApprovalCallback.mockResolvedValue('allow');

      const result = await router.handleServerRequest(
        'item/fileChange/requestApproval',
        {
          threadId: 't1',
          turnId: 'turn1',
          itemId: 'call_fc1',
          changes: [{ path: '/workspace/foo.ts', type: 'modify' }],
        },
      );

      expect(mockApprovalCallback).toHaveBeenCalledWith(
        'apply_patch',
        expect.objectContaining({ changes: expect.any(Array) }),
        expect.any(String),
        expect.any(Object),
      );
      expect(result).toEqual({ decision: 'accept' });
    });
  });

  describe('permissions approval', () => {
    it('routes permissions approval request', async () => {
      mockApprovalCallback.mockResolvedValue('allow');

      const result = await router.handleServerRequest(
        'item/permissions/requestApproval',
        { threadId: 't1', turnId: 'turn1', itemId: 'perm1' },
      );

      expect(result).toEqual({ decision: 'accept' });
    });
  });

  describe('ask-user flow', () => {
    it('routes user input request and returns formatted answers', async () => {
      mockAskUserCallback.mockResolvedValue({ q1: 'yes' });

      const result = await router.handleServerRequest(
        'item/tool/requestUserInput',
        {
          threadId: 't1',
          turnId: 'turn1',
          questions: [{ id: 'q1', text: 'Proceed?' }],
        },
      );

      expect(mockAskUserCallback).toHaveBeenCalled();
      expect(result).toEqual({
        answers: { q1: { answers: ['yes'] } },
      });
    });

    it('returns empty answers when user cancels', async () => {
      mockAskUserCallback.mockResolvedValue(null);

      const result = await router.handleServerRequest(
        'item/tool/requestUserInput',
        {
          threadId: 't1',
          turnId: 'turn1',
          questions: [{ id: 'q1', text: 'Proceed?' }],
        },
      );

      expect(result).toEqual({ answers: {} });
    });
  });

  describe('fail-closed for missing callbacks', () => {
    it('denies approval when no callback is set', async () => {
      router.setApprovalCallback(null);

      const result = await router.handleServerRequest(
        'item/commandExecution/requestApproval',
        { threadId: 't1', turnId: 'turn1', itemId: 'call_1', command: 'echo hi', cwd: '/' },
      );

      expect(result).toEqual({ decision: 'deny' });
    });

    it('returns empty answers when no ask-user callback is set', async () => {
      router.setAskUserCallback(null);

      const result = await router.handleServerRequest(
        'item/tool/requestUserInput',
        { threadId: 't1', turnId: 'turn1', questions: [{ id: 'q1', text: 'Q?' }] },
      );

      expect(result).toEqual({ answers: {} });
    });
  });

  describe('unsupported requests', () => {
    it('throws for unknown request methods', async () => {
      await expect(
        router.handleServerRequest('unknown/method', {}),
      ).rejects.toThrow();
    });
  });
});
