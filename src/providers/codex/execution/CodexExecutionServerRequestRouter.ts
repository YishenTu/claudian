import {
  type PendingInteraction,
  PendingInteractionLedger,
  type ProviderApprovalChoice,
  type ProviderApprovalDecisionOption,
  type ProviderInteractionDismissReason,
  type ProviderInteractionPort,
  type ProviderToolPolicy,
  resolveApprovalChoice,
} from '@/core/execution';
import { t } from '@/i18n/i18n';
import { normalizeCodexToolName } from '@/providers/codex/normalization/codexToolNormalization';
import type {
  CommandApprovalRequest,
  CommandExecutionApprovalDecision,
  CommandExecutionApprovalResponse,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangeApprovalDecision,
  FileChangeApprovalRequest,
  FileChangeApprovalResponse,
  FileSystemPath,
  FileSystemSpecialPath,
  MCPElicitationRequest,
  MCPElicitationResponse,
  PermissionsApprovalRequest,
  PermissionsApprovalResponse,
  RequestId,
  RequestPermissionProfile,
  UserInputRequest,
  UserInputResponse,
} from '@/providers/codex/runtime/codexAppServerTypes';
import type { CodexDynamicToolRegistry } from '@/providers/codex/runtime/CodexDynamicToolRegistry';
import { isCodexSessionTool } from '@/providers/codex/runtime/CodexSessionTools';

export interface ActiveInteractionTurn {
  readonly localTurnId: string;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly toolPolicy: ProviderToolPolicy;
  readonly cancellation: AbortController;
}

interface PendingServerRequest {
  readonly interaction: PendingInteraction;
  readonly nativeKey: string;
}

type NativeTurnObserver = (threadId: string, turnId: string) => boolean;

export class CodexExecutionServerRequestRouter {
  private dynamicToolRegistry: CodexDynamicToolRegistry | null = null;
  private interactionCounter = 0;
  private readonly interactions: PendingInteractionLedger;
  /** Native requests are unique per thread; the ledger keys interactions locally. */
  private readonly pendingByNativeKey = new Map<string, PendingServerRequest>();

  constructor(
    private readonly sessionInstanceId: string,
    private readonly interactionPort: ProviderInteractionPort,
    private readonly observeNativeTurn: NativeTurnObserver,
    /** The run's bound native turn; the run owns it, and its cancellation ends it for this router. */
    private readonly readActiveTurn: () => ActiveInteractionTurn | null,
  ) {
    this.interactions = new PendingInteractionLedger(interactionPort);
  }

