/**
 * iFlow SDK Integration Module
 *
 * Exports all iFlow-related types, client, and utilities.
 */

export { IFlowClient } from './IFlowClient';
export {
  isSessionInitEvent,
  isStreamChunk,
  transformIFlowMessage,
  type SessionInitEvent,
  type TransformEvent,
  type TransformOptions,
} from './transformIFlowMessage';
export type {
  AgentInfo,
  AssistantMessage,
  ErrorCallback,
  ErrorMessage,
  IFlowMessage,
  IFlowOptions,
  IFlowQueryOptions,
  IIFlowClient,
  MessageCallback,
  PlanEntry,
  PlanMessage,
  TaskFinishMessage,
  TextChunk,
  ThinkingMessage,
  ToolApprovalCallback,
  ToolCallMessage,
  ToolCallStatus,
  UserMessage,
} from './types';
