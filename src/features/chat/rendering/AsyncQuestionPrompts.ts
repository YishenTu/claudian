import { TOOL_ASK_USER_QUESTION } from '../../../core/tools/toolNames';
import type { AskUserAnswers, ToolCallInfo } from '../../../core/types';
import type { InlineInteractionPrompts } from './InlineInteractionPrompts';

interface AsyncQuestionPromptsDeps {
  prompts: InlineInteractionPrompts;
  answer(tool: ToolCallInfo, answers: AskUserAnswers): Promise<void>;
  onChange(tool: ToolCallInfo): void;
  onPendingChange(id: string, pending: boolean): void;
}

/** Live question ownership is independent of collapsible transcript rendering. */
export class AsyncQuestionPrompts {
  private readonly pending = new Map<string, { tool: ToolCallInfo; abort: AbortController }>();

  constructor(private readonly deps: AsyncQuestionPromptsDeps) {}

  update(tool: ToolCallInfo): void {
    if (tool.name !== TOOL_ASK_USER_QUESTION || tool.input.replyMode !== 'user-message') return;
    const current = this.pending.get(tool.id);
    const expired = tool.questionStatus === 'expired' || tool.status === 'error' || tool.status === 'blocked';
    if (current) {
      current.tool = tool;
      if (expired || tool.resolvedAnswers) {
        current.abort.abort();
        this.#finish(tool.id, current);
      }
      return;
    }
    if (expired || tool.resolvedAnswers || !Array.isArray(tool.input.questions) || !tool.input.questions.length) return;

    const entry = { tool, abort: new AbortController() };
    this.pending.set(tool.id, entry);
    tool.questionStatus = 'pending';
    const interactionId = `async-question:${tool.id}`;
    this.deps.onPendingChange(interactionId, true);
    this.deps.onChange(tool);
    void this.deps.prompts.askUserQuestion(interactionId, tool.input, entry.abort.signal, {
      onSubmit: async answers => {
        if (entry.abort.signal.aborted) throw new Error('This question has expired.');
        await this.deps.answer(entry.tool, answers);
        if (!entry.abort.signal.aborted) entry.tool.resolvedAnswers = answers;
      },
    }).catch(() => null).finally(() => this.#finish(tool.id, entry));
  }

  expireAll(): void {
    for (const [id, entry] of this.pending) {
      entry.abort.abort();
      this.#finish(id, entry);
    }
  }

  #finish(id: string, entry: { tool: ToolCallInfo; abort: AbortController }): void {
    if (this.pending.get(id) !== entry) return;
    this.pending.delete(id);
    entry.tool.questionStatus = entry.tool.resolvedAnswers ? undefined : 'expired';
    this.deps.onPendingChange(`async-question:${id}`, false);
    this.deps.onChange(entry.tool);
  }
}
