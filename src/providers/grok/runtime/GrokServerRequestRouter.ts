import type {
  ApprovalCallback,
  AskUserQuestionCallback,
} from '../../../core/runtime/types';
import {
  type AcpPermissionOption,
  type AcpRequestPermissionRequest,
  type AcpRequestPermissionResponse,
  buildAcpApprovalDecisionOptions,
  mapAcpApprovalDecision,
} from '../../acp';
import { normalizeGrokToolCall } from '../normalization/grokToolNormalization';

export const GROK_EXTENSION_REQUEST_METHODS = [
  'x.ai/ask_user_question',
  '_x.ai/ask_user_question',
  'x.ai/exit_plan_mode',
  '_x.ai/exit_plan_mode',
] as const;

export const GROK_EXTENSION_NOTIFICATION_METHODS = [
  'x.ai/yolo_mode_changed',
  '_x.ai/yolo_mode_changed',
] as const;

const CANCELLED_QUESTION_RESPONSE = { outcome: 'cancelled' } as const;
const CANCELLED_PERMISSION_RESPONSE: AcpRequestPermissionResponse = {
  outcome: { outcome: 'cancelled' },
};
const ABANDONED_PLAN_RESPONSE = { outcome: 'abandoned' } as const;
const UNSUPPORTED_PLAN_NOTICE =
  'Grok plan mode is not supported in Claudian. The plan was abandoned.';

export type GrokPermissionMode = 'normal' | 'yolo';
type PendingInteractionKind = 'approval' | 'question';

interface GrokQuestionOption {
  description: string;
  id?: string;
  label: string;
  preview?: string;
}

interface GrokQuestion {
  id?: string;
  multiSelect: boolean;
  options: GrokQuestionOption[];
  question: string;
}

interface GrokAskUserQuestionRequest {
  mode: 'default' | 'plan';
  questions: GrokQuestion[];
  sessionId: string;
  toolCallId: string;
}

interface PendingInteraction {
  abortController: AbortController;
  cancelled: Promise<void>;
  cleanupExternalAbort: () => void;
  kind: PendingInteractionKind;
  resolveCancelled: () => void;
}

export class GrokMethodNotSupportedError extends Error {
  readonly code = -32601;

  constructor(readonly method: string) {
    super(`Unsupported Grok server request: ${method}`);
    this.name = 'GrokMethodNotSupportedError';
  }
}

export class GrokServerRequestRouter {
  private activeSessionId: string | null = null;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback: AskUserQuestionCallback | null = null;
  private noticeCallback: ((message: string) => void) | null = null;
  private pendingInteraction: PendingInteraction | null = null;
  private permissionModeSyncCallback: ((mode: GrokPermissionMode) => void) | null = null;

