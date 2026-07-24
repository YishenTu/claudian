import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import type { ChatMessage, SubagentInfo, ToolCallInfo } from '../../../core/types';
import { isClaudeSubagentToolName } from '../subagentToolNames';
import { buildAsyncSubagentInfo } from './sdkAsyncSubagent';
import { filterActiveBranch } from './sdkBranchFilter';
import type { SDKSessionLoadResult } from './sdkHistoryTypes';
import {
  collectAsyncSubagentResults,
  collectStructuredPatchResults,
  collectToolResults,
  extractXmlTag,
  hydrateFallbackAskUserAnswers,
  hydrateStructuredToolResults,
  isSystemInjectedMessage,
  mergeAssistantMessage,
  parseSDKMessageToChat,
} from './sdkMessageParsing';
import {
  deleteSDKSession,
  encodeVaultPathForSDK,
  getSDKProjectsPath,
  getSDKSessionAvailability,
  getSDKSessionPath,
  isValidSessionId,
  locateSDKSession,
  locateSDKSessions,
  readSDKSession,
  readSDKSessionFile,
  sdkSessionExists,
} from './sdkSessionPaths';
import {
  isValidAgentId,
  loadSubagentFinalResult,
  loadSubagentToolCalls,
} from './sdkSubagentSidecar';

export type {
  AsyncSubagentResult,
  ResolvedAsyncStatus,
  SDKNativeContentBlock,
  SDKNativeMessage,
  SDKSessionLoadResult,
  SDKSessionReadResult,
} from './sdkHistoryTypes';
export {
  collectAsyncSubagentResults,
  deleteSDKSession,
  encodeVaultPathForSDK,
  extractXmlTag,
  filterActiveBranch,
  getSDKProjectsPath,
  getSDKSessionAvailability,
  getSDKSessionPath,
  isValidSessionId,
  loadSubagentFinalResult,
  loadSubagentToolCalls,
  locateSDKSession,
  locateSDKSessions,
  parseSDKMessageToChat,
  readSDKSession,
  readSDKSessionFile,
  sdkSessionExists,
};
export {
  extractAgentIdFromToolUseResult,
  resolveToolUseResultStatus,
} from './sdkAsyncSubagent';

export function parseLegacyConversationSessionId(
  content: string,
  conversationId: string,
): string | null {
  const firstLine = content.split(/\r?\n/, 1)[0];
  if (!firstLine) {
    return null;
  }

  try {
    const record = JSON.parse(firstLine) as {
      type?: unknown;
      id?: unknown;
      sessionId?: unknown;
    };
    if (
      record.type !== 'meta'
      || record.id !== conversationId
      || typeof record.sessionId !== 'string'
      || !isValidSessionId(record.sessionId)
    ) {
      return null;
    }
    return record.sessionId;
  } catch {
    return null;
  }
}

export async function readLegacyConversationSessionId(
  vaultPath: string,
  conversationId: string,
): Promise<string | null> {
  if (!isValidSessionId(conversationId)) {
    return null;
  }

  try {
    const content = await fs.readFile(
      path.join(vaultPath, '.claude', 'sessions', `${conversationId}.jsonl`),
      'utf8',
    );
    return parseLegacyConversationSessionId(content, conversationId);
  } catch {
    return null;
  }
}

