import * as fs from 'fs';
import * as path from 'path';

import { ClaudianService } from '../../core/agent';
import {
  TOOL_ASK_USER_QUESTION,
  TOOL_EXIT_PLAN_MODE,
} from '../../core/tools/toolNames';
import type {
  Conversation,
  SkillRun,
  SlashCommand,
  StreamChunk,
} from '../../core/types';
import type ClaudianPlugin from '../../main';
import { getVaultPath, isPathWithinVault, normalizePathForFilesystem } from '../../utils/path';

type SkillRunListener = () => void;

interface ActiveRunContext {
  service: ClaudianService;
  isStopping: boolean;
  pendingTextLog: string;
}

const MAX_RUN_LOG_CHARS = 200_000;

function generateSkillRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1) + '…';
}

function buildConversationTitle(skillName: string, args: string): string {
  const normalizedArgs = args.trim().replace(/\s+/g, ' ');
  if (!normalizedArgs) return `/${skillName}`;
  return truncateText(`/${skillName} ${normalizedArgs}`, 80);
}

function extractLastNonEmptyLine(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}

function extractSummaryFromText(text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const firstParagraph = normalized.split(/\n\s*\n/).find(Boolean) ?? normalized;
  return truncateText(firstParagraph.replace(/\s+/g, ' '), 180);
}

function formatToolProgress(chunk: Extract<StreamChunk, { type: 'tool_use' }>): string {
  const input = chunk.input;
  const summary =
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.command === 'string' && input.command) ||
    (typeof input.url === 'string' && input.url) ||
    (typeof input.query === 'string' && input.query) ||
    (typeof input.path === 'string' && input.path) ||
    (typeof input.skill === 'string' && input.skill) ||
    '';

  if (!summary) {
    return `Using ${chunk.name}`;
  }

  return truncateText(`Using ${chunk.name}: ${summary}`, 180);
}

function formatLogTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export class SkillRunManager {
  private plugin: ClaudianPlugin;
  private runs: SkillRun[] = [];
  private skillUsageCounts: Record<string, number> = {};
  private listeners = new Set<SkillRunListener>();
  private activeRuns = new Map<string, ActiveRunContext>();
  private pendingPersist: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.runs = await this.plugin.storage.getSkillRuns();
    this.skillUsageCounts = await this.plugin.storage.getSkillRunUsageCounts();
    const now = Date.now();
    let changed = false;

    for (const run of this.runs) {
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'cancelled';
        run.updatedAt = now;
        run.completedAt ??= now;
        run.error = 'Claudian restarted before this background run finished.';
        changed = true;
      }
    }

    const derivedUsageCounts = this.buildUsageCountsFromRuns(this.runs);
    for (const [skillName, count] of Object.entries(derivedUsageCounts)) {
      if (this.skillUsageCounts[skillName] === undefined) {
        this.skillUsageCounts[skillName] = count;
        changed = true;
      }
    }

    this.runs.sort((a, b) => b.updatedAt - a.updatedAt);

    if (changed) {
      await this.persistStateImmediate();
    }

    this.initialized = true;
    this.emitChange();
  }

  subscribe(listener: SkillRunListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getRuns(): SkillRun[] {
    return [...this.runs].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getAvailableSkills(): Promise<SlashCommand[]> {
    const skills = await this.plugin.storage.skills.loadAll();
    return skills
      .filter(skill => skill.userInvocable !== false)
      .sort((a, b) => {
        const usageDiff = (this.skillUsageCounts[b.name] ?? 0) - (this.skillUsageCounts[a.name] ?? 0);
        return usageDiff !== 0 ? usageDiff : a.name.localeCompare(b.name);
      });
  }

  async createAndStartRun(skillName: string, args: string, workingDirectoryInput?: string): Promise<SkillRun> {
    const resolvedWorkingDirectory = this.resolveWorkingDirectory(workingDirectoryInput);
    const conversation = await this.plugin.createConversation();
    await this.plugin.renameConversation(conversation.id, buildConversationTitle(skillName, args));

    const now = Date.now();
    const run: SkillRun = {
      id: generateSkillRunId(),
      conversationId: conversation.id,
      skillName,
      args,
      workingDirectory: resolvedWorkingDirectory,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };

    this.incrementSkillUsage(skillName);
    this.runs.unshift(run);
    this.schedulePersist();
    this.emitChange();

    void this.startRun(run.id);
    return run;
  }

  async createAndStartRuns(
    skillName: string,
    argsList: string[],
    workingDirectoryInput?: string
  ): Promise<SkillRun[]> {
    const created: SkillRun[] = [];
    for (const args of argsList) {
      created.push(await this.createAndStartRun(skillName, args, workingDirectoryInput));
    }
    return created;
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.findRun(runId);
    if (!run) return;

    const active = this.activeRuns.get(runId);
    if (active) {
      active.isStopping = true;
      active.service.cancel();
      active.service.cleanup();
      this.activeRuns.delete(runId);
    }

    const now = Date.now();
    run.status = 'cancelled';
    run.updatedAt = now;
    run.completedAt = now;
    run.error = 'Cancelled by user.';
    this.schedulePersist();
    this.emitChange();
  }

  async removeByConversationId(conversationId: string): Promise<void> {
    const toRemove = this.runs.filter(run => run.conversationId === conversationId);
    if (toRemove.length === 0) return;

    for (const run of toRemove) {
      await this.cancelRun(run.id);
    }

    this.runs = this.runs.filter(run => run.conversationId !== conversationId);
    this.schedulePersist();
    this.emitChange();
  }

  async cleanup(): Promise<void> {
    const activeEntries = [...this.activeRuns.entries()];
    for (const [, active] of activeEntries) {
      active.isStopping = true;
      active.service.cancel();
      active.service.cleanup();
    }
    this.activeRuns.clear();

    const now = Date.now();
    for (const run of this.runs) {
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'cancelled';
        run.updatedAt = now;
        run.completedAt = now;
        run.error = 'Claudian shut down before this background run finished.';
      }
    }

    await this.persistStateImmediate();
    this.emitChange();
  }

  private async startRun(runId: string): Promise<void> {
    const run = this.findRun(runId);
    if (!run || this.activeRuns.has(runId)) {
      return;
    }

    const service = new ClaudianService(this.plugin, this.plugin.mcpManager, run.workingDirectory);
    const active: ActiveRunContext = { service, isStopping: false, pendingTextLog: '' };
    this.activeRuns.set(runId, active);

    const now = Date.now();
    run.status = 'running';
    run.startedAt = run.startedAt ?? now;
    run.updatedAt = now;
    run.error = undefined;
    run.attentionReason = undefined;
    this.appendLog(run, `Run queued for /${run.skillName}`);
    if (run.workingDirectory) {
      this.appendLog(run, `Working directory: ${run.workingDirectory}`);
    }
    this.schedulePersist();
    this.emitChange();

    const prompt = `/${run.skillName}${run.args.trim() ? ` ${run.args.trim()}` : ''}`;
    const externalContextPaths = this.plugin.settings.persistentExternalContextPaths || [];
    let combinedText = '';
    let lastSessionId: string | null = null;
    let finalStatus: SkillRun['status'] = 'completed';
    let finalError: string | undefined;

    service.setApprovalCallback(async (toolName) => {
      this.flushPendingTextLog(run, active);
      const reason = `Background run paused: ${toolName} requires confirmation.`;
      this.appendLog(run, reason);
      await this.markNeedsAttention(runId, reason);
      return 'cancel';
    });

    service.setAskUserQuestionCallback(async () => {
      this.flushPendingTextLog(run, active);
      const reason = `Background run paused: ${TOOL_ASK_USER_QUESTION} requires input.`;
      this.appendLog(run, reason);
      await this.markNeedsAttention(runId, reason);
      return null;
    });

    service.setExitPlanModeCallback(async () => {
      this.flushPendingTextLog(run, active);
      const reason = `Background run paused: ${TOOL_EXIT_PLAN_MODE} requires review.`;
      this.appendLog(run, reason);
      await this.markNeedsAttention(runId, reason);
      return null;
    });

    try {
      for await (const chunk of service.query(prompt, undefined, [], { externalContextPaths })) {
        const currentSessionId = service.getSessionId();
        if (currentSessionId && currentSessionId !== lastSessionId) {
          lastSessionId = currentSessionId;
          run.sessionId = currentSessionId;
          this.appendLog(run, `Session captured: ${currentSessionId}`);
          await this.syncConversationSession(run.conversationId, currentSessionId);
        }

        if (active.isStopping) {
          finalStatus = 'cancelled';
          finalError = 'Cancelled by user.';
          this.appendLog(run, finalError);
          break;
        }

        this.applyChunk(run, chunk, combinedText, active);
        if (chunk.type === 'text') {
          combinedText += chunk.content;
          run.summary = extractSummaryFromText(combinedText) ?? run.summary;
          run.lastLogLine = extractLastNonEmptyLine(chunk.content) ?? run.lastLogLine;
        } else if (chunk.type === 'error') {
          const currentStatus = run.status as SkillRun['status'];
          finalStatus = currentStatus === 'needs_attention' ? 'needs_attention' : 'failed';
          finalError = chunk.content;
          run.error = chunk.content;
        } else if (chunk.type === 'blocked') {
          run.lastLogLine = chunk.content;
        }
      }
    } catch (error) {
      this.flushPendingTextLog(run, active);
      const currentStatus = run.status as SkillRun['status'];
      finalStatus = currentStatus === 'needs_attention' ? 'needs_attention' : 'failed';
      finalError = error instanceof Error ? error.message : String(error);
      run.error = finalError;
      this.appendLog(run, `Run failed: ${finalError}`);
    } finally {
      this.flushPendingTextLog(run, active);
      service.cleanup();
      this.activeRuns.delete(runId);

      const finishedAt = Date.now();
      run.updatedAt = finishedAt;
      run.completedAt = finishedAt;

      const currentStatus = run.status as SkillRun['status'];
      if (currentStatus === 'needs_attention') {
        finalStatus = 'needs_attention';
        finalError = run.attentionReason ?? finalError;
      } else if (currentStatus === 'cancelled') {
        finalStatus = 'cancelled';
        finalError = run.error ?? finalError;
      }

      run.status = finalStatus;
      run.error = finalError;

      if (finalStatus === 'completed') {
        this.appendLog(run, 'Run completed.');
      } else if (finalStatus === 'cancelled') {
        this.appendLog(run, finalError || 'Run cancelled.');
      } else if (finalStatus === 'failed') {
        this.appendLog(run, finalError || 'Run failed.');
      }

      if (!run.summary && run.lastLogLine) {
        run.summary = truncateText(run.lastLogLine, 180);
      }

      await this.syncConversationCompletion(run, service.getSessionId());
      await this.persistStateImmediate();
      this.emitChange();
    }
  }

  private applyChunk(
    run: SkillRun,
    chunk: StreamChunk,
    combinedText: string,
    active: ActiveRunContext
  ): void {
    run.updatedAt = Date.now();

    switch (chunk.type) {
      case 'thinking':
        this.flushPendingTextLog(run, active);
        run.lastLogLine = 'Thinking…';
        this.appendLog(run, 'Thinking…');
        break;
      case 'tool_use':
        this.flushPendingTextLog(run, active);
        run.lastLogLine = formatToolProgress(chunk);
        this.appendLog(run, run.lastLogLine);
        break;
      case 'tool_result':
        this.flushPendingTextLog(run, active);
        if (chunk.isError && chunk.content.trim()) {
          run.lastLogLine = truncateText(chunk.content.trim(), 180);
        }
        this.appendLog(run, chunk.content.trim() || `Tool ${chunk.id} completed.`);
        break;
      case 'blocked':
        this.flushPendingTextLog(run, active);
        run.lastLogLine = truncateText(chunk.content, 180);
        this.appendLog(run, `Blocked: ${chunk.content}`);
        break;
      case 'error':
        this.flushPendingTextLog(run, active);
        run.lastLogLine = truncateText(chunk.content, 180);
        this.appendLog(run, `Error: ${chunk.content}`);
        break;
      case 'done':
        this.flushPendingTextLog(run, active);
        run.summary = extractSummaryFromText(combinedText) ?? run.summary;
        break;
      case 'text':
        this.appendTextLogChunk(run, chunk.content, active);
        break;
      default:
        break;
    }

    this.schedulePersist();
    this.emitChange();
  }

  private async markNeedsAttention(runId: string, reason: string): Promise<void> {
    const run = this.findRun(runId);
    if (!run) return;

    const active = this.activeRuns.get(runId);
    if (active) {
      this.flushPendingTextLog(run, active);
    }

    const now = Date.now();
    run.status = 'needs_attention';
    run.updatedAt = now;
    run.completedAt = now;
    run.attentionReason = reason;
    run.error = reason;
    run.lastLogLine = reason;
    this.schedulePersist();
    this.emitChange();
  }

  private appendLog(run: SkillRun, message: string): void {
    const lines = message
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => line.replace(/\s+$/g, ''))
      .filter(line => line.trim().length > 0);
    if (lines.length === 0) return;

    const timestamp = formatLogTimestamp(Date.now());
    const entry = lines.map(line => `[${timestamp}] ${line}`).join('\n');
    const nextLog = run.log ? `${run.log}\n${entry}` : entry;
    run.log = nextLog.length > MAX_RUN_LOG_CHARS
      ? nextLog.slice(nextLog.length - MAX_RUN_LOG_CHARS)
      : nextLog;
  }

  private appendTextLogChunk(run: SkillRun, content: string, active: ActiveRunContext): void {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!normalized) return;

    const combined = `${active.pendingTextLog}${normalized}`;
    const lines = combined.split('\n');
    active.pendingTextLog = lines.pop() ?? '';

    if (lines.length > 0) {
      this.appendLog(run, lines.join('\n'));
    }
  }

  private flushPendingTextLog(run: SkillRun, active: ActiveRunContext): void {
    const remainder = active.pendingTextLog.replace(/\s+$/g, '');
    active.pendingTextLog = '';
    if (remainder.trim().length > 0) {
      this.appendLog(run, remainder);
    }
  }

  private incrementSkillUsage(skillName: string): void {
    this.skillUsageCounts[skillName] = (this.skillUsageCounts[skillName] ?? 0) + 1;
  }

  private buildUsageCountsFromRuns(runs: SkillRun[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const run of runs) {
      counts[run.skillName] = (counts[run.skillName] ?? 0) + 1;
    }
    return counts;
  }

  private resolveWorkingDirectory(input?: string): string | undefined {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      throw new Error('Could not determine vault path.');
    }

    const trimmed = input?.trim();
    if (!trimmed) {
      return undefined;
    }

    const normalized = normalizePathForFilesystem(trimmed);
    const absolute = path.isAbsolute(normalized)
      ? normalized
      : path.resolve(vaultPath, normalized);

    if (!fs.existsSync(absolute)) {
      throw new Error(`Working directory does not exist: ${trimmed}`);
    }

    if (!fs.statSync(absolute).isDirectory()) {
      throw new Error(`Working directory is not a folder: ${trimmed}`);
    }

    if (!this.plugin.settings.allowExternalAccess && !isPathWithinVault(absolute, vaultPath)) {
      throw new Error('Working directory must stay inside the vault unless external access is enabled.');
    }

    return absolute;
  }

  private async syncConversationSession(
    conversationId: string,
    sessionId: string
  ): Promise<void> {
    if (!this.plugin.getConversationSync(conversationId)) return;

    await this.plugin.updateConversation(conversationId, {
      sessionId,
      sdkSessionId: sessionId,
      isNative: true,
    });
  }

  private async syncConversationCompletion(
    run: SkillRun,
    sessionId: string | null
  ): Promise<void> {
    const conversation = this.plugin.getConversationSync(run.conversationId);
    if (!conversation) return;

    const updates: Partial<Conversation> = {
      lastResponseAt: run.status === 'completed' ? run.completedAt : conversation.lastResponseAt,
    };

    if (sessionId) {
      updates.sessionId = sessionId;
      updates.sdkSessionId = sessionId;
      updates.isNative = true;
    }

    await this.plugin.updateConversation(run.conversationId, updates);
  }

  private findRun(runId: string): SkillRun | undefined {
    return this.runs.find(run => run.id === runId);
  }

  private schedulePersist(): void {
    if (this.pendingPersist !== null) {
      clearTimeout(this.pendingPersist);
    }

    this.pendingPersist = setTimeout(() => {
      this.pendingPersist = null;
      void this.plugin.storage.setSkillRunState(this.getRuns(), { ...this.skillUsageCounts });
    }, 250);
  }

  private async persistStateImmediate(): Promise<void> {
    if (this.pendingPersist !== null) {
      clearTimeout(this.pendingPersist);
      this.pendingPersist = null;
    }
    await this.plugin.storage.setSkillRunState(this.getRuns(), { ...this.skillUsageCounts });
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
