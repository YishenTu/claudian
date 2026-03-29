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

  // -----------------------------------------------------------------------
  // Command execution approval
  // -----------------------------------------------------------------------

  describe('command execution approval', () => {
    const baseParams = {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'call_abc',
      command: 'echo test',
      cwd: '/workspace',
    };

    it('maps "allow" to "accept"', async () => {
      mockApprovalCallback.mockResolvedValue('allow');
      const result = await router.handleServerRequest(
        'item/commandExecution/requestApproval',
        baseParams,
      );

      expect(mockApprovalCallback).toHaveBeenCalledWith(
        'Bash',
        expect.objectContaining({ command: 'echo test' }),
        expect.any(String),
        expect.any(Object),
      );
      expect(result).toEqual({ decision: 'accept' });
    });

    it('maps "allow-always" to "acceptForSession"', async () => {
      mockApprovalCallback.mockResolvedValue('allow-always');
      const result = await router.handleServerRequest(
        'item/commandExecution/requestApproval',
        baseParams,
      );
      expect(result).toEqual({ decision: 'acceptForSession' });
    });

    it('maps "deny" to "decline"', async () => {
      mockApprovalCallback.mockResolvedValue('deny');
      const result = await router.handleServerRequest(
        'item/commandExecution/requestApproval',
        { ...baseParams, command: 'rm -rf /' },
      );
      expect(result).toEqual({ decision: 'decline' });
    });

    it('maps "cancel" to "cancel"', async () => {
      mockApprovalCallback.mockResolvedValue('cancel');
      const result = await router.handleServerRequest(
        'item/commandExecution/requestApproval',
        baseParams,
      );
      expect(result).toEqual({ decision: 'cancel' });
    });

    it('passes through network and amendment metadata to the approval callback', async () => {
      mockApprovalCallback.mockResolvedValue('allow');

      await router.handleServerRequest(
        'item/commandExecution/requestApproval',
        {
          ...baseParams,
          reason: 'Needs network access',
          networkApprovalContext: { host: 'api.openai.com', protocol: 'https' },
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: { read: ['/tmp'], write: ['/workspace'] },
            macos: null,
          },
          proposedExecpolicyAmendment: ['curl', 'https://api.openai.com/*'],
          proposedNetworkPolicyAmendments: [{ host: 'api.openai.com', action: 'allow' }],
          availableDecisions: [
            'accept',
            { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['curl', 'https://api.openai.com/*'] } },
            { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'api.openai.com', action: 'allow' } } },
            'decline',
          ],
        },
      );

      expect(mockApprovalCallback).toHaveBeenCalledWith(
        'Bash',
        expect.objectContaining({
          command: 'echo test',
          cwd: '/workspace',
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: { read: ['/tmp'], write: ['/workspace'] },
            macos: null,
          },
          proposedExecpolicyAmendment: ['curl', 'https://api.openai.com/*'],
          proposedNetworkPolicyAmendments: [{ host: 'api.openai.com', action: 'allow' }],
        }),
        expect.stringContaining('api.openai.com'),
        expect.objectContaining({
          networkApprovalContext: { host: 'api.openai.com', protocol: 'https' },
          proposedExecpolicyAmendment: ['curl', 'https://api.openai.com/*'],
          proposedNetworkPolicyAmendments: [{ host: 'api.openai.com', action: 'allow' }],
          decisionOptions: expect.arrayContaining([
            expect.objectContaining({ label: expect.any(String) }),
          ]),
        }),
      );
    });

    it('returns an execpolicy amendment decision when selected by the callback', async () => {
      mockApprovalCallback.mockResolvedValue({
        type: 'allow-with-exec-policy-amendment',
        execPolicyAmendment: ['npm', 'test'],
      } as any);

      const result = await router.handleServerRequest(
        'item/commandExecution/requestApproval',
        baseParams,
      );

      expect(result).toEqual({
        decision: {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ['npm', 'test'],
          },
        },
      });
    });

    it('returns a network policy amendment decision when selected by the callback', async () => {
      mockApprovalCallback.mockResolvedValue({
        type: 'apply-network-policy-amendment',
        networkPolicyAmendment: { host: 'api.openai.com', action: 'allow' },
      } as any);

      const result = await router.handleServerRequest(
        'item/commandExecution/requestApproval',
        baseParams,
      );

      expect(result).toEqual({
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: 'api.openai.com', action: 'allow' },
          },
        },
      });
    });

  });

  // -----------------------------------------------------------------------
  // File change approval
  // -----------------------------------------------------------------------

  describe('file change approval', () => {
    const baseParams = {
      threadId: 't1',
      turnId: 'turn1',
      itemId: 'call_fc1',
    };

    it('maps "allow" to "accept"', async () => {
      mockApprovalCallback.mockResolvedValue('allow');
      const result = await router.handleServerRequest(
        'item/fileChange/requestApproval',
        { ...baseParams, reason: 'write to /foo' },
      );

      expect(mockApprovalCallback).toHaveBeenCalledWith(
        'apply_patch',
        expect.any(Object),
        expect.any(String),
        expect.any(Object),
      );
      expect(result).toEqual({ decision: 'accept' });
    });

    it('maps "allow-always" to "acceptForSession"', async () => {
      mockApprovalCallback.mockResolvedValue('allow-always');
      const result = await router.handleServerRequest(
        'item/fileChange/requestApproval',
        baseParams,
      );
      expect(result).toEqual({ decision: 'acceptForSession' });
    });

    it('maps "deny" to "decline"', async () => {
      mockApprovalCallback.mockResolvedValue('deny');
      const result = await router.handleServerRequest(
        'item/fileChange/requestApproval',
        baseParams,
      );
      expect(result).toEqual({ decision: 'decline' });
    });

    it('maps "cancel" to "cancel"', async () => {
      mockApprovalCallback.mockResolvedValue('cancel');
      const result = await router.handleServerRequest(
        'item/fileChange/requestApproval',
        baseParams,
      );
      expect(result).toEqual({ decision: 'cancel' });
    });
  });

  // -----------------------------------------------------------------------
  // Permissions approval — structured response
  // -----------------------------------------------------------------------

  describe('permissions approval', () => {
    it('grants requested permissions with turn scope on allow', async () => {
      mockApprovalCallback.mockResolvedValue('allow');
      const result = await router.handleServerRequest(
        'item/permissions/requestApproval',
        {
          threadId: 't1',
          turnId: 'turn1',
          itemId: 'perm1',
          permissions: {
            fileSystem: { read: ['/tmp'], write: ['/workspace'] },
            network: { enabled: true },
          },
        },
      );

      expect(result).toEqual({
        permissions: {
          fileSystem: { read: ['/tmp'], write: ['/workspace'] },
          network: { enabled: true },
        },
        scope: 'turn',
      });
    });

    it('grants requested permissions with session scope on allow-always', async () => {
      mockApprovalCallback.mockResolvedValue('allow-always');
      const result = await router.handleServerRequest(
        'item/permissions/requestApproval',
        {
          threadId: 't1',
          turnId: 'turn1',
          itemId: 'perm1',
          permissions: {
            fileSystem: null,
            network: { enabled: true },
          },
        },
      );

      expect(result).toEqual({
        permissions: {
          fileSystem: null,
          network: { enabled: true },
        },
        scope: 'session',
      });
    });

    it('returns empty permissions on deny', async () => {
      mockApprovalCallback.mockResolvedValue('deny');
      const result = await router.handleServerRequest(
        'item/permissions/requestApproval',
        {
          threadId: 't1',
          turnId: 'turn1',
          itemId: 'perm1',
          permissions: {
            fileSystem: { read: ['/tmp'] },
          },
        },
      );

      expect(result).toEqual({
        permissions: {},
        scope: 'turn',
      });
    });

    it('returns empty permissions on cancel', async () => {
      mockApprovalCallback.mockResolvedValue('cancel');
      const result = await router.handleServerRequest(
        'item/permissions/requestApproval',
        {
          threadId: 't1',
          turnId: 'turn1',
          itemId: 'perm1',
          permissions: {
            network: { enabled: true },
          },
        },
      );

      expect(result).toEqual({
        permissions: {},
        scope: 'turn',
      });
    });
  });

  // -----------------------------------------------------------------------
  // Ask-user flow
  // -----------------------------------------------------------------------

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

    it('passes through full question metadata to the ask-user callback', async () => {
      mockAskUserCallback.mockResolvedValue({ q1: 'token' });

      await router.handleServerRequest(
        'item/tool/requestUserInput',
        {
          threadId: 't1',
          turnId: 'turn1',
          itemId: 'ask-1',
          questions: [
            {
              id: 'q1',
              header: 'API key',
              question: 'Enter token',
              options: null,
              isOther: true,
              isSecret: true,
            },
          ],
        },
      );

      expect(mockAskUserCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          questions: [
            {
              id: 'q1',
              header: 'API key',
              question: 'Enter token',
              options: null,
              isOther: true,
              isSecret: true,
            },
          ],
        }),
        expect.any(AbortSignal),
      );
    });

    it('preserves multi-answer arrays from the ask-user callback', async () => {
      mockAskUserCallback.mockResolvedValue({
        q1: ['option-a', 'option-b'],
      } as any);

      const result = await router.handleServerRequest(
        'item/tool/requestUserInput',
        {
          threadId: 't1',
          turnId: 'turn1',
          questions: [{ id: 'q1', question: 'Proceed?', options: ['A', 'B'] }],
        },
      );

      expect(result).toEqual({
        answers: { q1: { answers: ['option-a', 'option-b'] } },
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

  // -----------------------------------------------------------------------
  // Fail-closed for missing callbacks
  // -----------------------------------------------------------------------

  describe('fail-closed for missing callbacks', () => {
    it('declines command approval when no callback is set', async () => {
      router.setApprovalCallback(null);
      const result = await router.handleServerRequest(
        'item/commandExecution/requestApproval',
        { threadId: 't1', turnId: 'turn1', itemId: 'call_1', command: 'echo hi', cwd: '/' },
      );
      expect(result).toEqual({ decision: 'decline' });
    });

    it('declines file change approval when no callback is set', async () => {
      router.setApprovalCallback(null);
      const result = await router.handleServerRequest(
        'item/fileChange/requestApproval',
        { threadId: 't1', turnId: 'turn1', itemId: 'fc_1' },
      );
      expect(result).toEqual({ decision: 'decline' });
    });

    it('returns empty permissions when no callback is set', async () => {
      router.setApprovalCallback(null);
      const result = await router.handleServerRequest(
        'item/permissions/requestApproval',
        {
          threadId: 't1',
          turnId: 'turn1',
          itemId: 'perm1',
          permissions: { network: { enabled: true } },
        },
      );
      expect(result).toEqual({ permissions: {}, scope: 'turn' });
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

  // -----------------------------------------------------------------------
  // Ask-user abort signal
  // -----------------------------------------------------------------------

  describe('ask-user abort signal', () => {
    it('passes an AbortSignal to the ask-user callback', async () => {
      let capturedSignal: AbortSignal | undefined;
      mockAskUserCallback.mockImplementation(async (_input, signal) => {
        capturedSignal = signal;
        return { q1: 'yes' };
      });

      await router.handleServerRequest(
        'item/tool/requestUserInput',
        {
          threadId: 't1',
          turnId: 'turn1',
          questions: [{ id: 'q1', text: 'Proceed?' }],
        },
      );

      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal!.aborted).toBe(false);
    });

    it('aborts the signal when abortPendingAskUser is called', async () => {
      let capturedSignal: AbortSignal | undefined;
      const deferred = {
        resolve: null as ((v: Record<string, string> | null) => void) | null,
      };

      mockAskUserCallback.mockImplementation((_input, signal) => {
        capturedSignal = signal;
        return new Promise<Record<string, string> | null>((resolve) => {
          deferred.resolve = resolve;
        });
      });

      const resultPromise = router.handleServerRequest(
        'item/tool/requestUserInput',
        {
          threadId: 't1',
          turnId: 'turn1',
          questions: [{ id: 'q1', text: 'Proceed?' }],
        },
      );

      // Wait for the callback to be invoked
      await new Promise(r => setTimeout(r, 10));
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      router.abortPendingAskUser();
      expect(capturedSignal!.aborted).toBe(true);

      // Resolve the callback to let the promise finish
      deferred.resolve!(null);
      const result = await resultPromise;
      expect(result).toEqual({ answers: {} });
    });
  });

  // -----------------------------------------------------------------------
  // Unsupported requests
  // -----------------------------------------------------------------------

  describe('unsupported requests', () => {
    it('throws for unknown request methods', async () => {
      await expect(
        router.handleServerRequest('unknown/method', {}),
      ).rejects.toThrow();
    });
  });
});
