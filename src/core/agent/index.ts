/**
 * Agent module barrel export.
 *
 * Provides the Agent SDK wrapper and supporting infrastructure.
 * Supports both Claude Agent SDK (ClaudianService) and iFlow SDK (IFlowService).
 */

// Claude Agent SDK (original)
export { type ApprovalCallback, ClaudianService, type QueryOptions } from './ClaudianService';

// iFlow SDK (new)
export {
  type ApprovalCallback as IFlowApprovalCallback,
  IFlowService,
  type QueryOptions as IFlowQueryOptions,
} from './IFlowService';

// Service factory (recommended way to create services)
export {
  createAgentService,
  type AgentServiceType,
  type IAgentService,
} from './ServiceFactory';

// Query adapter (for services that need direct SDK access)
export {
  query,
  isUsingIFlow,
  type QueryAdapterOptions,
  type QueryMessage,
  type QueryResponse,
} from './queryAdapter';

// SDK configuration
export { isClaudeBackend, isIFlowBackend, SDK_BACKEND, type SDKBackend } from './config';

// Shared components
export { MessageChannel } from './MessageChannel';
export {
  type ColdStartQueryContext,
  type PersistentQueryContext,
  QueryOptionsBuilder,
  type QueryOptionsContext,
} from './QueryOptionsBuilder';
export { SessionManager } from './SessionManager';
export type {
  ClosePersistentQueryOptions,
  PersistentQueryConfig,
  ResponseHandler,
  SDKContentBlock,
  SessionState,
} from './types';
