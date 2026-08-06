import type {
  ProviderInteractionDismissReason,
  ProviderInteractionPort,
} from '@/core/execution';

const PLAN_PRESENTATION = {
  allowAbandon: true,
  allowNewSession: false,
  approveLabel: 'Implement',
  dismissOnEscape: false,
  feedbackLabel: 'Reject',
  shiftTabDecision: 'abandon',
} as const;

export class CursorExtensionInteractionRouter {
  private sequence = 0;
  private readonly pending = new Map<string, AbortController>();

  constructor(
    private readonly interactionPort: ProviderInteractionPort,
    private readonly sessionInstanceId: string,
    private readonly getTurnId: () => string | null,
  ) {}

  handle(method: string, params: unknown): Promise<unknown> {
    if (method === 'cursor/ask_question') return this.handleQuestion(params);
    if (method === 'cursor/create_plan') return this.handlePlan(params);
    return Promise.reject(new Error(`Unsupported Cursor server request: ${method}`));
  }

  dispose(): void {
    this.dismissAll('session-disposed');
  }

  private async handleQuestion(params: unknown): Promise<unknown> {
    const turnId = this.getTurnId();
    const request = parseQuestionRequest(params);
    if (!turnId || !request) return { outcome: { outcome: 'cancelled' } };
    const interactionId = this.nextId('question');
    const controller = this.begin(interactionId);
    let reason: ProviderInteractionDismissReason = 'cancelled';
    try {
      const response = await this.interactionPort.askUserQuestion({
        input: {
          questions: request.questions.map((question, index) => ({
            header: `Q${index + 1}`,
            id: question.id,
            multiSelect: question.allowMultiple,
            options: question.options.map(option => ({
              description: '',
              label: option.label,
              value: option.id,
            })),
            question: question.prompt,
          })),
        },
        interactionId,
        kind: 'question',
        nativeContext: { toolCallId: request.toolCallId },
        sessionInstanceId: this.sessionInstanceId,
        turnId,
      }, controller.signal);
      if (response.interactionId !== interactionId || this.getTurnId() !== turnId) {
        reason = 'native-rejected';
        return { outcome: { outcome: 'cancelled' } };
      }
      reason = 'resolved';
      if (!response.answers) return { outcome: { outcome: 'cancelled' } };
      return {
        outcome: {
          answers: request.questions.flatMap(question => {
            const answer = response.answers?.[question.id] ?? response.answers?.[question.prompt];
            if (answer === undefined) return [];
            const values = Array.isArray(answer) ? answer : [answer];
            return [{ questionId: question.id, selectedOptionIds: values }];
          }),
          outcome: 'answered',
        },
      };
    } finally {
      this.finish(interactionId, reason);
    }
  }

  private async handlePlan(params: unknown): Promise<unknown> {
    const turnId = this.getTurnId();
    if (!turnId || !isRecord(params) || typeof params.plan !== 'string') {
      return { outcome: { outcome: 'cancelled' } };
    }
    const interactionId = this.nextId('plan');
    const controller = this.begin(interactionId);
    let reason: ProviderInteractionDismissReason = 'cancelled';
    try {
      const response = await this.interactionPort.requestPlanDecision({
        input: { planContent: params.plan },
        interactionId,
        kind: 'plan-decision',
        nativeContext: { toolCallId: params.toolCallId },
        presentation: PLAN_PRESENTATION,
        sessionInstanceId: this.sessionInstanceId,
        turnId,
      }, controller.signal);
      if (response.interactionId !== interactionId || this.getTurnId() !== turnId) {
        reason = 'native-rejected';
        return { outcome: { outcome: 'cancelled' } };
      }
      reason = 'resolved';
      return response.decision?.type === 'approve'
        ? { outcome: { outcome: 'accepted' } }
        : response.decision?.type === 'feedback'
          ? { outcome: { outcome: 'rejected', reason: response.decision.text } }
          : { outcome: { outcome: 'cancelled' } };
    } finally {
      this.finish(interactionId, reason);
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

  private finish(interactionId: string, reason: ProviderInteractionDismissReason): void {
    if (!this.pending.has(interactionId)) return;
    this.pending.delete(interactionId);
    this.interactionPort.dismissInteraction(interactionId, reason);
  }

  private dismissAll(reason: ProviderInteractionDismissReason): void {
    for (const [interactionId, controller] of this.pending) {
      this.interactionPort.dismissInteraction(interactionId, reason);
      controller.abort();
    }
    this.pending.clear();
  }
}

interface CursorQuestion {
  allowMultiple: boolean;
  id: string;
  options: Array<{ id: string; label: string }>;
  prompt: string;
}

function parseQuestionRequest(
  value: unknown,
): { questions: CursorQuestion[]; toolCallId: string } | null {
  if (!isRecord(value) || typeof value.toolCallId !== 'string' || !Array.isArray(value.questions)) {
    return null;
  }
  const questions: CursorQuestion[] = [];
  for (const entry of value.questions) {
    if (!isRecord(entry) || typeof entry.id !== 'string'
      || typeof entry.prompt !== 'string' || !Array.isArray(entry.options)) return null;
    const options: Array<{ id: string; label: string }> = [];
    for (const option of entry.options) {
      if (!isRecord(option) || typeof option.id !== 'string' || typeof option.label !== 'string') {
        return null;
      }
      options.push({ id: option.id, label: option.label });
    }
    questions.push({
      allowMultiple: entry.allowMultiple === true,
      id: entry.id,
      options,
      prompt: entry.prompt,
    });
  }
  return { questions, toolCallId: value.toolCallId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
