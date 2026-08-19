import { appendContextFiles } from '../../utils/context';
import { getTodayDate } from '../../utils/date';
import { formatEditorContext } from '../../utils/editor';
import type {
  InlineEditCursorRequest,
  InlineEditRequest,
  InlineEditResult,
} from '../providers/types';

export function parseInlineEditResponse(responseText: string): InlineEditResult {
  const replacementMatch = responseText.match(/<replacement>([\s\S]*?)<\/replacement>/);
  if (replacementMatch) {
    return { success: true, editedText: replacementMatch[1] };
  }

  const insertionMatch = responseText.match(/<insertion>([\s\S]*?)<\/insertion>/);
  if (insertionMatch) {
    return { success: true, insertedText: insertionMatch[1] };
  }

  const trimmed = responseText.trim();
  if (trimmed) {
    return { success: true, clarification: trimmed };
  }

  return { success: false, error: 'Empty response' };
}

function buildCursorPrompt(request: InlineEditCursorRequest): string {
  const context = formatEditorContext({
    cursorContext: request.cursorContext,
    mode: 'cursor',
    notePath: request.notePath,
  }, { includeCursorLine: true });
  return `${request.instruction}\n\n${context}`;
}

export function buildInlineEditPrompt(request: InlineEditRequest): string {
  let prompt: string;

  if (request.mode === 'cursor') {
    prompt = buildCursorPrompt(request);
  } else {
    const context = formatEditorContext({
      lineCount: request.lineCount,
      mode: 'selection',
      notePath: request.notePath,
      selectedText: request.selectedText,
      startLine: request.startLine,
    });
    prompt = `${request.instruction}\n\n${context}`;
  }

  if (request.contextFiles && request.contextFiles.length > 0) {
    prompt = appendContextFiles(prompt, request.contextFiles);
  }

  return prompt;
}

function getInlineEditRuntimeContext(vaultPath: string): string {
  return `## Runtime Context

You are Claudian, an editor operating inside an Obsidian Vault. The current working directory is the Vault root.
Vault absolute path: ${vaultPath}
Current date: ${getTodayDate()}.
Resolve Vault-relative context paths against the Vault absolute path before using read-only tools; use already-absolute paths directly.`;
}

function getInlineEditInputContext(): string {
  return `## Input Context

The user's instruction comes first, followed by one editor context tag and optional context-file references. Treat content inside \`<![CDATA[...]]>\` as literal editor text.

- \`<editor_selection path="path/to/file.md" lines="10-15">\`: The selected text to replace or answer a question about.
- \`<editor_cursor path="path/to/file.md" line="8">\`: Text around the insertion point. The \`|\` marker is the cursor; \`#inline\` and \`#inbetween\` describe its placement.
- \`<context_files><context_file path="path/to/context" /></context_files>\`: Additional file or directory references.`;
}

function getInlineEditPrinciples(): string {
  return `## Editing Principles

- Match the user's tone, voice, formatting, indentation, and surrounding structure.
- Preserve valid Markdown, prose flow, and code syntax as applicable.
- Use the supplied editor context first. Inspect additional content only when needed to complete the request accurately.
- Use available read-only tools silently. Never modify files through tools.`;
}

function getInlineEditOutputContract(): string {
  return `## Output Contract

Return only the final result. Do not announce tool use, analysis, or completed work.

- To modify selected text, return \`<replacement>replacement text</replacement>\` with no explanation outside the tag.
- To insert at the cursor, return \`<insertion>inserted text</insertion>\` with no explanation outside the tag.
- To answer a question, respond with plain text and no wrapper tag.
- If the request is ambiguous, ask one concise, specific question in plain text.`;
}

export function getInlineEditSystemPrompt(vaultPath: string): string {
  return [
    getInlineEditRuntimeContext(vaultPath),
    getInlineEditInputContext(),
    getInlineEditPrinciples(),
    getInlineEditOutputContract(),
  ].join('\n\n');
}
