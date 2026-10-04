import { NOOP_TASK_RESULT_INTERPRETER } from '@/core/providers/NoopTaskResultInterpreter';
import type { ProviderTaskResultInterpreter } from '@/core/providers/types';

export const antigravityTaskResultInterpreter: ProviderTaskResultInterpreter = {
  ...NOOP_TASK_RESULT_INTERPRETER,
};
