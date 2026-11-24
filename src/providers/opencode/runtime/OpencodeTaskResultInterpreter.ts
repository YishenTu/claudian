import { NOOP_TASK_RESULT_INTERPRETER } from '../../../core/providers/NoopTaskResultInterpreter';
import type { ProviderTaskResultInterpreter } from '../../../core/providers/types';
import { extractToolResultContent } from '../../../core/tools/toolResultContent';
import { isRecord } from '../http/OpencodeHTTPClient';

/** Native session IDs correlate OpenCode background launches with completion events. */
export const opencodeTaskResultInterpreter: ProviderTaskResultInterpreter = {
  ...NOOP_TASK_RESULT_INTERPRETER,
  /**
   * A spawn whose child still runs when it returns continues in the background. The native result
   * metadata says so directly; the launch wording is the fallback for results stored without it.
   */
  interpretLaunch(result, isError, providerPayload) {
    const text = extractToolResultContent(result, { fallbackIndent: 2 });
    const rawOutput = providerPayload?.rawOutput;
    const metadata = isRecord(rawOutput) && isRecord(rawOutput.metadata) ? rawOutput.metadata : undefined;
    const sessionId = typeof metadata?.sessionID === 'string' && metadata.sessionID ? metadata.sessionID : null;
    if (sessionId && typeof metadata?.status === 'string') {
      return { mode: metadata.status === 'running' && !isError ? 'async' : 'sync', agentId: sessionId, result: text };
    }
    const background = /^The subagent is working in the background \(sessionID: (ses_[^)\s]+)\)/u.exec(text);
    const completed = /^<subagent sessionID="(ses_[^"]+)" state="completed">/u.exec(text);
    return { mode: background && !isError ? 'async' : 'sync', agentId: sessionId ?? background?.[1] ?? completed?.[1] ?? null, result: text };
  },
  /** V2 wraps a finished child's answer in a native envelope that the card must not show. */
  interpretResult(result, isError) {
    const text = extractToolResultContent(result, { fallbackIndent: 2 });
    const envelope = /^\s*<subagent sessionID="[^"]*" state="([^"]*)">\n?([\s\S]*?)\n?<\/subagent>\s*$/u.exec(text);
    if (!envelope) return NOOP_TASK_RESULT_INTERPRETER.interpretResult(result, isError, { mode: 'sync' });
    return { status: isError || envelope[1] !== 'completed' ? 'error' : 'completed', result: envelope[2] };
  },
  describeTask(input) {
    return {
      mode: input.run_in_background === true ? 'async' : input.run_in_background === false ? 'sync' : null,
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
    };
  },
};
