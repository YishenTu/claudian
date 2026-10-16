import type { ChatMessage } from '@/core/types';

import { buildPromptWithHistoryContext } from './historyContext';

/** Envelope for replaying Claudian history into a fresh native session; history parsers strip it. */
const RECOVERY_HISTORY_PREFIX = '<claudian_recovery_history length="';
const RECOVERY_HISTORY_HEADER_SUFFIX = '">\n';
const RECOVERY_HISTORY_SUFFIX = '\n</claudian_recovery_history>';
const RECOVERY_INPUT_PREFIX = '\n\nUser: ';

export interface DecodedRecoveryPrompt {
  currentInput: string | null;
}

export function encodeRecoveryPrompt(
  historyContext: string,
  currentInput: string | null,
): string {
  const historyBlock = `${RECOVERY_HISTORY_PREFIX}${historyContext.length}`
    + `${RECOVERY_HISTORY_HEADER_SUFFIX}${historyContext}${RECOVERY_HISTORY_SUFFIX}`;
  return currentInput === null
    ? historyBlock
    : `${historyBlock}${RECOVERY_INPUT_PREFIX}${currentInput}`;
}

export function decodeRecoveryPrompt(prompt: string): DecodedRecoveryPrompt | null {
  if (!prompt.startsWith(RECOVERY_HISTORY_PREFIX)) {
    return null;
  }

  const lengthEnd = prompt.indexOf(RECOVERY_HISTORY_HEADER_SUFFIX);
  if (lengthEnd < RECOVERY_HISTORY_PREFIX.length) {
    return null;
  }
  const historyLength = Number(prompt.slice(RECOVERY_HISTORY_PREFIX.length, lengthEnd));
  if (!Number.isSafeInteger(historyLength) || historyLength < 0) {
    return null;
  }

  const historyStart = lengthEnd + RECOVERY_HISTORY_HEADER_SUFFIX.length;
  const historyEnd = historyStart + historyLength;
  if (prompt.slice(historyEnd, historyEnd + RECOVERY_HISTORY_SUFFIX.length)
    !== RECOVERY_HISTORY_SUFFIX) {
    return null;
  }

  const remainder = prompt.slice(historyEnd + RECOVERY_HISTORY_SUFFIX.length);
  if (!remainder) {
    return { currentInput: null };
  }
  if (!remainder.startsWith(RECOVERY_INPUT_PREFIX)) {
    return null;
  }
  return { currentInput: remainder.slice(RECOVERY_INPUT_PREFIX.length) };
}

/** Replays history into a fresh native session, omitting the input when history already ends with it. */
export function buildRecoveryPrompt(
  historyContext: string,
  prompt: string,
  history: ChatMessage[],
): string {
  const repeatsLastInput = buildPromptWithHistoryContext(historyContext, prompt, prompt, history) === historyContext;
  return encodeRecoveryPrompt(historyContext, repeatsLastInput ? null : prompt);
}

/** The visible user input of an envelope; other text is returned unchanged. */
export function unwrapRecoveryPrompt(text: string): string {
  const recovery = decodeRecoveryPrompt(text);
  return recovery ? recovery.currentInput ?? '' : text;
}
