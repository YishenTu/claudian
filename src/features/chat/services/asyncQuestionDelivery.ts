import { Notice } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderQuestionReply } from '@/core/providers/types';
import type { AskUserAnswers, ProviderId, ToolCallInfo } from '@/core/types';

export type QuestionSteerResult = 'accepted' | 'not-sent' | 'uncertain';

export interface QuestionReply extends ProviderQuestionReply {
  readonly draftContent: string;
}

interface QuestionDeliveryBinding {
  readonly providerId: ProviderId;
  assertCurrent(): void;
  prepare(reply: QuestionReply): {
    /** Provider acceptance may precede the acknowledgement; retain native reconciliation locally. */
    steer(onDelivery: (accepted: boolean) => void): Promise<QuestionSteerResult>;
    /** Report acceptance on queue admission or provider handoff, not on turn completion. */
    submit(onDelivery: (accepted: boolean) => void, assertBeforeHandoff: () => void): Promise<void>;
  };
}

/** One admission policy for async answers, with destination-owned execution and queue mechanics. */
export async function deliverAsyncQuestion(
  tool: ToolCallInfo,
  answers: AskUserAnswers,
  binding: QuestionDeliveryBinding,
  signal?: AbortSignal,
): Promise<void> {
  const notSent = () => new Error('The answer was not sent. Please try again.');
  const assertCurrent = () => {
    if (signal?.aborted || tool.questionStatus === 'expired') throw notSent();
    binding.assertCurrent();
  };
  assertCurrent();
  const reply = ProviderRegistry.formatQuestionReply(binding.providerId, tool, answers);
  if (!reply) throw new Error('This question cannot accept that reply.');
  const delivery = binding.prepare({
    ...reply,
    draftContent: Object.values(answers).map(answer => Array.isArray(answer) ? answer.join(', ') : answer).join('\n'),
  });
  await new Promise<void>((resolve, reject) => {
    const onDelivery = (accepted: boolean) => accepted ? resolve() : reject(notSent());
    const send = async () => {
      const result = await delivery.steer(onDelivery);
      if (result !== 'not-sent') {
        if (result === 'uncertain') {
          new Notice('Answer delivery could not be confirmed. It was not requeued to avoid sending it twice.');
        }
        resolve();
        return;
      }
      assertCurrent();
      await delivery.submit(onDelivery, assertCurrent);
    };
    void send().catch(reject);
  });
}