  get #activeTurn(): ActiveInteractionTurn | null {
    const turn = this.readActiveTurn();
    return turn && !turn.cancellation.signal.aborted ? turn : null;
  }

  setDynamicToolRegistry(registry: CodexDynamicToolRegistry | null): void {
    this.dynamicToolRegistry = registry;
  }

  async handleServerRequest(
    requestId: RequestId,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return this.#handleCommandApproval(
          requestId,
          params as CommandApprovalRequest,
        );
      case 'item/fileChange/requestApproval':
        return this.#handleFileChangeApproval(
          requestId,
          params as FileChangeApprovalRequest,
        );
      case 'item/permissions/requestApproval':
        return this.#handlePermissionsApproval(
          requestId,
          params as PermissionsApprovalRequest,
        );
      case 'item/tool/requestUserInput':
        return this.#handleUserInputRequest(
          requestId,
          params as UserInputRequest,
        );
      case 'mcpServer/elicitation/request':
        return this.#handleMcpElicitation(requestId, params);
      case 'item/tool/call':
        return this.#handleDynamicToolCall(params as DynamicToolCallParams);
      default:
        throw new Error(`Unsupported server request: ${method}`);
    }
  }

  resolveNativeRequest(
    requestId: RequestId,
    threadId: string,
  ): boolean {
    const pending = this.pendingByNativeKey.get(nativeRequestKey(threadId, requestId));
    if (!pending) return false;

    this.pendingByNativeKey.delete(pending.nativeKey);
    return this.interactions.abort(pending.interaction.interactionId, 'resolved');
  }

  abortAll(reason: ProviderInteractionDismissReason): void {
    this.pendingByNativeKey.clear();
    this.interactions.dismissAll(reason);
    this.#activeTurn?.cancellation.abort();
  }

  async #handleDynamicToolCall(
    params: DynamicToolCallParams,
  ): Promise<DynamicToolCallResponse> {
    const turn = this.#requireActiveTurn(params.threadId, params.turnId);
    if (
      !this.dynamicToolRegistry
      || (!isCodexSessionTool(params.namespace, params.tool) && !isDynamicToolAllowed(turn.toolPolicy))
    ) {
      throw new Error(`Unsupported dynamic tool: ${qualifiedToolName(params)}`);
    }
    return this.dynamicToolRegistry.execute(params, {
      signal: turn.cancellation.signal,
      toolPolicy: turn.toolPolicy,
    });
  }

  async #handleCommandApproval(
    requestId: RequestId,
    params: CommandApprovalRequest,
  ): Promise<CommandExecutionApprovalResponse> {
    const turn = this.#requireActiveTurn(params.threadId, params.turnId);
    if (!shouldRouteApproval(turn.toolPolicy)) {
      return { decision: 'decline' };
    }

    const input = {
      command: params.command ?? '',
      cwd: params.cwd ?? null,
      reason: params.reason ?? null,
      commandActions: params.commandActions ?? null,
      approvalId: params.approvalId ?? null,
      networkApprovalContext: params.networkApprovalContext ?? null,
      additionalPermissions: params.additionalPermissions ?? null,
      skillMetadata: params.skillMetadata ?? null,
      proposedExecpolicyAmendment: params.proposedExecpolicyAmendment ?? null,
      proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments ?? null,
    };
    const choices = buildCommandApprovalChoices(params);
    const pending = this.#createPending(requestId, params.threadId);
    try {
      const response = await this.interactionPort.requestApproval({
        interactionId: pending.interaction.interactionId,
        sessionInstanceId: this.sessionInstanceId,
        turnId: turn.localTurnId,
        kind: 'approval',
        toolName: normalizeCodexToolName('command_execution'),
        input,
        description: describeCommandApproval(params),
        ...(params.reason ? { decisionReason: params.reason } : {}),
        decisionOptions: choices.map(choice => choice.option),
        nativeContext: {
          requestId,
          threadId: params.threadId,
          nativeTurnId: params.turnId,
          itemId: params.itemId,
        },
      }, pending.interaction.signal);
      return {
        decision: response.interactionId === pending.interaction.interactionId
          ? resolveApprovalChoice(choices, response.value) ?? unofferedDecisionReply(response.value)
          : 'decline',
      };
    } finally {
      this.#removePending(pending);
    }
  }

  async #handleFileChangeApproval(
    requestId: RequestId,
    params: FileChangeApprovalRequest,
  ): Promise<FileChangeApprovalResponse> {
    const turn = this.#requireActiveTurn(params.threadId, params.turnId);
    if (!shouldRouteApproval(turn.toolPolicy)) {
      return { decision: 'decline' };
    }

    const choices = buildFileChangeApprovalChoices();
    const pending = this.#createPending(requestId, params.threadId);
    try {
      const response = await this.interactionPort.requestApproval({
        interactionId: pending.interaction.interactionId,
        sessionInstanceId: this.sessionInstanceId,
        turnId: turn.localTurnId,
        kind: 'approval',
        toolName: normalizeCodexToolName('file_change'),
        input: {
          reason: params.reason ?? null,
          grantRoot: params.grantRoot ?? null,
        },
        description: params.reason ? t('chat.approval.fileChangeReason', { reason: params.reason }) : t('chat.approval.fileChange'),
        decisionOptions: choices.map(choice => choice.option),
        nativeContext: {
          requestId,
          threadId: params.threadId,
          nativeTurnId: params.turnId,
          itemId: params.itemId,
        },
      }, pending.interaction.signal);
      return {
        decision: response.interactionId === pending.interaction.interactionId
          ? resolveApprovalChoice(choices, response.value) ?? unofferedDecisionReply(response.value)
          : 'decline',
      };
    } finally {
      this.#removePending(pending);
    }
  }

  async #handlePermissionsApproval(
    requestId: RequestId,
    params: PermissionsApprovalRequest,
  ): Promise<PermissionsApprovalResponse> {
    const turn = this.#requireActiveTurn(params.threadId, params.turnId);
    if (!shouldRouteApproval(turn.toolPolicy)) {
      return { permissions: {}, scope: 'turn' };
    }

    const choices = buildPermissionsApprovalChoices(params);
    const pending = this.#createPending(requestId, params.threadId);
    try {
      const response = await this.interactionPort.requestApproval({
        interactionId: pending.interaction.interactionId,
        sessionInstanceId: this.sessionInstanceId,
        turnId: turn.localTurnId,
        kind: 'approval',
        toolName: 'permissions',
        input: params.permissions as Readonly<Record<string, unknown>>,
        description: describePermissionsApproval(params),
        ...(params.reason ? { decisionReason: params.reason } : {}),
        decisionOptions: choices.map(choice => choice.option),
        nativeContext: {
          requestId,
          threadId: params.threadId,
          nativeTurnId: params.turnId,
          itemId: params.itemId,
        },
      }, pending.interaction.signal);
      const granted = response.interactionId === pending.interaction.interactionId
        ? resolveApprovalChoice(choices, response.value)
        : undefined;
      return granted ?? { permissions: {}, scope: 'turn' };
    } finally {
      this.#removePending(pending);
    }
  }

  async #handleUserInputRequest(
    requestId: RequestId,
    params: UserInputRequest,
  ): Promise<UserInputResponse> {
    const turn = this.#requireActiveTurn(params.threadId, params.turnId);
    if (!shouldRouteApproval(turn.toolPolicy)) {
      return { answers: {} };
    }
    const pending = this.#createPending(requestId, params.threadId);
    try {
      const response = await this.interactionPort.askUserQuestion({
        interactionId: pending.interaction.interactionId,
        sessionInstanceId: this.sessionInstanceId,
        turnId: turn.localTurnId,
        kind: 'question',
        input: { questions: params.questions ?? [] },
        nativeContext: {
          requestId,
          threadId: params.threadId,
          nativeTurnId: params.turnId,
          itemId: params.itemId,
        },
      }, pending.interaction.signal);
      if (
        response.interactionId !== pending.interaction.interactionId
        || response.answers === null
      ) {
        return { answers: {} };
      }

      const answers: UserInputResponse['answers'] = {};
      for (const [key, value] of Object.entries(response.answers)) {
        Object.defineProperty(answers, key, {
          value: {
            answers: (Array.isArray(value) ? value : [value])
              .map(answer => String(answer))
              .filter(answer => answer.trim().length > 0),
          },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return { answers };
    } finally {
      this.#removePending(pending);
    }
  }

  async #handleMcpElicitation(
    requestId: RequestId,
    params: unknown,
  ): Promise<MCPElicitationResponse> {
    if (!isMCPElicitationRequest(params) || params.turnId === null) {
      return { action: 'cancel', content: null };
    }
    if (
      params.mode === 'url'
      || !isEmptyConfirmationSchema(params.requestedSchema)
    ) {
      return { action: 'decline', content: null };
    }

    let pending: PendingServerRequest | undefined;
    try {
      const turn = this.#requireActiveTurn(params.threadId, params.turnId);
      if (!shouldRouteApproval(turn.toolPolicy)) {
        return { action: 'decline', content: null };
      }
      pending = this.#createPending(requestId, params.threadId);
      const response = await this.interactionPort.askUserQuestion({
        interactionId: pending.interaction.interactionId,
        sessionInstanceId: this.sessionInstanceId,
        turnId: turn.localTurnId,
        kind: 'question',
        input: {
          questions: [{
            id: MCP_CONFIRMATION_QUESTION_ID,
            header: t('chat.approval.mcpRequest'),
            question: `${t('chat.approval.mcpServer', { server: params.serverName })}\n\n${params.message}`,
            options: [
              { label: t('common.cancel'), description: t('chat.approval.cancelRequest'), value: 'cancel' },
              { label: t('chat.approval.decline'), description: t('chat.approval.declineRequest'), value: 'decline' },
              { label: t('chat.approval.allow'), description: t('chat.approval.acceptRequest'), value: 'accept' },
            ],
            multiSelect: false,
            isOther: false,
            isSecret: false,
          }],
        },
        nativeContext: {
          requestId,
          threadId: params.threadId,
          nativeTurnId: params.turnId,
          serverName: params.serverName,
        },
      }, pending.interaction.signal);
      if (
        pending.interaction.signal.aborted
        || !isSameTurn(this.#activeTurn, turn)
        || this.interactions.isStaleResponse(pending.interaction, response)
        || !isPlainRecord(response.answers)
        || Object.keys(response.answers).length !== 1
      ) {
        return { action: 'cancel', content: null };
      }
      const answer = response.answers[MCP_CONFIRMATION_QUESTION_ID];
      if (answer === 'accept') return { action: 'accept', content: {} };
      if (answer === 'decline') return { action: 'decline', content: null };
      return { action: 'cancel', content: null };
    } catch {
      // Stale, aborted, and failed interactions must not grant MCP access.
      return { action: 'cancel', content: null };
    } finally {
      if (pending) this.#removePending(pending);
    }
  }

  #requireActiveTurn(
    threadId: string,
    nativeTurnId: string,
  ): ActiveInteractionTurn {
    if (!this.observeNativeTurn(threadId, nativeTurnId)) {
      throw new Error('Stale Codex server request');
    }

    const turn = this.#activeTurn;
    if (
      !turn
      || turn.nativeThreadId !== threadId
      || turn.nativeTurnId !== nativeTurnId
    ) {
      throw new Error('Stale Codex server request');
    }
    return turn;
  }

  #createPending(
    requestId: RequestId,
    threadId: string,
  ): PendingServerRequest {
    const nativeKey = nativeRequestKey(threadId, requestId);
    if (this.pendingByNativeKey.has(nativeKey)) {
      throw new Error('Duplicate Codex server request');
    }

    const interactionId =
      `${this.sessionInstanceId}:interaction:${++this.interactionCounter}`;
    // Local interaction IDs are unique, so the ledger always admits them.
    const pending = { interaction: this.interactions.begin(interactionId)!, nativeKey };
    this.pendingByNativeKey.set(nativeKey, pending);
    return pending;
  }

  /** Forgets a request whose interaction the port completed, without dismissing it. */
  #removePending(pending: PendingServerRequest): void {
    if (this.pendingByNativeKey.get(pending.nativeKey) === pending) {
      this.pendingByNativeKey.delete(pending.nativeKey);
    }
    this.interactions.release(pending.interaction);
  }
}

