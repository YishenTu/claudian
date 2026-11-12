import type { AskUserAnswers, AskUserQuestionItem, AskUserQuestionOption } from '@/core/types/tools';

/** The value an option submits: its explicit value, else its label. */
export function askOptionValue(option: AskUserQuestionOption): string {
  return option.value ?? option.label;
}

/** Parses tool input into the questions the prompt shows; malformed entries are skipped. */
export function parseAskUserQuestions(input: Record<string, unknown>): AskUserQuestionItem[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];

  return (raw as unknown[])
    .filter((q): q is Record<string, unknown> & { question: string } => {
      if (!q || typeof q !== 'object' || Array.isArray(q)) return false;
      const record = q as Record<string, unknown>;
      return typeof record.question === 'string'
        && ((Array.isArray(record.options) && record.options.length > 0) || record.isOther === true);
    })
    .map((q, idx) => ({
      question: q.question,
      id: typeof q.id === 'string' ? q.id : undefined,
      header: typeof q.header === 'string' ? q.header.slice(0, 12) : `Q${idx + 1}`,
      options: deduplicateOptions((Array.isArray(q.options) ? q.options as unknown[] : []).map(coerceOption)),
      multiSelect: q.multiSelect === true,
      isOther: q.isOther === true,
      isSecret: q.isSecret === true,
    }));
}

/** The answers key a question is submitted under. */
export function askQuestionKey(question: AskUserQuestionItem): string {
  return question.id ?? question.question;
}

/**
 * Checks answers the way the prompt builds them: every question answered under its key, single
 * questions with one string and multi-select ones with a non-empty array. A value must be an
 * option's value unless the question allows custom text, which a multi-select answer holds once.
 */
export function validateAskUserAnswers(
  questions: readonly AskUserQuestionItem[],
  answers: AskUserAnswers,
  allowCustom = true,
): string | null {
  const keys = new Set(questions.map(askQuestionKey));
  for (const key of Object.keys(answers)) {
    if (!keys.has(key)) return `Unknown question "${key}"`;
  }
  for (const question of questions) {
    const key = askQuestionKey(question);
    if (!Object.prototype.hasOwnProperty.call(answers, key)) return `Missing an answer for "${key}"`;
    const answer = answers[key];
    const values = question.multiSelect ? answer : [answer];
    if (!Array.isArray(values) || values.length === 0 || (!question.multiSelect && Array.isArray(answer))) {
      return `Answer for "${key}" must be ${question.multiSelect ? 'a non-empty array of strings' : 'a string'}`;
    }
    const optionValues = new Set(question.options.map(askOptionValue));
    let custom = 0;
    for (const value of values) {
      if (typeof value !== 'string' || !value.trim()) return `Answer for "${key}" must be a non-empty string`;
      if (optionValues.has(value)) continue;
      if (!allowCustom || !question.isOther || ++custom > 1) return `"${value}" is not an option for "${key}"`;
    }
  }
  return null;
}

function coerceOption(opt: unknown): AskUserQuestionOption {
  if (typeof opt === 'object' && opt !== null) {
    const obj = opt as Record<string, unknown>;
    const label = extractLabel(obj);
    const description = typeof obj.description === 'string' ? obj.description : '';
    const value = extractValue(obj, label);
    return { label, description, ...(value !== label ? { value } : {}) };
  }
  return { label: stringifyOptionValue(opt), description: '' };
}

function deduplicateOptions(options: AskUserQuestionOption[]): AskUserQuestionOption[] {
  const seen = new Set<string>();
  return options.filter((o) => {
    const value = askOptionValue(o);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function extractLabel(obj: Record<string, unknown>): string {
  if (typeof obj.label === 'string') return obj.label;
  if (typeof obj.value === 'string') return obj.value;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.name === 'string') return obj.name;
  return 'Option';
}

function stringifyOptionValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }
  return 'Option';
}

function extractValue(obj: Record<string, unknown>, fallback: string): string {
  if (typeof obj.value === 'string') return obj.value;
  if (typeof obj.id === 'string') return obj.id;
  return fallback;
}