export async function loadSDKSessionMessages(
  vaultPath: string,
  sessionId: string,
  resumeAtMessageId?: string,
  sessionPath?: string,
  pathContext?: ProviderHistoryPathContext,
): Promise<SDKSessionLoadResult> {
  const result = sessionPath
    ? await readSDKSessionFile(sessionPath)
    : await (pathContext
      ? readSDKSession(vaultPath, sessionId, pathContext)
      : readSDKSession(vaultPath, sessionId));

  if (result.error) {
    return { messages: [], skippedLines: result.skippedLines, error: result.error };
  }

  const filteredEntries = filterActiveBranch(result.messages, resumeAtMessageId);

  const toolResults = collectToolResults(filteredEntries);
  const toolUseResults = collectStructuredPatchResults(filteredEntries);
  const asyncSubagentResults = collectAsyncSubagentResults(filteredEntries);

  const chatMessages: ChatMessage[] = [];
  let pendingAssistant: ChatMessage | null = null;

  // Merge consecutive assistant messages until an actual user message appears
  for (const sdkMsg of filteredEntries) {
    if (isSystemInjectedMessage(sdkMsg)) continue;

    // Skip synthetic assistant messages (e.g., "No response requested." after /compact)
    if (sdkMsg.type === 'assistant' && sdkMsg.message?.model === '<synthetic>') continue;

    const chatMsg = parseSDKMessageToChat(sdkMsg, toolResults);
    if (!chatMsg) continue;

    if (chatMsg.role === 'assistant') {
      // context_compacted must not merge with previous assistant (it's a standalone separator)
      const isCompactBoundary = chatMsg.contentBlocks?.some(b => b.type === 'context_compacted');
      if (isCompactBoundary) {
        if (pendingAssistant) {
          chatMessages.push(pendingAssistant);
        }
        chatMessages.push(chatMsg);
        pendingAssistant = null;
      } else if (pendingAssistant) {
        mergeAssistantMessage(pendingAssistant, chatMsg);
      } else {
        pendingAssistant = chatMsg;
      }
    } else {
      if (pendingAssistant) {
        chatMessages.push(pendingAssistant);
        pendingAssistant = null;
      }
      chatMessages.push(chatMsg);
    }
  }

  if (pendingAssistant) {
    chatMessages.push(pendingAssistant);
  }

  hydrateStructuredToolResults(chatMessages, toolUseResults);
  hydrateFallbackAskUserAnswers(chatMessages);

  // Build SubagentInfo for async Agent tool calls from toolUseResult + queue-operation data
  if (toolUseResults.size > 0 || asyncSubagentResults.size > 0) {
    const sidecarLoads: Array<{ subagent: SubagentInfo; promise: Promise<ToolCallInfo[]> }> = [];

    for (const msg of chatMessages) {
      if (msg.role !== 'assistant' || !msg.toolCalls) continue;
      for (const toolCall of msg.toolCalls) {
        if (!isClaudeSubagentToolName(toolCall.name)) continue;
        if (toolCall.subagent) continue;
        if (toolCall.input?.run_in_background !== true) continue;

        const toolUseResult = toolUseResults.get(toolCall.id);
        const subagent = buildAsyncSubagentInfo(
          toolCall,
          toolUseResult,
          asyncSubagentResults
        );
        if (subagent) {
          toolCall.subagent = subagent;
          if (subagent.result !== undefined) {
            toolCall.result = subagent.result;
          }
          toolCall.status = subagent.status;

          // Load tool calls from subagent sidecar JSONL in parallel
          if (subagent.agentId && isValidAgentId(subagent.agentId)) {
            const promise = pathContext
              ? loadSubagentToolCalls(
                vaultPath,
                sessionId,
                subagent.agentId,
                sessionPath,
                pathContext,
              )
              : loadSubagentToolCalls(vaultPath, sessionId, subagent.agentId, sessionPath);
            sidecarLoads.push({ subagent, promise });
          }
        }
      }
    }

    // Hydrate subagent tool calls from sidecar files
    if (sidecarLoads.length > 0) {
      const results = await Promise.all(sidecarLoads.map(s => s.promise));
      for (let i = 0; i < sidecarLoads.length; i++) {
        const toolCalls = results[i];
        if (toolCalls.length > 0) {
          sidecarLoads[i].subagent.toolCalls = toolCalls;
        }
      }
    }
  }

  chatMessages.sort((a, b) => a.timestamp - b.timestamp);

  return { messages: chatMessages, skippedLines: result.skippedLines };
}