const MCP_CONFIRMATION_QUESTION_ID = 'mcp-elicitation-confirmation';
const EMPTY_CONFIRMATION_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMCPElicitationRequest(value: unknown): value is MCPElicitationRequest {
  return isPlainRecord(value)
    && typeof value.threadId === 'string' && value.threadId.length > 0
    && (value.turnId === null || (typeof value.turnId === 'string' && value.turnId.length > 0))
    && typeof value.serverName === 'string' && value.serverName.trim().length > 0
    && typeof value.message === 'string'
    && (value.mode === 'form' || value.mode === 'openai/form' || value.mode === 'url');
}

function isEmptyConfirmationSchema(value: unknown): boolean {
  return isPlainRecord(value)
    && Object.keys(value).every(key => EMPTY_CONFIRMATION_SCHEMA_KEYS.has(key))
    && value.type === 'object'
    && isPlainRecord(value.properties)
    && Object.keys(value.properties).length === 0
    && (!('required' in value) || (Array.isArray(value.required) && value.required.length === 0))
    && (!('additionalProperties' in value) || typeof value.additionalProperties === 'boolean');
}

function nativeRequestKey(threadId: string, requestId: RequestId): string {
  return `${threadId}\u0000${String(requestId)}`;
}

function qualifiedToolName(params: DynamicToolCallParams): string {
  return params.namespace ? `${params.namespace}.${params.tool}` : params.tool;
}

