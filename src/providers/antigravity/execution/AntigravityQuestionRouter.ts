import {
  type PendingInteraction,
  PendingInteractionLedger,
  type ProviderInteractionDismissReason,
  type ProviderInteractionPort,
} from '../../../core/execution';
import type { AskUserAnswers } from '../../../core/types';
import type {
  ACPCreateElicitationRequest,
  ACPCreateElicitationResponse,
  ACPElicitationEnumOption,
} from '../../acp';

interface AntigravityQuestion {
  readonly fieldId: string;
  readonly multiSelect: boolean;
  readonly options: readonly ACPElicitationEnumOption[];
  readonly otherFieldId?: string;
  readonly question: string;
}

const CANCELLED: ACPCreateElicitationResponse = { action: 'cancel' };
const OTHER_FIELD_SUFFIX = '_other';

/**
 * Answers agy's `ask_question` form elicitations through Claudian's question UI. Each choice
 * field becomes one question; its `<field>_other` companion carries free-text answers.
 */
export class AntigravityQuestionRouter {
  private sequence = 0;
  private readonly pending: PendingInteractionLedger;

  constructor(
    private readonly interactionPort: ProviderInteractionPort,
    private readonly sessionInstanceId: string,
    private readonly getTurnId: () => string | null,
    private readonly getSessionId: () => string | undefined,
  ) {
    this.pending = new PendingInteractionLedger(interactionPort);
  }

  async handle(request: ACPCreateElicitationRequest, signal?: AbortSignal): Promise<ACPCreateElicitationResponse> {
    const turnId = this.getTurnId();
    const questions = parseQuestions(request);
    if (!turnId || !questions || request.sessionId !== this.getSessionId() || signal?.aborted) return CANCELLED;
    const pending = this.#begin(`${this.sessionInstanceId}:question:${++this.sequence}`, signal);
    if (!pending) return CANCELLED;
    let dismissReason: ProviderInteractionDismissReason = 'cancelled';
    try {
      const response = await this.interactionPort.askUserQuestion({
        input: {
          questions: questions.map((question, index) => ({
            header: `Q${index + 1}`,
            id: question.fieldId,
            multiSelect: question.multiSelect,
            options: question.options.map(option => ({
              description: '',
              label: option.title || option.const,
              value: option.const,
            })),
            question: question.question,
          })),
        },
        interactionId: pending.interactionId,
        kind: 'question',
        nativeContext: { sessionId: request.sessionId, ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}) },
        sessionInstanceId: this.sessionInstanceId,
        turnId,
      }, pending.signal);
      if (this.pending.isStaleResponse(pending, response) || this.getTurnId() !== turnId) {
        dismissReason = 'native-rejected';
        return CANCELLED;
      }
      dismissReason = 'resolved';
      return response.answers ? buildElicitationResponse(questions, response.answers) : { action: 'decline' };
    } catch {
      return CANCELLED;
    } finally {
      this.pending.settle(pending, dismissReason);
      this.pending.release(pending);
    }
  }

  dismissAll(reason: ProviderInteractionDismissReason): void {
    this.pending.dismissAll(reason);
  }

  /** agy asks one form at a time; a new form supersedes an unanswered one. */
  #begin(interactionId: string, signal?: AbortSignal): PendingInteraction | null {
    this.dismissAll('superseded');
    return this.pending.begin(interactionId, signal);
  }
}

function parseQuestions(request: ACPCreateElicitationRequest): AntigravityQuestion[] | null {
  const properties = request.requestedSchema?.properties;
  if (!properties || typeof properties !== 'object') return null;
  const questions: AntigravityQuestion[] = [];
  for (const [fieldId, property] of Object.entries(properties)) {
    if (fieldId.endsWith(OTHER_FIELD_SUFFIX) || !property || typeof property !== 'object') continue;
    const multiSelect = property.type === 'array';
    const options = (multiSelect
      ? property.items?.anyOf ?? property.items?.oneOf ?? property.items?.enum?.map(value => ({ const: value }))
      : property.oneOf ?? property.enum?.map(value => ({ const: value }))) ?? [];
    const otherFieldId = `${fieldId}${OTHER_FIELD_SUFFIX}`;
    questions.push({
      fieldId,
      multiSelect,
      options: options.filter(option => typeof option?.const === 'string'),
      ...(Object.hasOwn(properties, otherFieldId) ? { otherFieldId } : {}),
      question: property.title || request.message,
    });
  }
  return questions.length > 0 ? questions : null;
}

/** Choices map back to their `const` values; anything else is a free-text "Other" answer. */
function buildElicitationResponse(
  questions: readonly AntigravityQuestion[],
  answers: AskUserAnswers,
): ACPCreateElicitationResponse {
  const content: Record<string, string | string[]> = {};
  for (const question of questions) {
    const raw = (Object.hasOwn(answers, question.fieldId) ? answers[question.fieldId] : undefined)
      ?? (Object.hasOwn(answers, question.question) ? answers[question.question] : undefined);
    if (raw === undefined) continue;
    const values = (Array.isArray(raw) ? raw : [raw]).map(value => value.trim()).filter(Boolean);
    const selected: string[] = [];
    const freeText: string[] = [];
    for (const value of values) {
      // The question UI answers with option values (consts); labels are a fallback for typed answers.
      const option = question.options.find(entry => entry.const === value)
        ?? question.options.find(entry => entry.title === value);
      if (option) selected.push(option.const);
      else freeText.push(value);
    }
    if (question.multiSelect) {
      if (selected.length > 0) content[question.fieldId] = selected;
    } else if (selected[0]) {
      content[question.fieldId] = selected[0];
    }
    if (freeText.length > 0 && question.otherFieldId) content[question.otherFieldId] = freeText.join('\n');
  }
  return { action: 'accept', content };
}
