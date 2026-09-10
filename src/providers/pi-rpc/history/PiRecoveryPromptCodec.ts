const RECOVERY_HISTORY_PREFIX = '<claudian_recovery_history length="';
const RECOVERY_HISTORY_HEADER_SUFFIX = '">\n';
const RECOVERY_HISTORY_SUFFIX = '\n</claudian_recovery_history>';
const RECOVERY_INPUT_PREFIX = '\n\nUser: ';

export interface DecodedPiRecoveryPrompt {
  currentInput: string | null;
}

export function encodePiRecoveryPrompt(
  historyContext: string,
  currentInput: string | null,
): string {
  const historyBlock = `${RECOVERY_HISTORY_PREFIX}${historyContext.length}`
    + `${RECOVERY_HISTORY_HEADER_SUFFIX}${historyContext}${RECOVERY_HISTORY_SUFFIX}`;
  return currentInput === null
    ? historyBlock
    : `${historyBlock}${RECOVERY_INPUT_PREFIX}${currentInput}`;
}

export function decodePiRecoveryPrompt(prompt: string): DecodedPiRecoveryPrompt | null {
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