function shouldRouteApproval(policy: ProviderToolPolicy): boolean {
  return policy.kind === 'provider-default';
}

function isDynamicToolAllowed(policy: ProviderToolPolicy): boolean {
  return policy.kind === 'provider-default';
}

/** The panel shows only this text and the reason, so it states any extra access the command requests. */
function describeCommandApproval(params: CommandApprovalRequest): string {
  const subject = params.networkApprovalContext
    ? t('chat.approval.networkAccess', { protocol: params.networkApprovalContext.protocol, host: params.networkApprovalContext.host })
    : params.command ? t('chat.approval.execute', { command: params.command }) : t('chat.approval.executeCommand');
  return [subject, ...describeRequestedAccess(params.additionalPermissions)].join(' · ');
}

/** Dismissal answers `cancel` even when Codex offered no cancel option; anything else unoffered declines. */
function unofferedDecisionReply(value: string | null): 'cancel' | 'decline' {
  return value === null ? 'cancel' : 'decline';
}

function buildCommandApprovalChoices(
  params: CommandApprovalRequest,
): ProviderApprovalChoice<CommandExecutionApprovalDecision>[] {
  const available = (params.availableDecisions ?? evidencedCommandDecisions(params)).filter(isPresentableCommandDecision);
  return available.map(decision => ({
    option: mapCommandDecisionOption(decision, params),
    reply: decision,
  }));
}

