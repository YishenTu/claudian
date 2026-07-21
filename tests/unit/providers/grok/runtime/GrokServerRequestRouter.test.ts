import askFixture from '@test/fixtures/providers/grok/extensions/ask-user-question.json';
import exitFixture from '@test/fixtures/providers/grok/extensions/exit-plan-mode.json';

import type {
  ApprovalCallback,
  AskUserQuestionCallback,
} from '@/core/runtime/types';
import type { AcpRequestPermissionRequest } from '@/providers/acp';
import {
  GROK_EXTENSION_NOTIFICATION_METHODS,
  GROK_EXTENSION_REQUEST_METHODS,
  type GrokMethodNotSupportedError,
  GrokServerRequestRouter,
} from '@/providers/grok/runtime/GrokServerRequestRouter';

const SESSION_ID = '<session-id>';

function createRouter(): GrokServerRequestRouter {
  const router = new GrokServerRequestRouter();
  router.setActiveSessionId(SESSION_ID);
  return router;
}

function createPermissionRequest(): AcpRequestPermissionRequest {
  return {
    sessionId: SESSION_ID,
    options: [
      { kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' },
      { kind: 'allow_always', name: 'Always allow', optionId: 'allow-always' },
      { kind: 'reject_once', name: 'Reject once', optionId: 'reject-once' },
      { kind: 'reject_always', name: 'Always reject', optionId: 'reject-always' },
    ],
    toolCall: {
      rawInput: { command: 'printf smoke' },
      title: 'run_terminal_command',
      toolCallId: '<permission-tool-call-id>',
    },
  };
}

describe('GrokServerRequestRouter', () => {
  describe('permission requests', () => {
    it('normalizes a terminal approval for presentation and preserves reject option ids', async () => {
      const request = createPermissionRequest();
      const router = createRouter();
      const callback: ApprovalCallback = jest.fn(async (_tool, _input, _description, options) => {
        expect(options?.decisionOptions).toEqual([
          { decision: 'allow', label: 'Allow once', value: 'allow-once' },
          { decision: 'allow-always', label: 'Always allow', value: 'allow-always' },
          { label: 'Reject once', value: 'reject-once' },
          { label: 'Always reject', value: 'reject-always' },
        ]);
        return { type: 'select-option' as const, value: 'reject-always' };
      });
      router.setApprovalCallback(callback);

      await expect(router.handlePermissionRequest(request)).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-always' },
      });
      expect(callback).toHaveBeenCalledWith(
        'Bash',
        { command: 'printf smoke' },
        'Grok wants to use Bash.',
        expect.any(Object),
      );
      expect(request).toEqual(createPermissionRequest());
    });

    it('normalizes read_file and preserves allow decisions', async () => {
      const router = createRouter();
      const callback = jest.fn(async () => 'allow' as const);
      router.setApprovalCallback(callback);
      const request = createPermissionRequest();
      request.toolCall = {
        rawInput: { path: 'notes/example.md' },
        title: 'read_file',
        toolCallId: '<read-tool-call-id>',
      };

      await expect(router.handlePermissionRequest(request)).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });
      expect(callback).toHaveBeenCalledWith(
        'Read',
        { path: 'notes/example.md' },
        'Grok wants to use Read.',
        expect.any(Object),
      );
    });

    it('keeps unknown tools intelligible and wraps malformed input losslessly', async () => {
      const router = createRouter();
      const callback = jest.fn(async () => 'deny' as const);
      router.setApprovalCallback(callback);
      const request = createPermissionRequest();
      request.toolCall = {
        rawInput: ['opaque', 7],
        title: 'future_xai_tool',
        toolCallId: '<future-tool-call-id>',
      };

      await expect(router.handlePermissionRequest(request)).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      });
      expect(callback).toHaveBeenCalledWith(
        'future_xai_tool',
        { value: ['opaque', 7] },
        'Grok wants to use future_xai_tool.',
        expect.any(Object),
      );
      expect(request.toolCall.rawInput).toEqual(['opaque', 7]);
    });

    it('cancels absent callbacks, invalid sessions, and aborted approval UI', async () => {
      const router = createRouter();
      await expect(router.handlePermissionRequest(createPermissionRequest())).resolves.toEqual({
        outcome: { outcome: 'cancelled' },
      });

      const callback = jest.fn<ReturnType<ApprovalCallback>, Parameters<ApprovalCallback>>(
        () => new Promise(() => {}),
      );
      const dismisser = jest.fn();
      router.setApprovalCallback(callback);
      router.setApprovalDismisser(dismisser);

      const pending = router.handlePermissionRequest(createPermissionRequest());
      expect(router.abortPending()).toBe(true);
      await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
      expect(dismisser).toHaveBeenCalledTimes(1);

      router.setActiveSessionId('another-session');
      await expect(router.handlePermissionRequest(createPermissionRequest())).resolves.toEqual({
        outcome: { outcome: 'cancelled' },
      });
    });

    it('does not invoke approval UI for an already-aborted signal', async () => {
      const router = createRouter();
      const callback = jest.fn(async () => 'allow' as const);
      const controller = new AbortController();
      controller.abort();
      router.setApprovalCallback(callback);

      await expect(router.handlePermissionRequest(
        createPermissionRequest(),
        controller.signal,
      )).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('ask user question', () => {
    it('parses the observed underscored request and serializes accepted answers as arrays', async () => {
      const router = createRouter();
      const callback: AskUserQuestionCallback = jest.fn(async (input) => {
        expect(input).toEqual({
          questions: [{
            header: 'Q1',
            multiSelect: false,
            options: [
              { description: 'First harmless value', label: 'Alpha' },
              { description: 'Second harmless value', label: 'Beta' },
            ],
            question: 'Choose a smoke-test option?',
          }],
        });
        expect(input).not.toHaveProperty('mode');
        return { 'Choose a smoke-test option?': 'Alpha' };
      });
      router.setAskUserQuestionCallback(callback);

      await expect(router.handleRequest(
        askFixture.request.method,
        askFixture.request.params,
      )).resolves.toEqual(askFixture.acceptedResponse);
    });

    it.each([
      ['missing callback', null],
      ['user dismissal', jest.fn(async () => null)],
      ['callback failure', jest.fn(async () => { throw new Error('disconnected'); })],
    ])('returns cancelled for %s', async (_case, callback) => {
      const router = createRouter();
      router.setAskUserQuestionCallback(callback as AskUserQuestionCallback | null);

      await expect(router.handleRequest(
        'x.ai/ask_user_question',
        askFixture.request.params,
      )).resolves.toEqual(askFixture.cancelledResponse);
    });

    it('aborts pending question UI and resolves cancelled even if the callback ignores abort', async () => {
      const router = createRouter();
      let callbackSignal: AbortSignal | undefined;
      let markCallbackStarted = (): void => {};
      const callbackStarted = new Promise<void>((resolve) => {
        markCallbackStarted = resolve;
      });
      router.setAskUserQuestionCallback(async (_input, signal) => {
        callbackSignal = signal;
        markCallbackStarted();
        return new Promise(() => {});
      });

      const pending = router.handleRequest('x.ai/ask_user_question', askFixture.request.params);
      await callbackStarted;
      expect(router.abortPending()).toBe(true);

      await expect(pending).resolves.toEqual(askFixture.cancelledResponse);
      expect(callbackSignal?.aborted).toBe(true);
    });

    it('does not invoke question UI for an already-aborted signal', async () => {
      const router = createRouter();
      const callback = jest.fn(async () => ({ ignored: 'value' }));
      const controller = new AbortController();
      controller.abort();
      router.setAskUserQuestionCallback(callback);

      await expect(router.handleRequest(
        'x.ai/ask_user_question',
        askFixture.request.params,
        controller.signal,
      )).resolves.toEqual(askFixture.cancelledResponse);
      expect(callback).not.toHaveBeenCalled();
    });

    it('normalizes omitted option descriptions to an empty string', async () => {
      const router = createRouter();
      const callback = jest.fn(async () => ({ 'Description optional?': 'Yes' }));
      router.setAskUserQuestionCallback(callback);
      const params = {
        mode: 'default',
        questions: [{
          options: [{ label: 'Yes' }],
          question: 'Description optional?',
        }],
        sessionId: SESSION_ID,
        toolCallId: '<tool-call-id>',
      };

      await expect(router.handleRequest('x.ai/ask_user_question', params)).resolves.toEqual({
        answers: { 'Description optional?': ['Yes'] },
        outcome: 'accepted',
      });
      expect(callback).toHaveBeenCalledWith({
        questions: [{
          header: 'Q1',
          multiSelect: false,
          options: [{ description: '', label: 'Yes' }],
          question: 'Description optional?',
        }],
      }, expect.any(AbortSignal));
    });

    it('preserves opaque ids and serializes answers under the original question text', async () => {
      const router = createRouter();
      const callback: AskUserQuestionCallback = jest.fn(async (input) => {
        expect(input).toEqual({
          questions: [{
            header: 'Q1',
            id: 'question-id',
            multiSelect: false,
            options: [{
              description: 'Keep the current layout',
              label: ' Keep exact spacing ',
              value: 'option-id',
            }],
            question: ' Which layout? ',
          }],
        });
        return { 'question-id': 'option-id' };
      });
      router.setAskUserQuestionCallback(callback);

      await expect(router.handleRequest('x.ai/ask_user_question', {
        mode: 'default',
        questions: [{
          id: 'question-id',
          options: [{
            description: 'Keep the current layout',
            id: 'option-id',
            label: ' Keep exact spacing ',
            preview: 'Current layout preview',
          }],
          question: ' Which layout? ',
        }],
        sessionId: SESSION_ID,
        toolCallId: '<tool-call-id>',
      })).resolves.toEqual({
        annotations: {
          ' Which layout? ': { preview: 'Current layout preview' },
        },
        answers: {
          ' Which layout? ': [' Keep exact spacing '],
        },
        outcome: 'accepted',
      });
    });

    it.each([
      ['wrong session', { ...askFixture.request.params, sessionId: 'wrong-session' }],
      ['missing tool call', { ...askFixture.request.params, toolCallId: '' }],
      ['missing questions', { ...askFixture.request.params, questions: [] }],
      ['invalid options', {
        ...askFixture.request.params,
        questions: [{ question: 'Invalid?', options: [] }],
      }],
    ])('fails closed for %s', async (_case, params) => {
      const router = createRouter();
      const callback = jest.fn(async () => ({ ignored: 'value' }));
      router.setAskUserQuestionCallback(callback);

      await expect(router.handleRequest('x.ai/ask_user_question', params)).resolves.toEqual(
        askFixture.cancelledResponse,
      );
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('plan and permission-mode extensions', () => {
    it('returns only abandoned for exit plan mode and emits the unsupported notice', async () => {
      const router = createRouter();
      const notice = jest.fn();
      router.setNoticeCallback(notice);

      await expect(router.handleRequest(
        exitFixture.request.method,
        exitFixture.request.params,
      )).resolves.toEqual(exitFixture.response);
      expect(notice).toHaveBeenCalledWith(
        'Grok plan mode is not supported in Claudian. The plan was abandoned.',
      );
    });

    it('abandons malformed exit requests without emitting a misleading notice', async () => {
      const router = createRouter();
      const notice = jest.fn();
      router.setNoticeCallback(notice);

      await expect(router.handleRequest('x.ai/exit_plan_mode', {
        ...exitFixture.request.params,
        sessionId: 'wrong-session',
      })).resolves.toEqual({ outcome: 'abandoned' });
      expect(notice).not.toHaveBeenCalled();
    });

    it('maps only boolean yolo notifications to Safe and YOLO UI values', () => {
      const router = createRouter();
      const sync = jest.fn();
      router.setPermissionModeSyncCallback(sync);

      expect(router.handleNotification('x.ai/yolo_mode_changed', { yolo_mode: true })).toBe(true);
      expect(router.handleNotification('_x.ai/yolo_mode_changed', { yolo_mode: false })).toBe(true);
      expect(router.handleNotification('x.ai/yolo_mode_changed', { auto_mode: true })).toBe(false);
      expect(router.handleNotification('x.ai/yolo_mode_changed', { yolo_mode: 'true' })).toBe(false);
      expect(sync.mock.calls).toEqual([['yolo'], ['normal']]);
    });
  });

  it('declares the observed aliases and rejects unknown requests as method-not-supported', async () => {
    expect(GROK_EXTENSION_REQUEST_METHODS).toEqual([
      'x.ai/ask_user_question',
      '_x.ai/ask_user_question',
      'x.ai/exit_plan_mode',
      '_x.ai/exit_plan_mode',
    ]);
    expect(GROK_EXTENSION_NOTIFICATION_METHODS).toEqual([
      'x.ai/yolo_mode_changed',
      '_x.ai/yolo_mode_changed',
    ]);

    await expect(createRouter().handleRequest('x.ai/future_request', {})).rejects.toMatchObject({
      code: -32601,
      name: 'GrokMethodNotSupportedError',
    } satisfies Partial<GrokMethodNotSupportedError>);
  });
});