  setActiveSessionId(sessionId: string | null): void {
    const normalized = normalizeOpaqueString(sessionId);
    if (normalized !== this.activeSessionId) {
      this.abortPending();
      this.activeSessionId = normalized;
    }
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(callback: (() => void) | null): void {
    this.approvalDismisser = callback;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserQuestionCallback = callback;
  }

  setNoticeCallback(callback: ((message: string) => void) | null): void {
    this.noticeCallback = callback;
  }

  setPermissionModeSyncCallback(
    callback: ((mode: GrokPermissionMode) => void) | null,
  ): void {
    this.permissionModeSyncCallback = callback;
  }

  async handlePermissionRequest(
    request: AcpRequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<AcpRequestPermissionResponse> {
    const parsed = parsePermissionRequest(request, this.activeSessionId);
    const callback = this.approvalCallback;
    if (!parsed || !callback || signal?.aborted) {
      return CANCELLED_PERMISSION_RESPONSE;
    }

    const pending = this.beginPending('approval', signal);
    try {
      const callbackPromise = Promise.resolve(callback(
        parsed.toolName,
        parsed.input,
        `Grok wants to use ${parsed.toolName}.`,
        { decisionOptions: buildAcpApprovalDecisionOptions(parsed.options) },
      ));
      const decision = await Promise.race([
        callbackPromise,
        pending.cancelled.then(() => null),
      ]);
      if (decision === null) {
        return CANCELLED_PERMISSION_RESPONSE;
      }
      return mapAcpApprovalDecision(decision, parsed.options);
    } catch {
      return CANCELLED_PERMISSION_RESPONSE;
    } finally {
      this.finishPending(pending);
    }
  }

  async handleRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    switch (normalizeExtensionMethod(method)) {
      case 'x.ai/ask_user_question':
        return this.handleAskUserQuestion(params, signal);
      case 'x.ai/exit_plan_mode':
        return this.handleExitPlanMode(params);
      default:
        throw new GrokMethodNotSupportedError(method);
    }
  }

  handleNotification(method: string, params: unknown): boolean {
    if (normalizeExtensionMethod(method) !== 'x.ai/yolo_mode_changed') {
      return false;
    }
    if (!isRecord(params) || typeof params.yolo_mode !== 'boolean') {
      return false;
    }

    const mode: GrokPermissionMode = params.yolo_mode ? 'yolo' : 'normal';
    try {
      this.permissionModeSyncCallback?.(mode);
    } catch {
      // UI synchronization is best-effort and must not disrupt the ACP stream.
    }
    return true;
  }

  abortPending(): boolean {
    const pending = this.pendingInteraction;
    if (!pending) {
      return false;
    }

    this.pendingInteraction = null;
    pending.abortController.abort();
    pending.resolveCancelled();
    if (pending.kind === 'approval') {
      try {
        this.approvalDismisser?.();
      } catch {
        // Dismissal is best-effort; the reverse request is already settled.
      }
    }
    return true;
  }

  dispose(): void {
    this.abortPending();
    this.activeSessionId = null;
    this.approvalCallback = null;
    this.approvalDismisser = null;
    this.askUserQuestionCallback = null;
    this.noticeCallback = null;
    this.permissionModeSyncCallback = null;
  }

  private async handleAskUserQuestion(params: unknown, signal?: AbortSignal): Promise<unknown> {
    const request = parseAskUserQuestionRequest(params, this.activeSessionId);
    const callback = this.askUserQuestionCallback;
    if (!request || !callback || signal?.aborted) {
      return CANCELLED_QUESTION_RESPONSE;
    }

    const pending = this.beginPending('question', signal);
    const input = buildQuestionCallbackInput(request.questions);
    try {
      const callbackPromise = Promise.resolve(callback(input, pending.abortController.signal));
      const result = await Promise.race([
        callbackPromise,
        pending.cancelled.then(() => null),
      ]);
      if (!result) {
        return CANCELLED_QUESTION_RESPONSE;
      }
      return buildAcceptedQuestionResponse(request.questions, result);
    } catch {
      return CANCELLED_QUESTION_RESPONSE;
    } finally {
      this.finishPending(pending);
    }
  }

  private handleExitPlanMode(params: unknown): { outcome: 'abandoned' } {
    if (isValidExitPlanModeRequest(params, this.activeSessionId)) {
      try {
        this.noticeCallback?.(UNSUPPORTED_PLAN_NOTICE);
      } catch {
        // The notice is non-blocking; abandoning plan mode remains mandatory.
      }
    }
    return ABANDONED_PLAN_RESPONSE;
  }

  private beginPending(
    kind: PendingInteractionKind,
    externalSignal?: AbortSignal,
  ): PendingInteraction {
    this.abortPending();

    let resolveCancelled = (): void => {};
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const pending: PendingInteraction = {
      abortController: new AbortController(),
      cancelled,
      cleanupExternalAbort: () => {},
      kind,
      resolveCancelled,
    };
    if (externalSignal) {
      const handleExternalAbort = () => {
        if (this.pendingInteraction === pending) {
          this.abortPending();
        }
      };
      externalSignal.addEventListener('abort', handleExternalAbort, { once: true });
      pending.cleanupExternalAbort = () => {
        externalSignal.removeEventListener('abort', handleExternalAbort);
      };
    }
    this.pendingInteraction = pending;
    return pending;
  }

  private finishPending(pending: PendingInteraction): void {
    pending.cleanupExternalAbort();
    if (this.pendingInteraction === pending) {
      this.pendingInteraction = null;
    }
  }
}

function parsePermissionRequest(
  value: unknown,
  activeSessionId: string | null,
): {
  input: Record<string, unknown>;
  options: AcpPermissionOption[];
  toolName: string;
} | null {
  if (!isRecord(value) || !matchesActiveSession(value.sessionId, activeSessionId)) {
    return null;
  }
  if (!Array.isArray(value.options) || !value.options.every(isPermissionOption)) {
    return null;
  }
  if (!isRecord(value.toolCall) || !normalizeOpaqueString(value.toolCall.toolCallId)) {
    return null;
  }

  const title = normalizeNonEmptyString(value.toolCall.title);
  const kind = normalizeNonEmptyString(value.toolCall.kind);
  const normalized = normalizeGrokToolCall({
    kind,
    rawInput: value.toolCall.rawInput,
    title,
  });
  return {
    input: normalized.input,
    options: value.options,
    toolName: normalized.name,
  };
}

function parseAskUserQuestionRequest(
  value: unknown,
  activeSessionId: string | null,
): GrokAskUserQuestionRequest | null {
  if (!isRecord(value) || !matchesActiveSession(value.sessionId, activeSessionId)) {
    return null;
  }
  const toolCallId = normalizeOpaqueString(value.toolCallId);
  if (!toolCallId || (value.mode !== 'default' && value.mode !== 'plan')) {
    return null;
  }
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    return null;
  }

  const questions: GrokQuestion[] = [];
  const questionTexts = new Set<string>();
  const questionIds = new Set<string>();
  const callbackKeys = new Set<string>();
  for (const rawQuestion of value.questions) {
    const question = parseQuestion(rawQuestion);
    if (!question || questionTexts.has(question.question)) {
      return null;
    }
    if (question.id && questionIds.has(question.id)) {
      return null;
    }
    const callbackKey = question.id ?? question.question;
    if (callbackKeys.has(callbackKey)) {
      return null;
    }
    questionTexts.add(question.question);
    if (question.id) questionIds.add(question.id);
    callbackKeys.add(callbackKey);
    questions.push(question);
  }

