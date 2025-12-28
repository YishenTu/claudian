/**
 * AskUserQuestion tool type definitions.
 *
 * Types for the AskUserQuestion tool that allows Claude to ask
 * clarifying questions during execution.
 */

/** A single option in a question. */
export interface AskUserQuestionOption {
  /** Display text for this option (1-5 words). */
  label: string;
  /** Explanation of what this option means. */
  description: string;
}

/** A single question to ask the user. */
export interface AskUserQuestionQuestion {
  /** The complete question text. */
  question: string;
  /** Short label for the tab/header (max 12 chars). */
  header: string;
  /** Allow multiple selections if true. */
  multiSelect: boolean;
  /** Available choices (2-4 options). */
  options: AskUserQuestionOption[];
}

/** Input for the AskUserQuestion tool. */
export interface AskUserQuestionInput {
  /** Array of 1-4 questions to ask. */
  questions: AskUserQuestionQuestion[];
  /** User's answers (added after user responds). */
  answers?: Record<string, string | string[]>;
}

/** Callback type for handling AskUserQuestion tool calls. */
export type AskUserQuestionCallback = (
  input: AskUserQuestionInput
) => Promise<Record<string, string | string[]> | null>;