/** Codex's own menu hides a prefix rule that renders across lines (`exec_options`, tui/src/bottom_pane/approval_overlay.rs). */
function isPresentableCommandDecision(decision: CommandExecutionApprovalDecision): boolean {
  return typeof decision === 'string'
    || !('acceptWithExecpolicyAmendment' in decision)
    || !decision.acceptWithExecpolicyAmendment.execpolicy_amendment.some(token => /[\r\n]/.test(token));
}

/** Codex 0.171's own menu for an omitted list (`default_available_decisions`, tui/src/approval_events.rs). */
function evidencedCommandDecisions(params: CommandApprovalRequest): CommandExecutionApprovalDecision[] {
  if (params.networkApprovalContext) {
    const allow = params.proposedNetworkPolicyAmendments?.find(amendment => amendment.action === 'allow');
    return [
      'accept',
      'acceptForSession',
      ...(allow ? [{ applyNetworkPolicyAmendment: { network_policy_amendment: allow } }] : []),
      'cancel',
    ];
  }
  if (params.additionalPermissions) return ['accept', 'cancel'];
  const execPolicy = params.proposedExecpolicyAmendment;
  return [
    'accept',
    ...(execPolicy ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: execPolicy } }] : []),
    'cancel',
  ];
}

function mapCommandDecisionOption(
  decision: CommandExecutionApprovalDecision,
  params: CommandApprovalRequest,
): ProviderApprovalDecisionOption {
  if (decision === 'accept') {
    return { label: t('chat.approval.allowOnce'), value: 'allow-once', decision: 'allow' };
  }
  if (decision === 'acceptForSession') {
    return {
      label: t('chat.approval.allowForSession'),
      value: 'allow-always',
      decision: 'allow-always',
    };
  }
  if (decision === 'decline') {
    return { label: t('chat.approval.deny'), value: 'deny', decision: 'deny' };
  }
  if (decision === 'cancel') {
    return { label: t('chat.approval.denyAndStop'), value: 'cancel', decision: 'cancel' };
  }
  if ('acceptWithExecpolicyAmendment' in decision) {
    const prefix = decision.acceptWithExecpolicyAmendment.execpolicy_amendment.map(quoteShellToken).join(' ');
    return {
      label: t('chat.approval.allowSimilar'),
      description: prefix
        ? t('chat.approval.execPolicyPrefix', { prefix })
        : t('chat.approval.execPolicy'),
      value: JSON.stringify(decision),
    };
  }

  const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  const host = amendment.host || params.networkApprovalContext?.host || t('chat.approval.host');
  return {
    label: t(amendment.action === 'deny' ? 'chat.approval.denyHost' : 'chat.approval.allowHost', { host }),
    description: t(amendment.action === 'deny' ? 'chat.approval.denyRule' : 'chat.approval.allowRule', { host }),
    value: JSON.stringify(decision),
  };
}

