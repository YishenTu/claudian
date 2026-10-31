/** Outbound Grok extension request fields inspected by native peer tests. */
export function grokForkRequest(params: Record<string, unknown>): {
  sourceSessionId: string; targetPromptIndex: number; newCwd: string;
} {
  const { sourceSessionId, targetPromptIndex, newCwd } = params;
  if (typeof sourceSessionId !== 'string' || typeof targetPromptIndex !== 'number' || typeof newCwd !== 'string') {
    throw new Error('Invalid Grok fork request');
  }
  return { sourceSessionId, targetPromptIndex, newCwd };
}

type TextPrompt = [{ type: 'text'; text: string }, ...unknown[]];
function isTextPrompt(prompt: unknown): prompt is TextPrompt {
  if (!Array.isArray(prompt)) return false;
  const first: unknown = prompt[0];
  return !!first && typeof first === 'object' && 'type' in first && first.type === 'text' && 'text' in first && typeof first.text === 'string';
}

/** Text-first prompts used by chat/fork scenarios; fail if native receives a different shape. */
export function grokTextPromptRequest(params: Record<string, unknown>): {
  sessionId: string; prompt: TextPrompt;
} {
  const { sessionId, prompt } = params;
  if (typeof sessionId !== 'string' || !isTextPrompt(prompt)) throw new Error('Expected a Grok text prompt');
  return { sessionId, prompt };
}
