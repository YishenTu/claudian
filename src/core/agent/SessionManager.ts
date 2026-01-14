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
    needsHistoryRebuild: false,
    sessionInvalidated: false,
  };

  getSessionId(): string | null {
    return this.state.sessionId;
  }

  setSessionId(id: string | null, defaultModel?: ClaudeModel): void {
    this.state.sessionId = id;
    this.state.sessionModel = id ? (defaultModel ?? null) : null;
    // Clear rebuild flag when switching sessions to prevent carrying over to different conversation
    this.state.needsHistoryRebuild = false;
    // Clear invalidation flag when explicitly setting session
    this.state.sessionInvalidated = false;
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

  /**
   * Captures a session ID from SDK response.
   * Detects mismatch if we had a different session ID before (context lost).
   */
  captureSession(sessionId: string): void {
    // Detect mismatch: we had a session, but SDK gave us a different one
    const hadSession = this.state.sessionId !== null;
    const isDifferent = this.state.sessionId !== sessionId;
    if (hadSession && isDifferent) {
      // SDK lost our session context - need to rebuild history on next message
      this.state.needsHistoryRebuild = true;
    }

    this.state.sessionId = sessionId;
    this.state.sessionModel = this.state.pendingSessionModel;
    this.state.pendingSessionModel = null;
    this.state.sessionInvalidated = false;
  }

  /** Check if history rebuild is needed due to session mismatch. */
  needsHistoryRebuild(): boolean {
    return this.state.needsHistoryRebuild;
  }

  /** Clear the history rebuild flag after injecting history. */
  clearHistoryRebuild(): void {
    this.state.needsHistoryRebuild = false;
  }

  invalidateSession(): void {
    this.state.sessionId = null;
    this.state.sessionModel = null;
    this.state.sessionInvalidated = true;
  }

  /** Consume the invalidation flag (returns true once). */
  consumeInvalidation(): boolean {
    const wasInvalidated = this.state.sessionInvalidated;
    this.state.sessionInvalidated = false;
    return wasInvalidated;
  }

  reset(): void {
    this.state = {
      sessionId: null,
      sessionModel: null,
      pendingSessionModel: null,
      wasInterrupted: false,
      needsHistoryRebuild: false,
      sessionInvalidated: false,
    };
  }
}
