import { NOOP_TASK_RESULT_INTERPRETER } from '../../../core/providers/NoopTaskResultInterpreter';
import type { ProviderTaskResultInterpreter } from '../../../core/providers/types';

/** OpenCode task output is display text; it is not a Claude TaskOutput envelope. */
export const opencodeTaskResultInterpreter: ProviderTaskResultInterpreter = {
  ...NOOP_TASK_RESULT_INTERPRETER,
  describeTask(input) {
    return {
      mode: input.run_in_background === true ? 'async' : input.run_in_background === false ? 'sync' : null,
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
    };
  },
};
