import type { Thread, ThreadReadResult } from './codexAppServerTypes';
import type { CodexRPCTransport } from './CodexRPCTransport';

/** `stopping` means a detached owner is still settling native work; the claimant may retry. */
export type CodexThreadRelinquishResult = 'transferred' | 'stopping' | 'owned';

export interface CodexThreadClient {
  relinquish(threadId: string, receiver: CodexThreadClient): CodexThreadRelinquishResult;
  adoptChild(thread: Pick<Thread, 'id' | 'status'>, parentId: string): void;
  closed(): void;
  notification(method: string, params: unknown): void;
  serverRequest(requestId: string | number, method: string, params: unknown): Promise<unknown>;
  shutdown(): Promise<void>;
}

const NOTIFICATIONS = [
  'item/agentMessage/delta', 'item/started', 'item/completed', 'item/plan/delta',
  'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
  'thread/tokenUsage/updated', 'turn/plan/updated', 'turn/completed', 'error',
  'thread/started', 'thread/status/changed', 'thread/closed', 'turn/started', 'serverRequest/resolved',
  'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'item/fileChange/patchUpdated',
  'rawResponseItem/completed', 'rawResponse/completed', 'event_msg',
];
const SERVER_REQUESTS = [
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput', 'item/tool/call',
  'mcpServer/elicitation/request',
];

/** Exclusive root-thread ownership; app-wide events never become another tab's output. */
export class CodexThreadRouter {
  private readonly clients = new Set<CodexThreadClient>();
  private readonly owners = new Map<string, CodexThreadClient>();

  private readonly discovering = new Map<string, Promise<CodexThreadClient | undefined>>();
  private readonly descendants = new Map<string, Thread>();
  private closed = false;

  constructor(private readonly transport: CodexRPCTransport) {
    for (const method of NOTIFICATIONS) {
      transport.onNotification(method, params => {
        const threadId = getThreadId(params);
        if (!threadId) return;
        const owner = this.owners.get(threadId);
        if (method === 'thread/closed') {
          this.discovering.delete(threadId);
          this.descendants.delete(threadId);
        }
        if (owner) owner.notification(method, params);
        else if (method === 'thread/status/changed' || this.discovering.has(threadId)) {
          void this.#discover(threadId).then(found => {
            if (!this.closed && found && this.owners.get(threadId) === found) found.notification(method, params);
          });
        }
      });
    }
    for (const method of SERVER_REQUESTS) {
      transport.onServerRequest(method, async (id, params) => {
        const threadId = getThreadId(params);
        const owner = threadId ? this.owners.get(threadId) ?? await this.#discover(threadId) : undefined;
        if (!owner) return Promise.reject(new Error('No owning Codex session for this server request.'));
        return owner.serverRequest(id, method, params);
      });
    }
  }

  register(client: CodexThreadClient): void { this.clients.add(client); }

  claim(threadId: string, client: CodexThreadClient): void {
    const existing = this.owners.get(threadId);
    const handoff = existing && existing !== client ? existing.relinquish(threadId, client) : 'transferred';
    if (handoff === 'stopping') {
      throw new Error('The previous Codex work for this conversation is still stopping. Retry when it finishes.');
    }
    if (handoff === 'owned') throw new Error('This Codex thread already belongs to another active session.');
    this.owners.set(threadId, client);
    for (const child of this.descendants.values()) {
      if (getParentId(child) === threadId && !this.owners.has(child.id)) client.adoptChild(child, threadId);
    }
  }

  release(client: CodexThreadClient, threadId?: string): void {
    if (!threadId) this.clients.delete(client);
    for (const [id, owner] of this.owners) {
      if (owner === client && (!threadId || id === threadId)) this.owners.delete(id);
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.clients].map(client => client.shutdown()));
  }

  close(): void {
    this.closed = true;
    this.discovering.clear();
    this.descendants.clear();
    for (const client of [...this.clients]) client.closed();
    this.clients.clear();
    this.owners.clear();
  }

  // Status is broadcast even after unsubscribe. Resolve only newly observed IDs;
  // native ancestry, rather than copied transcript records, establishes routing.
  #discover(threadId: string): Promise<CodexThreadClient | undefined> {
    const owner = this.owners.get(threadId);
    if (owner || this.closed) return Promise.resolve(owner);
    const pending = this.discovering.get(threadId);
    if (pending) return pending;
    const discovery = this.transport.request<ThreadReadResult>('thread/read', { threadId, includeTurns: false }).then(async ({ thread }) => {
      if (this.closed || this.discovering.get(threadId) !== discovery) return;
      const parentId = getParentId(thread);
      if (!parentId || parentId === threadId) return;
      this.descendants.set(threadId, thread);
      const parent = this.owners.get(parentId) ?? await this.#discover(parentId);
      if (!parent || this.closed || this.discovering.get(threadId) !== discovery) return;
      const current = this.owners.get(threadId);
      if (current) return current;
      parent.adoptChild(thread, parentId);
      return parent;
    }).catch(() => undefined).finally(() => {
      if (this.discovering.get(threadId) === discovery) this.discovering.delete(threadId);
    });
    this.discovering.set(threadId, discovery);
    return discovery;
  }
}

function getThreadId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return;
  const data = params as { threadId?: unknown; thread?: { id?: unknown } };
  const threadId = data.threadId ?? data.thread?.id;
  return typeof threadId === 'string' ? threadId : undefined;
}

function getParentId(thread: Thread): string | undefined {
  const source = thread.source;
  const subagent = typeof source === 'object' && source ? source.subAgent : undefined;
  return thread.parentThreadId ?? (typeof subagent === 'object' ? subagent.thread_spawn.parent_thread_id : undefined);
}
