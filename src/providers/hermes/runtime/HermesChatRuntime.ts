import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type { ProviderCapabilities } from '../../../core/providers/types';
import type { ChatRuntime } from '../../../core/runtime/ChatRuntime';
import type {
	ApprovalCallback,
	ApprovalDecisionOption,
	AskUserQuestionCallback,
	AutoTurnCallback,
	ChatRewindMode,
	ChatRewindResult,
	ChatRuntimeConversationState,
	ChatRuntimeEnsureReadyOptions,
	ChatRuntimeQueryOptions,
	ChatTurnMetadata,
	ChatTurnRequest,
	ExitPlanModeCallback,
	PreparedChatTurn,
	SessionUpdateResult,
	SubagentRuntimeState,
} from '../../../core/runtime/types';
import type {
	ApprovalDecision,
	ChatMessage,
	Conversation,
	SlashCommand,
	StreamChunk,
	ToolCallInfo,
} from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { getEnhancedPath } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import {
	AcpClientConnection,
	AcpJsonRpcTransport,
	type AcpReadTextFileRequest,
	type AcpRequestPermissionRequest,
	type AcpRequestPermissionResponse,
	type AcpSessionNotification,
	AcpSessionUpdateNormalizer,
	AcpSubprocess,
	type AcpUsage,
	type AcpUsageUpdate,
	type AcpWriteTextFileRequest,
	buildAcpUsageInfo,
} from '../../acp';
import { HERMES_PROVIDER_CAPABILITIES } from '../capabilities';
import {
	decodeHermesModelId,
	isHermesModelSelectionId,
} from '../models';
import { getHermesProviderSettings } from '../settings';
import { getHermesProviderState, type HermesProviderState } from '../types';

interface ActiveTurn {
	queue: StreamChunkQueue;
	sessionId: string;
}

class StreamChunkQueue {
	private closed = false;
	private readonly items: StreamChunk[] = [];
	private readonly waiters: Array<(chunk: StreamChunk | null) => void> = [];

	push(chunk: StreamChunk): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(chunk);
			return;
		}
		this.items.push(chunk);
	}

	close(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		while (this.waiters.length > 0) {
			this.waiters.shift()?.(null);
		}
	}

	async next(): Promise<StreamChunk | null> {
		if (this.items.length > 0) {
			return this.items.shift() ?? null;
		}

		if (this.closed) {
			return null;
		}

		return new Promise<StreamChunk | null>((resolve) => {
			this.waiters.push(resolve);
		});
	}
}

export class HermesChatRuntime implements ChatRuntime {
	readonly providerId = 'hermes' as const;

	private activeTurn: ActiveTurn | null = null;
	private approvalCallback: ApprovalCallback | null = null;
	private connection: AcpClientConnection | null = null;
	private contextUsage: AcpUsageUpdate | null = null;
	private currentLaunchKey: string | null = null;
	private currentSessionModelId: string | null = null;
	private currentTurnMetadata: ChatTurnMetadata = {};
	private loadedSessionId: string | null = null;
	private process: AcpSubprocess | null = null;
	private promptUsage: AcpUsage | null = null;
	private readonly readyListeners: Array<(ready: boolean) => void> = [];
	private ready = false;
	private sessionInvalidated = false;
	private readonly supportedCommandWaiters: Array<(commands: SlashCommand[]) => void> = [];
	private supportedCommands: SlashCommand[] = [];
	private sessionCwds = new Map<string, string>();
	private sessionId: string | null = null;
	private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
	private transport: AcpJsonRpcTransport | null = null;
	private unregisterTransportClose: (() => void) | null = null;

	constructor(
		private readonly plugin: ClaudianPlugin,
	) {}

	getCapabilities(): Readonly<ProviderCapabilities> {
		return HERMES_PROVIDER_CAPABILITIES;
	}

	prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
		return {
			isCompact: false,
			mcpMentions: request.enabledMcpServers ?? new Set(),
			persistedContent: '',
			prompt: request.text,
			request,
		};
	}

	onReadyStateChange(listener: (ready: boolean) => void): () => void {
		this.readyListeners.push(listener);
		return () => {
			const index = this.readyListeners.indexOf(listener);
			if (index >= 0) {
				this.readyListeners.splice(index, 1);
			}
		};
	}

	setResumeCheckpoint(_checkpointId: string | undefined): void {}

	syncConversationState(
		conversation: ChatRuntimeConversationState | null,
	): void {
		const nextSessionId = conversation?.sessionId ?? null;
		if (this.sessionId !== nextSessionId) {
			this.currentSessionModelId = null;
			this.sessionInvalidated = false;
			this.setSupportedCommands([]);
		}
		this.sessionId = nextSessionId;
	}

	async reloadMcpServers(): Promise<void> {}

	async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
		const settings = getHermesProviderSettings(this.plugin.settings);
		if (!settings.enabled) {
			this.setReady(false);
			return false;
		}

		const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
		const targetSessionId = this.sessionId;
		const resolvedCliPath = this.plugin.getResolvedProviderCliPath('hermes') ?? 'hermes';

		const nextLaunchKey = JSON.stringify({
			command: resolvedCliPath,
			envText: getRuntimeEnvironmentText(this.plugin.settings, 'hermes'),
			profile: settings.profile,
		});

		const shouldRestart = !this.process
			|| !this.transport
			|| !this.connection
			|| !this.process.isAlive()
			|| this.transport.isClosed
			|| options?.force === true
			|| this.currentLaunchKey !== nextLaunchKey;

		if (shouldRestart) {
			await this.shutdownProcess();
			await this.startProcess({
				command: resolvedCliPath,
				cwd,
			});
			this.currentLaunchKey = nextLaunchKey;
			this.loadedSessionId = null;
		}

		if (targetSessionId) {
			if (this.loadedSessionId !== targetSessionId) {
				const loaded = await this.loadSession(targetSessionId, cwd);
				if (!loaded) {
					this.sessionInvalidated = true;
					this.clearActiveSession();
				}
			}
			return true;
		}

		if (!this.sessionId && !this.sessionInvalidated) {
			if (options?.allowSessionCreation === false) {
				return true;
			}
			return Boolean(await this.createSession(cwd));
		}

		return true;
	}

	async *query(
		turn: PreparedChatTurn,
		conversationHistory?: ChatMessage[],
		queryOptions?: ChatRuntimeQueryOptions,
	): AsyncGenerator<StreamChunk> {

		if (!(await this.ensureReady())) {
			yield { type: 'error', content: 'Failed to start Hermes. Check the CLI path and login state.' };
			yield { type: 'done' };
			return;
		}

		if (!this.connection) {
			yield { type: 'error', content: 'Hermes runtime is not ready.' };
			yield { type: 'done' };
			return;
		}

		const cwd = getVaultPath(this.plugin.app) ?? process.cwd();

		if (!this.sessionId) {
			const sessionId = await this.createSession(cwd);
			if (!sessionId) {
				yield { type: 'error', content: 'Failed to create a Hermes session.' };
				yield { type: 'done' };
				return;
			}
		}

		const sessionId = this.sessionId!;
		this.activeTurn?.queue.close();
		this.activeTurn = {
			queue: new StreamChunkQueue(),
			sessionId,
		};
		this.currentTurnMetadata = {};
		this.contextUsage = null;
		this.promptUsage = null;
		this.sessionUpdateNormalizer.reset();

		const activeTurn = this.activeTurn;
		try {
			await this.applySelectedModel(sessionId, queryOptions);
		} catch (error) {
			yield {
				type: 'error',
				content: this.formatRuntimeError(error),
			};
			yield { type: 'done' };
			activeTurn.queue.close();
			this.activeTurn = null;
			return;
		}

		const promptPromise = this.connection.prompt({
			prompt: [{ type: 'text', text: turn.prompt }],
			sessionId,
		}).then((response) => {
			if (response.userMessageId) {
				this.currentTurnMetadata.userMessageId = response.userMessageId;
			}
			this.promptUsage = response.usage ?? null;

			const usage = buildAcpUsageInfo({
				contextWindow: this.contextUsage,
				model: this.getActiveDisplayModel(queryOptions),
				promptUsage: this.promptUsage,
			});
			if (usage) {
				activeTurn.queue.push({ sessionId, type: 'usage', usage });
			}

			activeTurn.queue.push({ type: 'done' });
			activeTurn.queue.close();
		}).catch((error) => {
			activeTurn.queue.push({
				type: 'error',
				content: this.formatRuntimeError(error),
			});
			activeTurn.queue.push({ type: 'done' });
			activeTurn.queue.close();
		}).finally(() => {
			if (this.activeTurn === activeTurn) {
				this.activeTurn = null;
			}
		});

		try {
			while (true) {
				const chunk = await activeTurn.queue.next();
				if (!chunk) {
					break;
				}
				yield chunk;
			}
			await promptPromise;
		} finally {
			if (this.activeTurn === activeTurn) {
				this.activeTurn = null;
			}
		}
	}

	cancel(): void {
		if (this.connection && this.sessionId) {
			this.connection.cancel({ sessionId: this.sessionId });
		}
	}

	resetSession(): void {
		this.clearActiveSession();
		this.sessionInvalidated = false;
	}

	getSessionId(): string | null {
		return this.sessionId;
	}

	consumeSessionInvalidation(): boolean {
		const invalidated = this.sessionInvalidated;
		this.sessionInvalidated = false;
		return invalidated;
	}

	isReady(): boolean {
		return this.ready;
	}

	async getSupportedCommands(): Promise<SlashCommand[]> {
		if (this.supportedCommands.length > 0 && this.loadedSessionId === this.sessionId) {
			return [...this.supportedCommands];
		}

		if (this.sessionId && this.loadedSessionId !== this.sessionId) {
			const ready = await this.ensureReady({ allowSessionCreation: false });
			if (!ready) {
				return [];
			}
		}

		if (!this.sessionId) {
			return [];
		}

		if (this.supportedCommands.length > 0) {
			return [...this.supportedCommands];
		}

		if (!this.sessionId || this.loadedSessionId !== this.sessionId) {
			return [];
		}

		return this.waitForSupportedCommands();
	}

	cleanup(): void {
		this.activeTurn?.queue.close();
		void this.shutdownProcess();
	}

	async rewind(
		_userMessageId: string,
		_assistantMessageId: string,
		_mode?: ChatRewindMode,
	): Promise<ChatRewindResult> {
		return { canRewind: false };
	}

	setApprovalCallback(callback: ApprovalCallback | null): void {
		this.approvalCallback = callback;
	}

	setApprovalDismisser(_dismisser: (() => void) | null): void {}

	setAskUserQuestionCallback(_callback: AskUserQuestionCallback | null): void {}

	setExitPlanModeCallback(_callback: ExitPlanModeCallback | null): void {}

	setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {}

	setSubagentHookProvider(_getState: () => SubagentRuntimeState): void {}

	setAutoTurnCallback(_callback: AutoTurnCallback | null): void {}

	consumeTurnMetadata(): ChatTurnMetadata {
		const metadata = this.currentTurnMetadata;
		this.currentTurnMetadata = {};
		return metadata;
	}

	buildSessionUpdates(params: {
		conversation: Conversation | null;
		sessionInvalidated: boolean;
	}): SessionUpdateResult {
		const providerState: HermesProviderState = {};
		const updates: Partial<Conversation> = {
			providerState: undefined,
			sessionId: this.sessionId,
		};

		if (this.sessionId) {
			providerState.sessionId = this.sessionId;
		}

		if (Object.keys(providerState).length > 0) {
			updates.providerState = providerState as Record<string, unknown>;
		}

		if (params.sessionInvalidated) {
			if (!this.sessionId) {
				updates.providerState = undefined;
				updates.sessionId = null;
			}
		}

		return { updates };
	}

	resolveSessionIdForFork(conversation: Conversation | null): string | null {
		const state = conversation?.providerState
			? getHermesProviderState(conversation.providerState)
			: null;
		return this.sessionId ?? state?.sessionId ?? conversation?.sessionId ?? null;
	}

	async loadSubagentToolCalls(_agentId: string): Promise<ToolCallInfo[]> {
		return [];
	}

	async loadSubagentFinalResult(_agentId: string): Promise<string | null> {
		return null;
	}

	private async startProcess(params: {
		command: string;
		cwd: string;
	}): Promise<void> {
		const processEnv: NodeJS.ProcessEnv = {
			...process.env,
			PATH: getEnhancedPath(
				process.env.PATH,
				path.isAbsolute(params.command) ? params.command : undefined,
			),
		};

		const hermesSettings = getHermesProviderSettings(this.plugin.settings);
		const args = ['acp'];
		if (hermesSettings.profile) {
			args.push('--profile', hermesSettings.profile);
		}

		this.process = new AcpSubprocess({
			args,
			command: params.command,
			cwd: params.cwd,
			env: processEnv,
		});
		this.process.start();

		this.transport = new AcpJsonRpcTransport({
			input: this.process.stdout,
			onClose: (listener) => this.process!.onClose(listener),
			output: this.process.stdin,
		});
		const transport = this.transport;
		this.unregisterTransportClose = transport.onClose(() => {
			if (this.transport === transport) {
				this.setReady(false);
			}
		});

		this.connection = new AcpClientConnection({
			clientInfo: {
				name: 'claudian',
				version: this.plugin.manifest?.version ?? '0.0.0',
			},
			delegate: {
				fileSystem: {
					readTextFile: (request) => this.readTextFile(request),
					writeTextFile: (request) => this.writeTextFile(request),
				},
				onSessionNotification: (notification) => this.handleSessionNotification(notification),
				requestPermission: (request) => this.handlePermissionRequest(request),
			},
			transport: this.transport,
		});

		this.transport.start();
		await this.connection.initialize();
		this.setReady(true);
	}

	private async shutdownProcess(): Promise<void> {
		this.setReady(false);
		this.activeTurn?.queue.close();
		this.activeTurn = null;
		this.currentSessionModelId = null;
		this.setSupportedCommands([]);

		this.unregisterTransportClose?.();
		this.unregisterTransportClose = null;

		this.connection?.dispose();
		this.connection = null;

		this.transport?.dispose();
		this.transport = null;

		if (this.process) {
			await this.process.shutdown().catch(() => {});
			this.process = null;
		}
	}

	private setReady(ready: boolean): void {
		if (this.ready === ready) {
			return;
		}

		this.ready = ready;
		for (const listener of this.readyListeners) {
			listener(ready);
		}
	}

	private async applySelectedModel(
		sessionId: string,
		queryOptions?: ChatRuntimeQueryOptions,
	): Promise<void> {
		if (!this.connection) {
			return;
		}

		const selectedRawModelId = this.resolveSelectedRawModelId(queryOptions);
		if (!selectedRawModelId || selectedRawModelId === this.currentSessionModelId) {
			return;
		}

		await this.connection.setConfigOption({
			configId: 'model',
			sessionId,
			type: 'select',
			value: selectedRawModelId,
		});
		this.currentSessionModelId = selectedRawModelId;
	}

	private resolveSelectedRawModelId(queryOptions?: ChatRuntimeQueryOptions): string | null {
		const providerSettings = this.plugin.settings as unknown as Record<string, unknown>;
		const hermesSettings = getHermesProviderSettings(providerSettings);
		const selectedModel = typeof queryOptions?.model === 'string'
			? queryOptions.model
			: typeof (providerSettings as Record<string, unknown>).model === 'string'
				? (providerSettings as Record<string, unknown>).model as string
				: '';

		if (!selectedModel || !isHermesModelSelectionId(selectedModel)) {
			return null;
		}

		const decoded = decodeHermesModelId(selectedModel);
		if (!decoded) {
			return null;
		}

		const availableModelIds = new Set(hermesSettings.discoveredModels.map((model) => model.rawId));
		if (availableModelIds.size > 0 && !availableModelIds.has(decoded)) {
			return null;
		}

		return decoded;
	}

	private getActiveDisplayModel(queryOptions?: ChatRuntimeQueryOptions): string | undefined {
		const selectedRawModelId = this.resolveSelectedRawModelId(queryOptions);
		if (selectedRawModelId) {
			return `hermes:${selectedRawModelId}`;
		}

		return this.currentSessionModelId
			? `hermes:${this.currentSessionModelId}`
			: undefined;
	}

	private async createSession(cwd: string): Promise<string | null> {
		if (!this.connection) {
			return null;
		}

		try {
			this.setSupportedCommands([]);
			const response = await this.connection.newSession({
				cwd,
				mcpServers: [],
			});
			this.loadedSessionId = response.sessionId;
			this.sessionId = response.sessionId;
			this.sessionCwds.set(response.sessionId, cwd);
			return response.sessionId;
		} catch {
			return null;
		}
	}

	private async loadSession(sessionId: string, cwd: string): Promise<boolean> {
		if (!this.connection) {
			return false;
		}

		try {
			this.setSupportedCommands([]);
			const response = await this.connection.loadSession({
				cwd,
				mcpServers: [],
				sessionId,
			});
			this.sessionInvalidated = false;
			this.loadedSessionId = response.sessionId;
			this.sessionId = response.sessionId;
			this.sessionCwds.set(response.sessionId, cwd);
			return true;
		} catch {
			return false;
		}
	}

	private async handleSessionNotification(
		notification: AcpSessionNotification,
	): Promise<void> {
		if (notification.sessionId !== this.sessionId) {
			return;
		}

		const normalized = this.sessionUpdateNormalizer.normalize(notification.update);

		if (normalized.type === 'commands') {
			this.setSupportedCommands(normalized.commands);
			return;
		}

		if (!this.activeTurn || this.activeTurn.sessionId !== notification.sessionId) {
			return;
		}

		switch (normalized.type) {
			case 'message_chunk': {
				if (normalized.role === 'assistant' && normalized.messageId) {
					this.currentTurnMetadata.assistantMessageId = normalized.messageId;
				}
				if (normalized.role === 'user' && normalized.messageId) {
					this.currentTurnMetadata.userMessageId = normalized.messageId;
				}
				for (const chunk of normalized.streamChunks) {
					this.activeTurn.queue.push(chunk);
				}
				return;
			}
			case 'tool_call':
			case 'tool_call_update': {
				for (const chunk of normalized.streamChunks) {
					this.activeTurn.queue.push(chunk);
				}
				return;
			}
			case 'usage': {
				this.contextUsage = normalized.usage;
				const usage = buildAcpUsageInfo({
					contextWindow: normalized.usage,
					model: this.getActiveDisplayModel(),
					promptUsage: this.promptUsage,
				});
				if (usage) {
					this.activeTurn.queue.push({
						sessionId: notification.sessionId,
						type: 'usage',
						usage,
					});
				}
				return;
			}
			default:
				return;
		}
	}

	private async handlePermissionRequest(
		request: AcpRequestPermissionRequest,
	): Promise<AcpRequestPermissionResponse> {
		if (!this.approvalCallback) {
			return { outcome: { outcome: 'cancelled' } };
		}

		const input = normalizeApprovalInput(request.toolCall.rawInput);
		const toolName = request.toolCall.title || 'tool';
		const description = `Hermes wants permission to use ${toolName}.`;
		const decision = await this.approvalCallback(
			toolName,
			input,
			description,
			{
				decisionOptions: buildAcpApprovalDecisionOptions(request.options),
			},
		);

		return mapApprovalDecision(decision, request.options);
	}

	private async readTextFile(
		request: AcpReadTextFileRequest,
	): Promise<{ content: string }> {
		const resolvedPath = this.resolveSessionPath(request.sessionId, request.path);
		const content = await fs.readFile(resolvedPath, 'utf-8');

		if (request.line === undefined && request.limit === undefined) {
			return { content };
		}

		const lines = content.split(/\r?\n/);
		const startIndex = Math.max(0, (request.line ?? 1) - 1);
		const endIndex = request.limit
			? startIndex + Math.max(0, request.limit)
			: lines.length;

		return {
			content: lines.slice(startIndex, endIndex).join('\n'),
		};
	}

	private async writeTextFile(
		request: AcpWriteTextFileRequest,
	): Promise<Record<string, never>> {
		const resolvedPath = this.resolveSessionPath(request.sessionId, request.path);
		await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
		await fs.writeFile(resolvedPath, request.content, 'utf-8');
		return {};
	}

	private resolveSessionPath(sessionId: string, rawPath: string): string {
		if (path.isAbsolute(rawPath)) {
			return rawPath;
		}

		const cwd = this.sessionCwds.get(sessionId)
			?? getVaultPath(this.plugin.app)
			?? process.cwd();
		return path.resolve(cwd, rawPath);
	}

	private formatRuntimeError(error: unknown): string {
		const baseMessage = error instanceof Error ? error.message : 'Hermes request failed';
		const stderr = this.process?.getStderrSnapshot();
		return stderr ? `${baseMessage}\n\n${stderr}` : baseMessage;
	}

	private clearActiveSession(): void {
		this.sessionId = null;
		this.loadedSessionId = null;
		this.currentSessionModelId = null;
		this.setSupportedCommands([]);
	}

	private setSupportedCommands(commands: SlashCommand[]): void {
		this.supportedCommands = commands.map((command) => ({ ...command }));

		const waiters = this.supportedCommandWaiters.splice(0);
		for (const waiter of waiters) {
			waiter(this.supportedCommands);
		}
	}

	private waitForSupportedCommands(timeoutMs = 250): Promise<SlashCommand[]> {
		if (this.supportedCommands.length > 0) {
			return Promise.resolve([...this.supportedCommands]);
		}

		return new Promise<SlashCommand[]>((resolve) => {
			const waiter = (commands: SlashCommand[]) => {
				window.clearTimeout(timeoutId);
				resolve([...commands]);
			};
			const timeoutId = window.setTimeout(() => {
				const index = this.supportedCommandWaiters.indexOf(waiter);
				if (index >= 0) {
					this.supportedCommandWaiters.splice(index, 1);
				}
				resolve([...this.supportedCommands]);
			}, timeoutMs);

			this.supportedCommandWaiters.push(waiter);
		});
	}
}

