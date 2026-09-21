import { extractToolResultContent } from '../tools/toolResultContent';
import type { ProviderTaskResultInterpreter } from './types';

/** Providers without managed-task semantics retain their output as plain content. */
export const NOOP_TASK_RESULT_INTERPRETER: ProviderTaskResultInterpreter = Object.freeze({
  describeTask: () => ({ mode: null }),
  interpretLaunch: (result: unknown) => ({
    mode: 'sync' as const,
    agentId: null,
    result: extractToolResultContent(result, { fallbackIndent: 2 }),
  }),
  getOutputTaskId: () => null,
  interpretResult: (result: unknown, isError: boolean) => ({
    status: isError ? 'error' as const : 'completed' as const,
    result: extractToolResultContent(result, { fallbackIndent: 2 }),
  }),
});
