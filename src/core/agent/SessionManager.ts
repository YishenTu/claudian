/**
 * Session Manager
 *
 * Manages SDK session state including session ID, model tracking,
 * and interruption state.
 */

import type { ClaudeModel } from '../types';
import type { SessionState } from './types';

/**
 * Manages session state for the Claude Agent SDK.
 *
 * Tracks:
 * - Session ID: Unique identifier for the conversation
 * - Session model: The model used for this session
 * - Pending model: Model to use when session is captured
 * - Interrupted state: Whether the session was interrupted
 *
 * Typical flow:
 * 1. setPendingModel() - before starting a query
 * 2. captureSession() - when session_id received from SDK
 * 3. invalidateSession() - when session expires or errors occur
 */
export class SessionManager {
  private state: SessionState = {
    sessionId: null,
    sessionModel: null,
    pendingSessionModel: null,
    wasInterrupted: false,
  };

  getSessionId(): string | null {
    return this.state.sessionId;
  }

  setSessionId(id: string | null, defaultModel?: ClaudeModel): void {
    this.state.sessionId = id;
    this.state.sessionModel = id ? (defaultModel ?? null) : null;
  }

  wasInterrupted(): boolean {
    return this.state.wasInterrupted;
  }

  markInterrupted(): void {
    this.state.wasInterrupted = true;
  }

  clearInterrupted(): void {
    this.state.wasInterrupted = false;
  }

  setPendingModel(model: ClaudeModel): void {
    this.state.pendingSessionModel = model;
  }

  clearPendingModel(): void {
    this.state.pendingSessionModel = null;
  }

  captureSession(sessionId: string): void {
    this.state.sessionId = sessionId;
    this.state.sessionModel = this.state.pendingSessionModel;
    this.state.pendingSessionModel = null;
  }

  invalidateSession(): void {
    this.state.sessionId = null;
    this.state.sessionModel = null;
  }

  reset(): void {
    this.state = {
      sessionId: null,
      sessionModel: null,
      pendingSessionModel: null,
      wasInterrupted: false,
    };
  }
}
