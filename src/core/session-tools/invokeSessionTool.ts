import type { ProviderToolPolicy } from '@/core/execution/ProviderExecutionRequest';
import {
  isSessionToolPolicyAllowed,
  type ProviderSessionToolPort,
} from '@/core/execution/ProviderSessionToolPort';
import { TOOL_CLAUDIAN_LIST_DESTINATIONS, TOOL_CLAUDIAN_SEND_MESSAGE } from '@/core/tools/toolNames';

import { decodeSessionToolCall, type SessionToolResult } from './sessionToolSpecs';

export interface SessionToolInvocation {
  /** Absent when the session was not configured as a main chat. */
  readonly port: ProviderSessionToolPort | undefined;
  /** Policy of the run that owns the native call; absent when no run owns it. */
  readonly toolPolicy: ProviderToolPolicy | undefined;
  /** Signal of the run that owns the native call, merged with any native cancellation. */
  readonly signal: AbortSignal;
}

const DENIED = 'Session tools are only available in Claudian main chat sessions with the default tool policy.';
const CANCELLED = 'The session tool call was cancelled.';

/** The single call path every adapter uses: policy deny, argument decoding, port call, and result encoding. */
export async function invokeSessionTool(
  name: string,
  args: unknown,
  invocation: SessionToolInvocation,
): Promise<SessionToolResult> {
  const { port, toolPolicy, signal } = invocation;
  if (!port || !isSessionToolPolicyAllowed(toolPolicy)) return toolError(DENIED);
  const decoded = decodeSessionToolCall(name, args);
  if (!decoded.ok) return toolError(decoded.error);
  if (signal.aborted) return toolError(CANCELLED);

  try {
    const call = decoded.call;
    const value = call.tool === TOOL_CLAUDIAN_LIST_DESTINATIONS ? await port.list(call.args, signal)
      : call.tool === TOOL_CLAUDIAN_SEND_MESSAGE ? await port.send(call.args, signal)
        : await port.read(call.args, signal);
    return { isError: false, text: JSON.stringify(value) };
  } catch (error) {
    if (signal.aborted) return toolError(CANCELLED);
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

function toolError(text: string): SessionToolResult {
  return { isError: true, text };
}