function normalizeApprovalInput(rawInput: unknown): Record<string, unknown> {
	if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
		return rawInput as Record<string, unknown>;
	}
	if (rawInput === undefined) {
		return {};
	}
	return { value: rawInput };
}

function mapApprovalDecision(
	decision: ApprovalDecision,
	options: readonly {
		kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
		optionId: string;
	}[],
): AcpRequestPermissionResponse {
	if (decision === 'allow') {
		return selectPermissionOption(options, ['allow_once', 'allow_always']);
	}

	if (decision === 'allow-always') {
		return selectPermissionOption(options, ['allow_always', 'allow_once']);
	}

	if (decision === 'deny') {
		return selectPermissionOption(options, ['reject_once', 'reject_always']);
	}

	if (typeof decision === 'object' && decision.type === 'select-option') {
		return {
			outcome: {
				optionId: decision.value,
				outcome: 'selected',
			},
		};
	}

	return { outcome: { outcome: 'cancelled' } };
}

function buildAcpApprovalDecisionOptions(
	options: readonly {
		kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
		name: string;
		optionId: string;
	}[],
): ApprovalDecisionOption[] {
	return options.map((option) => ({
		...(option.kind === 'allow_once'
			? { decision: 'allow' as const }
			: option.kind === 'allow_always'
				? { decision: 'allow-always' as const }
				: {}),
		label: option.name,
		value: option.optionId,
	}));
}

function selectPermissionOption(
	options: readonly {
		kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
		optionId: string;
	}[],
	preferredKinds: readonly ('allow_once' | 'allow_always' | 'reject_once' | 'reject_always')[],
): AcpRequestPermissionResponse {
	for (const kind of preferredKinds) {
		const option = options.find((entry) => entry.kind === kind);
		if (option) {
			return {
				outcome: {
					optionId: option.optionId,
					outcome: 'selected',
				},
			};
		}
	}

	return { outcome: { outcome: 'cancelled' } };
}
