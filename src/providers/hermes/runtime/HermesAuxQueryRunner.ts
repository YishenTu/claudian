import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';
import {
	AcpClientConnection,
	AcpJsonRpcTransport,
	type AcpReadTextFileRequest,
	type AcpRequestPermissionRequest,
	type AcpRequestPermissionResponse,
	AcpSessionUpdateNormalizer,
	AcpSubprocess,
} from '../../acp';
import { decodeHermesModelId } from '../models';

export class HermesAuxQueryRunner implements AuxQueryRunner {
	private connection: AcpClientConnection | null = null;
	private currentModelId: string | null = null;
	private currentLaunchKey: string | null = null;
	private process: AcpSubprocess | null = null;
	private readonly sessionCwds = new Map<string, string>();
	private sessionId: string | null = null;
	private readonly sessionUpdateNormalizer = new AcpSessionUpdateNormalizer();
	private transport: AcpJsonRpcTransport | null = null;

	constructor(
		private readonly plugin: ClaudianPlugin,
	) {}

	async query(config: AuxQueryConfig, prompt: string): Promise<string> {
		const cwd = getVaultPath(this.plugin.app) ?? process.cwd();
		await this.ensureReady(cwd);

		if (!this.connection) {
			throw new Error('Hermes runtime is not ready.');
		}

		if (!this.sessionId) {
			const sessionId = await this.createSession(cwd);
			if (!sessionId) {
				throw new Error('Failed to create a Hermes session.');
			}
		}

		const sessionId = this.sessionId!;
		const selectedModel = this.resolveSelectedRawModel(config.model);
		if (selectedModel && selectedModel !== this.currentModelId) {
			await this.connection.setConfigOption({
				configId: 'model',
				sessionId,
				type: 'select',
				value: selectedModel,
			});
			this.currentModelId = selectedModel;
		}

		this.sessionUpdateNormalizer.reset();
		let accumulatedText = '';
		const removeListener = this.connection.onSessionNotification((notification) => {
			if (notification.sessionId !== sessionId) {
				return;
			}

			const normalized = this.sessionUpdateNormalizer.normalize(notification.update);
			if (normalized.type !== 'message_chunk' || normalized.role !== 'assistant') {
				return;
			}

			for (const chunk of normalized.streamChunks) {
				if (chunk.type !== 'text') {
					continue;
				}

				accumulatedText += chunk.content;
				config.onTextChunk?.(accumulatedText);
			}
		});

		const abortHandler = () => {
			if (this.connection && this.sessionId) {
				this.connection.cancel({ sessionId: this.sessionId });
			}
		};
		config.abortController?.signal.addEventListener('abort', abortHandler, { once: true });

		try {
			if (config.abortController?.signal.aborted) {
				throw new Error('Cancelled');
			}

			await this.connection.prompt({
				prompt: [{ type: 'text', text: prompt }],
				sessionId,
			});

			if (config.abortController?.signal.aborted) {
				throw new Error('Cancelled');
			}

			return accumulatedText;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Hermes request failed';
			const stderr = this.process?.getStderrSnapshot();
			throw new Error(
				stderr ? `${message}\n\n${stderr}` : message,
				error instanceof Error ? { cause: error } : undefined,
			);
		} finally {
			config.abortController?.signal.removeEventListener('abort', abortHandler);
			removeListener();
		}
	}

	reset(): void {
		this.sessionId = null;
		this.sessionCwds.clear();
		this.currentModelId = null;
		this.currentLaunchKey = null;
		this.connection?.dispose();
		this.connection = null;
		this.transport?.dispose();
		this.transport = null;
		if (this.process) {
			void this.process.shutdown().catch(() => {});
		}
		this.process = null;
		this.sessionUpdateNormalizer.reset();
	}

	private async ensureReady(cwd: string): Promise<void> {
		const resolvedCliPath = this.plugin.getResolvedProviderCliPath('hermes') ?? 'hermes';

		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		const nextLaunchKey = JSON.stringify({
			command: resolvedCliPath,
			envText: getRuntimeEnvironmentText(settings, 'hermes'),
		});

		const shouldRestart = !this.process
			|| !this.transport
			|| !this.connection
			|| !this.process.isAlive()
			|| this.transport.isClosed
			|| this.currentLaunchKey !== nextLaunchKey;

		if (!shouldRestart) {
			return;
		}

		this.reset();
		await this.startProcess(resolvedCliPath, cwd);
		this.currentLaunchKey = nextLaunchKey;
	}

	private async createSession(cwd: string): Promise<string | null> {
		if (!this.connection) {
			return null;
		}

		try {
			const response = await this.connection.newSession({
				cwd,
				mcpServers: [],
			});
			this.sessionId = response.sessionId;
			this.sessionCwds.set(response.sessionId, cwd);
			return response.sessionId;
		} catch {
			return null;
		}
	}

	private async startProcess(command: string, cwd: string): Promise<void> {
		const processEnv: NodeJS.ProcessEnv = { ...process.env };

		this.process = new AcpSubprocess({
			args: ['acp', `--cwd=${cwd}`],
			command,
			cwd,
			env: processEnv,
		});
		this.process.start();

		this.transport = new AcpJsonRpcTransport({
			input: this.process.stdout,
			onClose: (listener) => this.process!.onClose(listener),
			output: this.process.stdin,
		});

		this.connection = new AcpClientConnection({
			clientInfo: {
				name: 'claudian-aux',
				version: this.plugin.manifest?.version ?? '0.0.0',
			},
			delegate: {
				requestPermission: (request) => this.handlePermissionRequest(request),
			},
			transport: this.transport,
		});

		this.transport.start();
		await this.connection.initialize();
	}

	private async handlePermissionRequest(
		request: AcpRequestPermissionRequest,
	): Promise<AcpRequestPermissionResponse> {
		// Aux queries run autonomously; reject any permission prompts.
		return selectPermissionOption(request.options, ['reject_once', 'reject_always']);
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

	private resolveSelectedRawModel(explicitModel?: string): string | null {
		if (!explicitModel) {
			return null;
		}

		const trimmed = explicitModel.trim();
		if (!trimmed) {
			return null;
		}

		return decodeHermesModelId(trimmed) ?? trimmed;
	}

	private resolveSessionPath(sessionId: string, rawPath: string): string {
		const cwd = this.sessionCwds.get(sessionId)
			?? getVaultPath(this.plugin.app)
			?? process.cwd();
		const resolvedPath = path.isAbsolute(rawPath)
			? path.resolve(rawPath)
			: path.resolve(cwd, rawPath);
		const relative = path.relative(cwd, resolvedPath);
		if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
			return resolvedPath;
		}

		throw new Error('Hermes aux read access is limited to the current workspace.');
	}
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
