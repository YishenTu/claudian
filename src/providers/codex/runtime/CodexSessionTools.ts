import type { ProviderSessionToolPort } from '@/core/execution';
import { invokeSessionTool, type SessionToolInvocation } from '@/core/session-tools/invokeSessionTool';
import { SESSION_TOOL_SPECS } from '@/core/session-tools/sessionToolSpecs';
import { isSessionTool } from '@/core/tools/toolNames';

import type { DynamicToolCallParams, DynamicToolCallResponse } from './codexAppServerTypes';
import type { CodexDynamicToolRegistration } from './CodexDynamicToolRegistry';

export const CODEX_SESSION_TOOL_NAMESPACE = 'claudian_sessions';
/** Bumped when the specs change: a thread keeps the specs it started with (2 adds read, 3 adds send modes). */
export const CODEX_SESSION_TOOL_VERSION = 3;

export function isCodexSessionTool(namespace: string | null | undefined, name: string): boolean {
  return namespace === CODEX_SESSION_TOOL_NAMESPACE && isSessionTool(name);
}

export async function invokeCodexSessionTool(
  params: DynamicToolCallParams,
  invocation: SessionToolInvocation,
): Promise<DynamicToolCallResponse> {
  const result = await invokeSessionTool(params.tool, params.arguments, invocation);
  return { success: !result.isError, contentItems: [{ type: 'inputText', text: result.text }] };
}

export function createCodexSessionTools(port: ProviderSessionToolPort): CodexDynamicToolRegistration[] {
  return SESSION_TOOL_SPECS.map(spec => ({
    includeInThreadStart: true,
    namespace: { name: CODEX_SESSION_TOOL_NAMESPACE, description: 'Message other Claudian sessions.' },
    tool: { type: 'function', ...spec },
    handler: (params, context) => invokeCodexSessionTool(params, { ...context, port }),
  }));
}
