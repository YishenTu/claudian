import type { AskUserQuestionItem } from '@/core/types';

import { isRecord } from './OpencodeHTTPClient';

/** Native question-tool titles are tab headers; descriptions contain the question. */
export function projectOpencodeFormQuestions(form: Record<string, unknown>): AskUserQuestionItem[] {
  const fields = Array.isArray(form.fields) ? form.fields.filter(isRecord) : [];
  const questionTool = isRecord(form.metadata) && form.metadata.kind === 'question';
  const mcpForm = isRecord(form.metadata) && form.metadata.kind === 'mcp-elicitation';
  const unsupported = fields.some(field => {
    if (!['string', 'multiselect', 'number', 'integer', 'boolean'].includes(String(field.type))
      || field.hidden === true || (Array.isArray(field.when) && field.when.length > 0)) return true;
    if (!mcpForm) return false;
    // The question UI cannot omit fields, apply defaults, or validate richer schemas.
    // Reject these explicitly instead of changing the native form's answer semantics.
    return field.required !== true || field.default !== undefined
      || ['number', 'integer'].includes(String(field.type))
      || ['format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'maxItems'].some(key => field[key] !== undefined)
      || (field.type === 'multiselect' && field.minItems !== 1);
  });
  if (!fields.length || unsupported) throw new Error('Unsupported OpenCode form: this form requires field semantics unavailable in Claudian.');
  return fields.map(field => ({
    id: String(field.key),
    header: String(questionTool ? field.title ?? 'Question' : form.title ?? 'Question'),
    question: questionTool ? String(field.description ?? field.title ?? field.key) : [...new Set([
      isRecord(form.metadata) ? form.metadata.message : undefined,
      field.title, field.description,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0))].join('\n\n') || String(field.key),
    multiSelect: field.type === 'multiselect',
    isOther: field.custom === true || ['number', 'integer'].includes(String(field.type)) || (field.type === 'string' && !Array.isArray(field.options)),
    options: field.type === 'boolean' ? [{ label: 'True', value: 'true', description: '' }, { label: 'False', value: 'false', description: '' }] : Array.isArray(field.options) ? field.options.filter(isRecord).map(option => ({
      label: String(option.label), value: typeof option.value === 'string' ? option.value : String(option.label), description: typeof option.description === 'string' ? option.description : '',
    })) : [],
  }));
}
