import type {
  ProviderInteractionDismissReason,
  ProviderInteractionPort,
} from '../../../core/execution';

const PLAN_PRESENTATION = {
  allowAbandon: true,
  allowNewSession: false,
  approveLabel: 'Implement',
  dismissOnEscape: false,
  feedbackLabel: 'Revise',
  shiftTabDecision: 'abandon',
} as const;

interface GrokQuestionOption {
  readonly description: string;
  readonly id?: string;
  readonly label: string;
  readonly preview?: string;
}

interface GrokQuestion {
  readonly id?: string;
  readonly multiSelect: boolean;
  readonly options: readonly GrokQuestionOption[];
  readonly question: string;
}

export class GrokExecutionInteractionRouter {
  private sequence = 0;
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly interactionPort: ProviderInteractionPort,
    private readonly sessionInstanceId: string,
    private readonly getTurnId: () => string | null,
    private readonly getSessionId: () => string | undefined,
  ) {}

  async handle(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const normalized = method.startsWith('_x.ai/') ? method.slice(1) : method;
    if (normalized === 'x.ai/ask_user_question') {
      return this.handleQuestion(params, signal);
    }
    if (normalized === 'x.ai/exit_plan_mode') {
      return this.handlePlan(params, signal);
    }
    throw new Error(`Unsupported Grok server request: ${method}`);
  }

  dismissAll(reason: ProviderInteractionDismissReason): void {
    for (const [interactionId, controller] of this.pending) {
      this.interactionPort.dismissInteraction(interactionId, reason);
      controller.abort();
    }
    this.pending.clear();
  }

  private async handleQuestion(params: unknown, signal?: AbortSignal): Promise<unknown> {
    const turnId = this.getTurnId();
    const request = parseQuestionRequest(params, this.getSessionId());
    if (!turnId || !request || signal?.aborted) return { outcome: 'cancelled' };
    const interactionId = this.nextId('question');
    const controller = this.begin(interactionId);
    let dismissReason: ProviderInteractionDismissReason = 'cancelled';
    try {
      const response = await this.interactionPort.askUserQuestion({
        input: {
          questions: request.questions.map((question, index) => ({
            header: `Q${index + 1}`,
            ...(question.id ? { id: question.id } : {}),
            multiSelect: question.multiSelect,
            options: question.options.map(option => ({
              description: option.description,
              label: option.label,
              ...(option.id ? { value: option.id } : {}),
            })),
            question: question.question,
          })),
        },
        interactionId,
        kind: 'question',
        nativeContext: { sessionId: request.sessionId, toolCallId: request.toolCallId },
        sessionInstanceId: this.sessionInstanceId,
        turnId,
      }, controller.signal);
      if (response.interactionId !== interactionId || this.getTurnId() !== turnId) {
        dismissReason = 'native-rejected';
        return { outcome: 'cancelled' };
      }
      dismissReason = 'resolved';
      return response.answers
        ? buildQuestionResponse(request.questions, response.answers)
        : { outcome: 'cancelled' };
    } catch {
      return { outcome: 'cancelled' };
    } finally {
      this.finish(interactionId, dismissReason);
    }
  }

  private async handlePlan(params: unknown, signal?: AbortSignal): Promise<unknown> {
    const turnId = this.getTurnId();
    if (!turnId || !matchesSession(params, this.getSessionId()) || signal?.aborted) {
      return { outcome: 'cancelled' };
    }
    const record = params as Record<string, unknown>;
    const interactionId = this.nextId('plan');
    const controller = this.begin(interactionId);
    let dismissReason: ProviderInteractionDismissReason = 'cancelled';
    try {
      const response = await this.interactionPort.requestPlanDecision({
        input: typeof record.planContent === 'string'
          ? { planContent: record.planContent }
          : {},
        interactionId,
        kind: 'plan-decision',
        nativeContext: { sessionId: record.sessionId, toolCallId: record.toolCallId },
        presentation: PLAN_PRESENTATION,
        sessionInstanceId: this.sessionInstanceId,
        turnId,
      }, controller.signal);
      if (response.interactionId !== interactionId || this.getTurnId() !== turnId) {
        dismissReason = 'native-rejected';
        return { outcome: 'cancelled' };
      }
      dismissReason = 'resolved';
      switch (response.decision?.type) {
        case 'approve':
          return { outcome: 'approved' };
        case 'abandon':
          return { outcome: 'abandoned' };
        case 'feedback':
          return response.decision.text.trim()
            ? { feedback: response.decision.text.trim(), outcome: 'cancelled' }
            : { outcome: 'cancelled' };
        default:
          return { outcome: 'cancelled' };
      }
    } catch {
      return { outcome: 'cancelled' };
    } finally {
      this.finish(interactionId, dismissReason);
    }
  }

  private nextId(kind: string): string {
    return `${this.sessionInstanceId}:${kind}:${++this.sequence}`;
  }

  private begin(interactionId: string): AbortController {
    this.dismissAll('superseded');
    const controller = new AbortController();
    this.pending.set(interactionId, controller);
    return controller;
  }

  private finish(
    interactionId: string,
    reason: ProviderInteractionDismissReason,
  ): void {
    if (!this.pending.has(interactionId)) return;
    this.pending.delete(interactionId);
    this.interactionPort.dismissInteraction(interactionId, reason);
  }
}

function parseQuestionRequest(
  value: unknown,
  sessionId: string | undefined,
): { questions: GrokQuestion[]; sessionId: string; toolCallId: string } | null {
  if (!matchesSession(value, sessionId)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.toolCallId !== 'string' || !Array.isArray(record.questions)) return null;
  const questions: GrokQuestion[] = [];
  for (const value of record.questions) {
    if (!isRecord(value) || typeof value.question !== 'string' || !Array.isArray(value.options)) {
      return null;
    }
    const options: GrokQuestionOption[] = [];
    for (const option of value.options) {
      if (!isRecord(option) || typeof option.label !== 'string') return null;
      options.push({
        description: typeof option.description === 'string' ? option.description : '',
        ...(typeof option.id === 'string' ? { id: option.id } : {}),
        label: option.label,
        ...(typeof option.preview === 'string' ? { preview: option.preview } : {}),
      });
    }
    questions.push({
      ...(typeof value.id === 'string' ? { id: value.id } : {}),
      multiSelect: value.multiSelect === true,
      options,
      question: value.question,
    });
  }
  return {
    questions,
    sessionId: sessionId!,
    toolCallId: record.toolCallId,
  };
}

function buildQuestionResponse(
  questions: readonly GrokQuestion[],
  rawAnswers: Record<string, string | string[]>,
): Record<string, unknown> {
  const answers: Record<string, string[]> = {};
  const annotations: Record<string, { preview: string }> = {};
  for (const question of questions) {
    const values = rawAnswers[question.id ?? question.question] ?? rawAnswers[question.question];
    if (values === undefined) continue;
    const normalized = (Array.isArray(values) ? values : [values]).filter(Boolean);
    answers[question.question] = normalized.map(value => (
      question.options.find(option => option.id === value || option.label === value)?.label ?? value
    ));
    if (!question.multiSelect && normalized.length === 1) {
      const selected = question.options.find(
        option => option.id === normalized[0] || option.label === normalized[0],
      );
      if (selected?.preview) annotations[question.question] = { preview: selected.preview };
    }
  }
  return {
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    answers,
    outcome: 'accepted',
  };
}

function matchesSession(value: unknown, sessionId: string | undefined): boolean {
  return isRecord(value) && typeof value.sessionId === 'string' && value.sessionId === sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
