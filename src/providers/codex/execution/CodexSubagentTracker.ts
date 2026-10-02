import { extractWebSearchResults } from '../../../core/tools/toolResultContent';
import type { StreamChunk, SubagentInfo } from '../../../core/types';
import { applyCodexSubagentActivity } from '../normalization/codexSubagentActivity';
import type { SubAgentActivityItem, Thread, Turn } from '../runtime/codexAppServerTypes';
import { CodexNotificationRouter } from '../runtime/CodexNotificationRouter';

interface TrackedAgent {
  info: SubagentInfo;
  parentTurnId: string;
  agentPath: string;
  nativeTurnId?: string;
  pendingInteraction?: { id: string; parentTurnId: string };
  revision: number;
  readGeneration: number;
  seen: Set<string>;
  router?: CodexNotificationRouter;
}

/** Session-owned child state. Native notifications are authoritative; reads only hydrate it. */
export class CodexSubagentTracker {
  private readonly agents = new Map<string, TrackedAgent>();

  constructor(
    private readonly publish: (info: SubagentInfo) => void,
    private readonly readThread: (id: string) => Promise<Thread>,
    private readonly workingDirectory?: () => string,
  ) {}

  hasBackgroundWork(): boolean {
    return [...this.agents.values()].some(agent => agent.info.status === 'running');
  }

  clear(): void { this.agents.clear(); }

  seed(thread: Thread): void {
    for (const turn of thread.turns) {
      for (const item of turn.items) {
        if (item.type === 'subAgentActivity') this.activity(item, turn.id, false);
      }
    }
  }

  activity(item: SubAgentActivityItem, parentTurnId: string, hydrate = true): void {
    let agent = this.agents.get(item.agentThreadId);
    if (agent?.seen.has(item.id)) return;
    if (hydrate && agent && item.kind === 'completed' && agent.parentTurnId !== parentTurnId
      && agent.pendingInteraction?.parentTurnId !== parentTurnId) return;
    if (!agent) {
      agent = {
        info: {
          id: item.id, agentId: item.agentThreadId, lifecycleSource: 'session',
          description: item.agentPath, status: 'running', mode: 'sync',
          isExpanded: false, toolCalls: [],
        },
        parentTurnId, agentPath: item.agentPath, revision: 0, readGeneration: 0, seen: new Set(),
      };
      this.agents.set(item.agentThreadId, agent);
    }
    agent.seen.add(item.id);
    if (item.kind === 'interacted') {
      agent.pendingInteraction = { id: item.id, parentTurnId };
      // An idle message starts no work. Seeded state cannot replace hydrated raw-only tools.
      if (agent.info.status !== 'running') return;
    }
    else if (item.kind === 'started') agent.parentTurnId = parentTurnId;
    else if (agent.pendingInteraction?.parentTurnId === parentTurnId && agent.parentTurnId !== parentTurnId) {
      this.beginInvocation(agent);
    }
    agent.revision += 1;
    agent.info = applyCodexSubagentActivity(item, agent.info, Date.now());
    if (hydrate) {
      this.publish({ ...agent.info });
      void this.hydrate(item.agentThreadId, agent);
    }
  }

  turnStarted(threadId: string, turnId: string): boolean {
    const agent = this.agents.get(threadId);
    if (!agent) return false;
    if (agent.seen.has(`turn:${turnId}`)) return true;
    agent.seen.add(`turn:${turnId}`);
    this.beginInvocation(agent);
    agent.nativeTurnId = turnId;
    agent.revision += 1;
    agent.router = undefined;
    agent.info = { ...agent.info, status: 'running', toolCalls: [], result: undefined, startedAt: Date.now(), completedAt: undefined };
    this.publish({ ...agent.info });
    void this.hydrate(threadId, agent);
    return true;
  }

  private beginInvocation(agent: TrackedAgent): void {
    const pending = agent.pendingInteraction;
    if (!pending) return;
    agent.parentTurnId = pending.parentTurnId;
    agent.pendingInteraction = undefined;
    agent.nativeTurnId = undefined;
    agent.router = undefined;
    agent.info = {
      id: pending.id, agentId: agent.info.agentId, lifecycleSource: 'session',
      description: agent.info.description, mode: 'sync', isExpanded: false,
      status: 'running', toolCalls: [], startedAt: Date.now(),
    };
  }

