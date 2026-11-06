import type { ProviderQuestionReply } from '../../../core/providers/types';
import type { AskUserAnswers, ToolCallInfo } from '../../../core/types';
import { getCodexUserCodeRanges } from './codexUserCode';

interface CodexQuestionReply {
  callId: string;
  index: number;
  question: string;
  answer: string;
}

export function getCodexQuestionAnswerKey(id: unknown, index: number): string {
  return typeof id === 'string' || typeof id === 'number' ? String(id) : String(index);
}

export function formatCodexQuestionReply(tool: ToolCallInfo, answers: AskUserAnswers): ProviderQuestionReply | null {
  if (tool.name !== 'AskUserQuestion' || tool.input.replyMode !== 'user-message' || !Array.isArray(tool.input.questions)) return null;
  const replies = tool.input.questions.map((question: Record<string, unknown>, index) => {
    const text = typeof question.question === 'string' ? question.question : '';
    const answerKey = getCodexQuestionAnswerKey(question.id, index);
    // Own-key reads keep inherited entries from answering; ?? retains the original
    // nullish fallback while an own empty string stays owned and rejects below.
    const value = (Object.hasOwn(answers, answerKey) ? answers[answerKey] : undefined)
      ?? (Object.hasOwn(answers, text) ? answers[text] : undefined);
    const answer = Array.isArray(value) ? value.join(', ') : value;
    return { questionItemId: JSON.stringify(['request_user_input_async', tool.id, index]), question: text, answer };
  });
  if (replies.length === 0 || replies.some(reply => !reply.question || typeof reply.answer !== 'string' || !reply.answer.trim())) return null;
  return {
    content: `<send_user_message_question_reply>\n${JSON.stringify(replies).replace(/</g, '\\u003c')}\n</send_user_message_question_reply>`,
    displayContent: '',
  };
}

const QUESTION_REPLY_PATTERN = /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/g;

export function parseCodexQuestionReply(text: string): CodexQuestionReply[] {
  if (!text.includes('<send_user_message_question_reply>')) return [];
  const codeRanges = getCodexUserCodeRanges(text);
  return [...text.matchAll(QUESTION_REPLY_PATTERN)].flatMap(match =>
    codeRanges.some(range => match.index >= range.from && match.index < range.to)
      ? [] : decodeQuestionReplies(match[1]));
}

export function stripCodexQuestionReplies(text: string): string {
  if (!text.includes('<send_user_message_question_reply>')) return text;
  const codeRanges = getCodexUserCodeRanges(text);
  return text.replace(QUESTION_REPLY_PATTERN, (original, body: string, index: number) => {
    if (codeRanges.some(range => index >= range.from && index < range.to)) return original;
    const replies = decodeQuestionReplies(body);
    return replies.length > 0 ? '' : original;
  });
}

function decodeQuestionReplies(body: string): CodexQuestionReply[] {
  try {
    const entries: unknown = JSON.parse(body);
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((value: unknown): CodexQuestionReply[] => {
      const entry = value as Record<string, unknown> | null;
      if (!entry || typeof entry !== 'object' || typeof entry.questionItemId !== 'string'
        || typeof entry.question !== 'string' || typeof entry.answer !== 'string') return [];
      let identity: unknown;
      try { identity = JSON.parse(entry.questionItemId); } catch { return []; }
      if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== 'request_user_input_async'
        || typeof identity[1] !== 'string' || typeof identity[2] !== 'number' || !Number.isInteger(identity[2]) || identity[2] < 0) return [];
      return [{ callId: identity[1], index: identity[2], question: entry.question, answer: entry.answer }];
    });
  } catch { return []; }
}
