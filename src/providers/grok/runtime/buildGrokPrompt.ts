import type { ChatTurnRequest } from '../../../core/runtime/types';
import type { ChatMessage } from '../../../core/types';
import { appendBrowserContext } from '../../../utils/browser';
import { appendCanvasContext } from '../../../utils/canvas';
import { appendCurrentNote, stripCurrentNoteContext } from '../../../utils/context';
import { appendEditorContext } from '../../../utils/editor';
import { buildContextFromHistory, buildPromptWithHistoryContext } from '../../../utils/session';
import type { AcpContentBlock } from '../../acp';

export function buildGrokTurnPromptText(request: ChatTurnRequest): string {
  let prompt = request.text;

  if (request.currentNotePath) {
    prompt = appendCurrentNote(prompt, request.currentNotePath);
  }

  if (request.editorSelection && request.editorSelection.mode !== 'none') {
    prompt = appendEditorContext(prompt, request.editorSelection);
  }

  if (request.browserSelection) {
    prompt = appendBrowserContext(prompt, request.browserSelection);
  }

  if (request.canvasSelection) {
    prompt = appendCanvasContext(prompt, request.canvasSelection);
  }

  return prompt;
}

export function buildGrokPromptWithHistory(
  prompt: string,
  conversationHistory: ChatMessage[],
): string {
  if (conversationHistory.length === 0) {
    return prompt;
  }

  const historyContext = buildContextFromHistory(conversationHistory);
  if (!historyContext.trim()) {
    return prompt;
  }

  const actualPrompt = stripCurrentNoteContext(prompt);
  return buildPromptWithHistoryContext(
    historyContext,
    prompt,
    actualPrompt,
    conversationHistory,
  );
}

export function buildGrokSystemIntegrationPrompt(
  baseSystemPrompt: string,
  isFollowupTurn: boolean,
): string {
  if (!isFollowupTurn) {
    return baseSystemPrompt;
  }

  return `${baseSystemPrompt}

## Grok Build Claudian Integration

Startup greeting rules from vault instructions apply only to the first assistant reply in a new Claudian conversation. This is a resumed conversation, so do not repeat startup greetings. Answer the user's current message directly using the existing conversation context.`;
}

export function buildGrokFollowupTurnPrompt(
  prompt: string,
  isFollowupTurn: boolean,
): string {
  if (!isFollowupTurn) {
    return prompt;
  }

  return `<claudian_followup_reminder>
This is a follow-up turn in an existing Claudian conversation using Grok Build session resume. Continue the prior conversation and answer the user's current message directly. Do not run first-session startup rituals.
</claudian_followup_reminder>

${prompt}`;
}

export function buildGrokAcpPromptText(
  systemPrompt: string,
  promptText: string,
  isFollowupTurn: boolean,
): string {
  const integrationPrompt = buildGrokSystemIntegrationPrompt(systemPrompt, isFollowupTurn);
  return `<claudian_system_prompt>\n${integrationPrompt}\n</claudian_system_prompt>\n\n${buildGrokFollowupTurnPrompt(promptText, isFollowupTurn)}`;
}

export function buildGrokAcpPromptBlocks(text: string): AcpContentBlock[] {
  return [{ type: 'text', text }];
}