  return {
    mode: value.mode,
    questions,
    sessionId: activeSessionId!,
    toolCallId,
  };
}

function parseQuestion(value: unknown): GrokQuestion | null {
  if (!isRecord(value)) return null;
  const question = normalizeOpaqueString(value.question);
  const id = normalizeOptionalOpaqueId(value.id);
  if (!question || id === null) return null;
  if (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') {
    return null;
  }
  if (!Array.isArray(value.options) || value.options.length === 0) {
    return null;
  }

  const options: GrokQuestionOption[] = [];
  const labels = new Set<string>();
  const ids = new Set<string>();
  const callbackValues = new Set<string>();
  for (const rawOption of value.options) {
    const option = parseQuestionOption(rawOption);
    if (!option || labels.has(option.label) || (option.id !== undefined && ids.has(option.id))) {
      return null;
    }
    const callbackValue = option.id ?? option.label;
    if (callbackValues.has(callbackValue)) {
      return null;
    }
    labels.add(option.label);
    if (option.id) ids.add(option.id);
    callbackValues.add(callbackValue);
    options.push(option);
  }

  return {
    ...(id === undefined ? {} : { id }),
    multiSelect: value.multiSelect === true,
    options,
    question,
  };
}

function parseQuestionOption(value: unknown): GrokQuestionOption | null {
  if (!isRecord(value)) return null;
  const label = normalizeOpaqueString(value.label);
  const id = normalizeOptionalOpaqueId(value.id);
  if (!label || id === null) {
    return null;
  }
  if (value.description !== undefined && typeof value.description !== 'string') return null;
  if (value.preview !== undefined && typeof value.preview !== 'string') {
    return null;
  }
  return {
    description: value.description ?? '',
    ...(id === undefined ? {} : { id }),
    label,
    ...(typeof value.preview === 'string' ? { preview: value.preview } : {}),
  };
}

function buildQuestionCallbackInput(questions: GrokQuestion[]): Record<string, unknown> {
  return {
    questions: questions.map((question, index) => ({
      header: `Q${index + 1}`,
      ...(question.id ? { id: question.id } : {}),
      multiSelect: question.multiSelect,
      options: question.options.map((option) => ({
        description: option.description,
        label: option.label,
        ...(option.id ? { value: option.id } : {}),
      })),
      question: question.question,
    })),
  };
}

function buildAcceptedQuestionResponse(
  questions: GrokQuestion[],
  rawAnswers: Record<string, string | string[]>,
): Record<string, unknown> {
  const answers: Record<string, string[]> = {};
  const annotations: Record<string, { preview: string }> = {};

  for (const question of questions) {
    const rawAnswer = rawAnswers[question.id ?? question.question]
      ?? rawAnswers[question.question];
    if (rawAnswer === undefined) continue;

    const values = (Array.isArray(rawAnswer) ? rawAnswer : [rawAnswer])
      .filter((entry): entry is string => typeof entry === 'string')
      .filter((entry) => entry.trim().length > 0);
    if (values.length === 0) continue;

    const selectedOptions = values.map((value) =>
      question.options.find((option) => option.id === value || option.label === value));
    answers[question.question] = values.map((value, index) =>
      selectedOptions[index]?.label ?? value);

    if (!question.multiSelect && selectedOptions.length === 1) {
      const preview = selectedOptions[0]?.preview;
      if (preview) {
        annotations[question.question] = { preview };
      }
    }
  }

  return {
    outcome: 'accepted',
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

function isValidExitPlanModeRequest(
  value: unknown,
  activeSessionId: string | null,
): boolean {
  return isRecord(value)
    && matchesActiveSession(value.sessionId, activeSessionId)
    && normalizeOpaqueString(value.toolCallId) !== null
    && (value.planContent === undefined
      || value.planContent === null
      || typeof value.planContent === 'string');
}

function isPermissionOption(value: unknown): value is AcpPermissionOption {
  if (!isRecord(value)) return false;
  return normalizeOpaqueString(value.name) !== null
    && normalizeOpaqueString(value.optionId) !== null
    && (value.kind === 'allow_once'
      || value.kind === 'allow_always'
      || value.kind === 'reject_once'
      || value.kind === 'reject_always');
}

function matchesActiveSession(value: unknown, activeSessionId: string | null): boolean {
  const sessionId = normalizeOpaqueString(value);
  return sessionId !== null && activeSessionId !== null && sessionId === activeSessionId;
}

function normalizeExtensionMethod(method: string): string {
  return method.startsWith('_x.ai/') ? method.slice(1) : method;
}

function normalizeOptionalOpaqueId(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return normalizeOpaqueString(value);
}

function normalizeOpaqueString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
