import type { ClaudeModel } from '../types/models';
import type { SessionState } from './types';

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

  captureSession(sessionId: string): void {
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

  needsHistoryRebuild(): boolean {
    return this.state.needsHistoryRebuild;
  }

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