function buildFileChangeApprovalChoices(): ProviderApprovalChoice<FileChangeApprovalDecision>[] {
  return [
    { option: { label: t('chat.approval.allowOnce'), value: 'allow-once', decision: 'allow' }, reply: 'accept' },
    {
      option: { label: t('chat.approval.allowFilesForSession'), value: 'allow-always', decision: 'allow-always' },
      reply: 'acceptForSession',
    },
    // Codex's own file-change menu has no decline that lets the turn continue (tui/src/bottom_pane/approval_overlay.rs).
    { option: { label: t('chat.approval.denyAndStop'), value: 'cancel', decision: 'cancel' }, reply: 'cancel' },
  ];
}

/** States the access a grant would echo back; the panel shows only this text and the reason. */
function describePermissionsApproval(params: PermissionsApprovalRequest): string {
  return [
    params.reason ? t('chat.approval.permissionReason', { reason: params.reason }) : t('chat.approval.permissionRequest'),
    ...describeRequestedAccess(params.permissions),
  ].join(' · ');
}

function describeRequestedAccess(profile: RequestPermissionProfile | null | undefined): string[] {
  const read = new Set(profile?.fileSystem?.read ?? []);
  const write = new Set(profile?.fileSystem?.write ?? []);
  // Deny entries grant nothing but narrow what the grant allows, so Codex lists them too.
  const denied = new Set<string>();
  for (const entry of profile?.fileSystem?.entries ?? []) {
    const path = describeFileSystemPath(entry.path);
    if (entry.access === 'read') read.add(path);
    else if (entry.access === 'write') write.add(path);
    else denied.add(path);
  }
  return [
    ...(read.size > 0 ? [t('chat.approval.permissionRead', { paths: [...read].join(', ') })] : []),
    ...(write.size > 0 ? [t('chat.approval.permissionWrite', { paths: [...write].join(', ') })] : []),
    ...(denied.size > 0 ? [t('chat.approval.permissionDenyRead', { paths: [...denied].join(', ') })] : []),
    ...(profile?.network?.enabled === true ? [t('chat.approval.permissionNetwork')] : []),
  ];
}

/** Keeps argument boundaries visible: a rule for `npm run 'build docs'` differs from `npm run build docs`. */
function quoteShellToken(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`;
}

function describeFileSystemPath(path: FileSystemPath): string {
  switch (path.type) {
    case 'path': return path.path;
    case 'glob_pattern': return path.pattern;
    case 'special': return describeSpecialPath(path.value);
    default: return JSON.stringify(path);
  }
}

function describeSpecialPath(value: FileSystemSpecialPath): string {
  switch (value.kind) {
    case 'root': return t('chat.approval.permissionFullDisk');
    case 'minimal': return t('chat.approval.permissionMinimalPaths');
    case 'project_roots':
      return value.subpath
        ? t('chat.approval.permissionProjectRootsSubpath', { subpath: value.subpath })
        : t('chat.approval.permissionProjectRoots');
    case 'tmpdir': return '$TMPDIR';
    case 'slash_tmp': return '/tmp';
    case 'unknown': return value.subpath ? `${value.path}/${value.subpath}` : value.path;
    default: return JSON.stringify(value);
  }
}

function buildPermissionsApprovalChoices(
  params: PermissionsApprovalRequest,
): ProviderApprovalChoice<PermissionsApprovalResponse>[] {
  return [
    {
      option: { label: t('chat.approval.allowForTurn'), value: 'allow-turn', decision: 'allow' },
      reply: { permissions: params.permissions, scope: 'turn' },
    },
    {
      option: { label: t('chat.approval.allowForSession'), value: 'allow-session', decision: 'allow-always' },
      reply: { permissions: params.permissions, scope: 'session' },
    },
    {
      option: { label: t('chat.approval.deny'), value: 'deny', decision: 'deny' },
      reply: { permissions: {}, scope: 'turn' },
    },
  ];
}

function isSameTurn(current: ActiveInteractionTurn | null, turn: ActiveInteractionTurn): boolean {
  return current !== null
    && current.localTurnId === turn.localTurnId
    && current.nativeThreadId === turn.nativeThreadId
    && current.nativeTurnId === turn.nativeTurnId;
}