  turnCompleted(threadId: string, turn: Turn): boolean {
    const agent = this.agents.get(threadId);
    if (!agent) return false;
    if (agent.nativeTurnId && agent.nativeTurnId !== turn.id) return true;
    agent.nativeTurnId = turn.id;
    agent.revision += 1;
    this.replayTurn(agent, turn);
    agent.info = { ...agent.info, ...getCodexChildTurnOutcome(turn) };
    this.publish({ ...agent.info });
    return true;
  }

  handleNotification(threadId: string, turnId: string, method: string, params: unknown): boolean {
    const agent = this.agents.get(threadId);
    if (!agent) return false;
    if (agent.nativeTurnId && agent.nativeTurnId !== turnId) return true;
    agent.nativeTurnId = turnId;
    this.routerFor(agent).handleNotification(method, params);
    return true;
  }

  private routerFor(agent: TrackedAgent): CodexNotificationRouter {
    return agent.router ??= new CodexNotificationRouter(chunk => this.applyToolChunk(agent, chunk), this.workingDirectory?.(), true);
  }

  private applyToolChunk(agent: TrackedAgent, chunk: StreamChunk): void {
    if (chunk.type !== 'tool_use' && chunk.type !== 'tool_result' && chunk.type !== 'tool_output') return;
    const tools = [...agent.info.toolCalls];
    const index = tools.findIndex(tool => tool.id === chunk.id);
    if (chunk.type === 'tool_use') {
      const previous = tools[index];
      const tool = { ...previous, id: chunk.id, name: chunk.name, input: chunk.input,
        status: previous?.status ?? 'running' as const, providerPayload: chunk.providerPayload ?? previous?.providerPayload };
      if (index < 0) tools.push(tool);
      else tools[index] = tool;
    } else {
      if (index < 0) return;
      tools[index] = { ...tools[index], result: chunk.type === 'tool_output' ? (tools[index].result ?? '') + chunk.content : chunk.content,
        ...(chunk.type === 'tool_result' ? { status: chunk.isError ? 'error' as const : 'completed' as const,
          webSearchResults: extractWebSearchResults(chunk.toolUseResult) ?? tools[index].webSearchResults,
          providerPayload: { ...tools[index].providerPayload, ...chunk.providerPayload } } : {}) };
    }
    agent.revision += 1;
    agent.info = { ...agent.info, toolCalls: tools };
    this.publish({ ...agent.info });
  }

  private replayTurn(agent: TrackedAgent, turn: Turn): void {
    const router = this.routerFor(agent);
    for (const item of turn.items) {
      router.handleNotification('status' in item && item.status === 'inProgress' ? 'item/started' : 'item/completed', {
        threadId: agent.info.agentId, turnId: turn.id, item,
      });
    }
    if (turn.status !== 'inProgress') router.handleNotification('turn/completed', { threadId: agent.info.agentId, turn });
  }

  private async hydrate(threadId: string, agent: TrackedAgent): Promise<void> {
    const revision = agent.revision;
    const readGeneration = ++agent.readGeneration;
    try {
      const thread = await this.readThread(threadId);
      if (this.agents.get(threadId) !== agent || agent.readGeneration !== readGeneration || thread.id !== threadId) return;
      const details = [thread.agentRole, thread.model, thread.reasoningEffort].filter(Boolean);
      const label = thread.agentNickname ?? agent.agentPath;
      const turn = thread.turns.at(-1);
      const currentLifecycle = agent.revision === revision;
      if (currentLifecycle && turn?.status === 'inProgress') {
        agent.nativeTurnId = turn.id;
      }
      const canHydrateTurn = currentLifecycle && turn && (!agent.nativeTurnId || agent.nativeTurnId === turn.id)
        && (agent.info.status !== 'running' || turn.status === 'inProgress');
      if (canHydrateTurn) this.replayTurn(agent, turn);
      agent.info = {
        ...agent.info,
        description: details.length ? `${label} (${details.join(', ')})` : label,
        ...(canHydrateTurn ? getCodexChildTurnOutcome(turn) : {}),
      };
      this.publish({ ...agent.info });
    } catch {
      // A child can finish before it becomes readable. Preserve the native lifecycle state.
    }
  }
}

export function getCodexChildTurnOutcome(turn: Turn): Pick<SubagentInfo, 'status' | 'result'> {
  const result = turn.items.filter(item => item.type === 'agentMessage'
    && item.phase === 'final_answer').map(item => item.type === 'agentMessage' ? item.text : '').join('\n\n');
  return {
    status: turn.status === 'inProgress' ? 'running' : turn.status === 'completed' ? 'completed' : 'error',
    result: result || turn.error?.message || undefined,
  };
}
