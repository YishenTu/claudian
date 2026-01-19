/**
 * ServiceFactory - Creates the appropriate agent service based on configuration.
 *
 * This factory allows switching between Claude SDK and iFlow SDK
 * by changing the SDK_BACKEND configuration.
 */

import type ClaudianPlugin from '../../main';
import type { ImageAttachment, ChatMessage, StreamChunk } from '../types';
import type { McpServerManager } from '../mcp';
import { ClaudianService } from './ClaudianService';
import { SDK_BACKEND } from './config';
import { IFlowService, type QueryOptions, type ApprovalCallback } from './IFlowService';

/**
 * Common interface for agent services.
 * Both ClaudianService and IFlowService implement this interface.
 */
export interface IAgentService {
  // Query methods
  query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk>;

  // Lifecycle methods
  preWarm(resumeSessionId?: string, externalContextPaths?: string[]): Promise<void>;
  cancel(): void;
  cleanup(): void;
  closePersistentQuery(reason?: string): void;
  restartPersistentQuery(reason?: string): Promise<void>;

  // Session management
  getSessionId(): string | null;
  setSessionId(id: string | null): void;
  resetSession(): void;
  consumeSessionInvalidation(): boolean;

  // State
  isPersistentQueryActive(): boolean;

  // Configuration
  loadCCPermissions(): Promise<void>;
  loadMcpServers(): Promise<void>;
  reloadMcpServers(): Promise<void>;
  setApprovalCallback(callback: ApprovalCallback | null): void;
}

/**
 * Creates an agent service based on the configured SDK backend.
 *
 * @param plugin - The Claudian plugin instance
 * @param mcpManager - The MCP server manager
 * @returns An agent service instance (ClaudianService or IFlowService)
 */
export function createAgentService(
  plugin: ClaudianPlugin,
  mcpManager: McpServerManager
): IAgentService {
  if (SDK_BACKEND === 'iflow') {
    return new IFlowService(plugin, mcpManager);
  }

  return new ClaudianService(plugin, mcpManager) as IAgentService;
}

/**
 * Type alias for the agent service.
 * Use this type when you need to reference the service type.
 */
export type AgentServiceType = ClaudianService | IFlowService;
