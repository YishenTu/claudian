import { NOOP_TASK_RESULT_INTERPRETER } from '../../../core/providers/NoopTaskResultInterpreter';
import type { ProviderTaskResultInterpreter } from '../../../core/providers/types';
import { extractToolResultContent } from '../../../core/tools/toolResultContent';

/** Native session IDs correlate OpenCode background launches with completion events. */
export const opencodeTaskResultInterpreter: ProviderTaskResultInterpreter = {
  ...NOOP_TASK_RESULT_INTERPRETER,
  interpretLaunch(result, isError) {
    const text = extractToolResultContent(result, { fallbackIndent: 2 });
    const background = /^The subagent is working in the background \(sessionID: (ses_[^)\s]+)\)/u.exec(text);
    const completed = /^<subagent sessionID="(ses_[^"]+)" state="completed">/u.exec(text);
    return { mode: background && !isError ? 'async' : 'sync', agentId: background?.[1] ?? completed?.[1] ?? null, result: text };
  },
  describeTask(input) {
    return {
      mode: input.run_in_background === true ? 'async' : input.run_in_background === false ? 'sync' : null,
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
    };
  },
};
