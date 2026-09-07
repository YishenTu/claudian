import { type CollabProjectId, isCollabMemberId, isCollabOpaqueId } from '@claudian-collab/protocol';

import { type AuthorityEventRecord,AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import type { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import {
  type LanCollabEvent as CollabEvent,
  type LanCollabEventKind as CollabEventKind,
} from '@/app/collab/lan/LanCollabEvent';
import type { CollabRetirementResult } from '@/core/collab';

const OPEN_READY_STATE = 1;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_REPLAY_EVENTS = 500;

export interface ProjectEventSocket {
  readonly readyState: number;
  close(code: number, reason: string): void;
  on(eventName: 'close' | 'error' | 'pong', listener: () => void): this;
  ping(): void;
  send(data: string): void;
}

export interface ProjectEventReadResult {
  readonly active: boolean;
  readonly events: readonly AuthorityEventRecord[];
  readonly latestSequence: number;
}

export interface ProjectEventSourceSubscription {
  dispose(): void;
}

export interface ProjectEventSource {
  read(memberId: string, afterSequence: number): Promise<ProjectEventReadResult>;
  subscribe(listener: () => void): ProjectEventSourceSubscription;
}

export interface ProjectEventTimer {
  readonly clearInterval?: (handle: number) => void;
  readonly setInterval?: (callback: () => void, milliseconds: number) => number;
}

interface EventConnection {
  cursor: number;
  missedPongs: number;
  refreshing: boolean;
  refreshQueued: boolean;
  readonly memberId: string;
  readonly socket: ProjectEventSocket;
}

function eventPayload(record: AuthorityEventRecord): Readonly<Record<string, unknown>> {
  const requestId = record.payload.requestId;
  const memberId = record.payload.memberId;
  if (
    (record.kind.startsWith('request.') || record.kind === 'comment.created')
    && typeof requestId === 'string'
    && isCollabOpaqueId(requestId)
  ) {
    return { requestId };
  }
  if (
    record.kind.startsWith('membership.')
    && typeof memberId === 'string'
    && isCollabMemberId(memberId)
  ) {
    return { memberId };
  }
  return {};
}

function eventKind(kind: string): CollabEventKind | null {
  if (kind.startsWith('request.')) return 'request-updated';
  if (kind === 'comment.created') return 'comment-added';
  if (kind.startsWith('membership.')) return 'membership-updated';
  if (kind.startsWith('invitation.')) return 'invitation-updated';
  if (kind.startsWith('host.')) return 'host-state-updated';
  if (kind.startsWith('main.') || kind.startsWith('accept.')) return 'main-updated';
  if (kind.startsWith('project.')) return 'project-updated';
  return null;
}

export class SqlJsProjectEventSource implements ProjectEventSource {
  private readonly events = new AuthorityEventRepository();

  constructor(
    private readonly database: SqlJsProjectDatabase,
    private readonly projectId: CollabProjectId,
  ) {}

  read(memberId: string, afterSequence: number): Promise<ProjectEventReadResult> {
    return this.database.read(connection => {
      const project = connection.get(
        'SELECT project_id, state FROM project WHERE singleton = 1',
      );
      const member = connection.get(
        'SELECT status FROM members WHERE member_id = ?',
        [memberId],
      );
      const sequence = connection.get(
        'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events',
      )?.sequence;
      if (
        typeof sequence !== 'number'
        || !Number.isSafeInteger(sequence)
        || sequence < 0
      ) {
        return { active: false, events: [], latestSequence: 0 };
      }
      const active = project?.project_id === this.projectId
        && project.state === 'active'
        && member?.status === 'active';
      return {
        active,
        events: active
          ? this.events.listAfter(connection, afterSequence, MAX_REPLAY_EVENTS)
          : [],
        latestSequence: sequence,
      };
    });
  }

  subscribe(listener: () => void): ProjectEventSourceSubscription {
    return this.database.subscribe(() => listener());
  }
}

export class ProjectEventHub {
  private readonly clearInterval: (handle: number) => void;
  private readonly connections = new Set<EventConnection>();
  private heartbeatHandle: number | null = null;
  private closed = false;
  private refreshScheduled = false;
  private readonly setInterval: (callback: () => void, milliseconds: number) => number;
  private readonly subscription: ProjectEventSourceSubscription;

  constructor(
    private readonly projectId: CollabProjectId,
    private readonly source: ProjectEventSource,
    timer: ProjectEventTimer = {},
  ) {
    this.clearInterval = timer.clearInterval ?? (handle => window.clearInterval(handle));
    this.setInterval = timer.setInterval
      ?? ((callback, milliseconds) => window.setInterval(callback, milliseconds));
    this.subscription = source.subscribe(() => this.scheduleRefresh());
  }

  hasAuthenticatedPresence(projectId: string, memberId: string): boolean {
    if (projectId !== this.projectId || !isCollabMemberId(memberId)) return false;
    return [...this.connections].some(connection => (
      connection.memberId === memberId
      && connection.socket.readyState === OPEN_READY_STATE
    ));
  }

  async publishRetirement(result: CollabRetirementResult): Promise<void> {
    if (result.projectId !== this.projectId) return;
    const connections = [...this.connections];
    for (const connection of connections) {
      this.send(connection, {
        kind: 'project-retired',
        occurredAt: result.retiredAt,
        payload: { retiredAt: result.retiredAt },
        projectId: this.projectId,
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        sequence: connection.cursor + 1,
      });
    }
    await Promise.resolve();
  }

  async connect(
    socket: ProjectEventSocket,
    memberId: string,
    lastSequence: number,
  ): Promise<void> {
    if (
      this.closed
      || !isCollabMemberId(memberId)
      || !Number.isSafeInteger(lastSequence)
      || lastSequence < 0
    ) {
      socket.close(1008, 'Project unavailable');
      return;
    }
    const connection: EventConnection = {
      cursor: lastSequence,
      memberId,
      missedPongs: 0,
      refreshing: false,
      refreshQueued: false,
      socket,
    };
    this.connections.add(connection);
    socket.on('pong', () => {
      connection.missedPongs = 0;
    });
    socket.on('close', () => this.removeConnection(connection));
    socket.on('error', () => this.removeConnection(connection));
    this.ensureHeartbeat();
    await this.refresh(connection);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscription.dispose();
    this.stopHeartbeat();
    const connections = [...this.connections];
    this.connections.clear();
    for (const connection of connections) {
      if (connection.socket.readyState === OPEN_READY_STATE) {
        connection.socket.close(1001, 'Host stopped');
      }
    }
  }

  private scheduleRefresh(): void {
    if (this.closed || this.refreshScheduled) return;
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      if (this.closed) return;
      for (const connection of this.connections) void this.refresh(connection);
    });
  }

  private async refresh(connection: EventConnection): Promise<void> {
    if (this.closed || !this.connections.has(connection)) return;
    if (connection.refreshing) {
      connection.refreshQueued = true;
      return;
    }
    connection.refreshing = true;
    try {
      do {
        connection.refreshQueued = false;
        const result = await this.source.read(connection.memberId, connection.cursor);
        if (this.closed || !this.connections.has(connection)) return;
        if (!result.active) {
          connection.socket.close(1008, 'Access removed');
          return;
        }
        this.publish(connection, result);
      } while (connection.refreshQueued);
    } catch {
      if (connection.socket.readyState === OPEN_READY_STATE) {
        connection.socket.close(1011, 'Event refresh failed');
      }
    } finally {
      connection.refreshing = false;
    }
  }

  private publish(connection: EventConnection, result: ProjectEventReadResult): void {
    if (connection.socket.readyState !== OPEN_READY_STATE) return;
    const lastEvent = result.events.at(-1);
    const invalidReplay = connection.cursor > result.latestSequence
      || (result.events.length > 0 && result.events[0].sequence !== connection.cursor + 1)
      || (lastEvent !== undefined && lastEvent.sequence !== result.latestSequence)
      || result.events.some(record => eventKind(record.kind) === null);
    if (invalidReplay) {
      this.send(connection, {
        kind: 'snapshot-required',
        occurredAt: lastEvent?.createdAt ?? new Date().toISOString(),
        payload: {},
        projectId: this.projectId,
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        sequence: result.latestSequence,
      });
      connection.cursor = result.latestSequence;
      return;
    }
    for (const record of result.events) {
      const kind = eventKind(record.kind);
      if (!kind) return;
      this.send(connection, {
        kind,
        occurredAt: record.createdAt,
        payload: eventPayload(record),
        projectId: this.projectId,
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        sequence: record.sequence,
      });
      connection.cursor = record.sequence;
    }
  }

  private send(connection: EventConnection, event: CollabEvent): void {
    try {
      connection.socket.send(JSON.stringify(event));
    } catch {
      connection.socket.close(1011, 'Event send failed');
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatHandle !== null || this.connections.size === 0) return;
    this.heartbeatHandle = this.setInterval(() => {
      for (const connection of [...this.connections]) {
        if (connection.socket.readyState !== OPEN_READY_STATE) {
          this.removeConnection(connection);
          continue;
        }
        if (connection.missedPongs >= 2) {
          connection.socket.close(1001, 'Heartbeat timeout');
          continue;
        }
        connection.missedPongs += 1;
        connection.socket.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle === null) return;
    this.clearInterval(this.heartbeatHandle);
    this.heartbeatHandle = null;
  }

  private removeConnection(connection: EventConnection): void {
    this.connections.delete(connection);
    if (this.connections.size === 0) this.stopHeartbeat();
  }
}
