import type {
  ProviderTaskResultInterpreter,
  ProviderTaskTerminalStatus,
} from './types';

export const NOOP_TASK_RESULT_INTERPRETER: ProviderTaskResultInterpreter = Object.freeze({
  hasAsyncLaunchMarker(): boolean {
    return false;
  },

  extractAgentId(): string | null {
    return null;
  },

  extractStructuredResult(): string | null {
    return null;
  },

  resolveTerminalStatus(
    _toolUseResult: unknown,
    fallbackStatus: ProviderTaskTerminalStatus,
  ): ProviderTaskTerminalStatus {
    return fallbackStatus;
  },

  extractTagValue(): string | null {
    return null;
  },
});
