import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import sessionConfigOptions from '@test/fixtures/providers/antigravity/runtime/session-config-options.json';
import { createNativeRPCPeer, type NativeRPCPeer } from '@test/helpers/providers/NativeRPCTestProcess';
import { parse } from 'yaml';

import type {
  ACPCreateElicitationRequest,
  ACPCreateElicitationResponse,
  ACPInitializeRequest,
  ACPMCPServer,
  ACPNewSessionRequest,
  ACPPromptRequest,
  ACPPromptResponse,
  ACPRequestPermissionRequest,
  ACPRequestPermissionResponse,
  ACPResumeSessionRequest,
  ACPSessionConfigOption,
  ACPSetSessionConfigOptionRequest,
} from '@/providers/acp';

/** Config options as `agy acp` 1.5.0 reports them on session/new, resume and load. */
export function antigravityConfigOptions(): ACPSessionConfigOption[] {
  return structuredClone(sessionConfigOptions) as ACPSessionConfigOption[];
}

export type CapturedAntigravityAgent = { readonly kind: 'default' } | {
  readonly kind: 'custom';
  readonly body: string;
  readonly frontmatter: { name: string; description: string; mainAgent: boolean; subagent: boolean; excludeDefaultComponents: boolean; tools: string[] };
};

interface HeldPrompt {
  /** Snapshot at receipt, before any subsequent resume can install MCP servers. */
  readonly mcpServersAtReceipt: readonly ACPMCPServer[];
  readonly request: ACPPromptRequest;
  settled: boolean;
  resolve(response: ACPPromptResponse): void;
}

/**
 * `agy acp` peer. Prompts stay pending until the test resolves them, matching agy's turn model:
 * a later prompt or `session/cancel` settles the previous one at once.
 */
export class AntigravityNativeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly cancelRequests: string[] = [];
  readonly closeRequests: string[] = [];
  readonly configRequests: ACPSetSessionConfigOptionRequest[] = [];
  readonly initializeRequests: ACPInitializeRequest[] = [];
  readonly loadRequests: Record<string, unknown>[] = [];
  readonly newRequests: ACPNewSessionRequest[] = [];
  readonly prompts: HeldPrompt[] = [];
  readonly resumeRequests: ACPResumeSessionRequest[] = [];
  /** Session ids `session/resume` can read; others fail as agy reports a missing session. */
  readonly knownSessions = new Set<string>(['session-existing']);
  readonly readyMCPServers = new Map<string, ACPMCPServer[]>();
  resumeGate: (request: ACPResumeSessionRequest) => Promise<void> | void = () => {};
  configOptions = antigravityConfigOptions();
  newSessionId = 'session-new';
  /** Published in `available_commands_update` right after agy answers session/new. */
  availableCommands: Array<{ description: string; name: string }> = [];
  /** Runs after agy applied a config change and before it answers; tests hold it to interleave. */
  configGate: (request: ACPSetSessionConfigOptionRequest) => Promise<void> | void = () => {};
  /** Settles held prompts the way agy does when cancel arrives; disable to model a stuck peer. */
  settlePromptsOnCancel = true;
  private readonly peer: NativeRPCPeer;
  private readonly promptWaiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(
    readonly agentName?: string,
    readonly agents = new Map<string, CapturedAntigravityAgent>(),
  ) {
    // Requests arrive as decoded JSON records; the casts bridge that wire shape to the SDK types.
    this.peer = createNativeRPCPeer(async (method, params) => {
      switch (method) {
        case 'initialize':
          this.initializeRequests.push(params as unknown as ACPInitializeRequest);
          return {
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { embeddedContext: true, image: true },
              sessionCapabilities: { close: {}, list: {}, resume: {} },
            },
            authMethods: [],
            protocolVersion: 1,
          };
        case 'session/new': {
          this.newRequests.push(params as unknown as ACPNewSessionRequest);
          const sessionId = this.newSessionId;
          this.knownSessions.add(sessionId);
          let captured: CapturedAntigravityAgent = { kind: 'default' };
          if (this.agentName) {
            let file: string | undefined;
            try {
              file = await readFile(path.join(String(params.cwd), '.agents/agents', this.agentName, 'agent.md'), 'utf8');
            } catch (error) {
              // Verified agy behavior: an absent selected file silently uses its default agent.
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            if (file !== undefined) {
              const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(file);
              if (!match) throw new Error('Malformed native agent');
              captured = { kind: 'custom', body: match[2], frontmatter: parse(match[1]) };
            }
          }
          this.agents.set(sessionId, captured);
          if (this.availableCommands.length > 0) {
            const update = { availableCommands: this.availableCommands, sessionUpdate: 'available_commands_update' };
            setImmediate(() => this.emit(update, sessionId));
          }
          return { configOptions: this.configOptions, sessionId };
        }
        case 'session/resume': {
          const request = params as unknown as ACPResumeSessionRequest;
          this.resumeRequests.push(request);
          if (!this.knownSessions.has(request.sessionId) && !this.agents.has(request.sessionId)) {
            throw new Error(`Failed to read session ${request.sessionId}; retry, or load it with session/load`);
          }
          await this.resumeGate(request);
          this.readyMCPServers.set(request.sessionId, request.mcpServers);
          if (this.availableCommands.length > 0) {
            this.emit({ availableCommands: this.availableCommands, sessionUpdate: 'available_commands_update' }, request.sessionId);
          }
          return { configOptions: this.configOptions };
        }
        case 'session/load':
          // agy opens an empty session under any id it cannot find.
          this.loadRequests.push(params);
          return { configOptions: this.configOptions, sessionId: params.sessionId };
        case 'session/close':
          this.closeRequests.push(String(params.sessionId));
          return {};
        case 'session/set_config_option': {
          const request = params as unknown as ACPSetSessionConfigOptionRequest;
          this.configRequests.push(request);
          const target = this.configOptions.find(option => option.id === request.configId);
          if (target?.type !== 'select' || !target.options.some(option => 'value' in option && option.value === request.value)) {
            throw new Error(`Unknown ${request.configId}: ${String(request.value)}`);
          }
          this.configOptions = this.configOptions.map(option => (
            option.id === request.configId && option.type === 'select'
              ? { ...option, currentValue: String(request.value) }
              : option
          ));
          this.emit({ configOptions: this.configOptions, sessionUpdate: 'config_option_update' }, request.sessionId);
          if (this.availableCommands.length > 0) {
            this.emit({ availableCommands: this.availableCommands, sessionUpdate: 'available_commands_update' }, request.sessionId);
          }
          await this.configGate(request);
          return { configOptions: this.configOptions };
        }
        case 'session/prompt':
          return new Promise<ACPPromptResponse>(resolve => {
            const request = params as unknown as ACPPromptRequest;
            const previous = this.prompts.at(-1);
            const held: HeldPrompt = {
              mcpServersAtReceipt: structuredClone(this.readyMCPServers.get(request.sessionId) ?? []),
              request,
              resolve: response => {
                if (held.settled) return;
                held.settled = true;
                resolve(response);
              },
              settled: false,
            };
            if (previous && !previous.settled) {
              // A prompt sent during a turn takes it over; agy answers the earlier one at once and
              // echoes the new text only when it injects it (tests emit that echo).
              previous.resolve({ stopReason: 'end_turn' });
            } else {
              // agy echoes a prompt that starts a turn; slash commands lose their command name.
              const text = request.prompt.filter(block => block.type === 'text').map(block => block.text).join('');
              const echo = text.replace(/^\/\S+/, '');
              if (!text.startsWith('/compact')) {
                this.emit({ content: { text: echo, type: 'text' }, sessionUpdate: 'user_message_chunk' }, request.sessionId);
              }
            }
            this.prompts.push(held);
            for (const waiter of this.promptWaiters.splice(0)) {
              if (this.prompts.length >= waiter.count) waiter.resolve();
              else this.promptWaiters.push(waiter);
            }
          });
        default:
          throw new Error('Unexpected native method: ' + method);
      }
    }, (method, params) => {
      if (method !== 'session/cancel') return;
      this.cancelRequests.push(String(params.sessionId));
      if (this.settlePromptsOnCancel) this.prompts.at(-1)?.resolve({ stopReason: 'cancelled' });
    });
    this.child = this.peer.child;
  }

  /** Native tools are frozen at creation, while MCP becomes available only after resume. */
  async readContextFile(sessionId: string, file: string): Promise<string> {
    const agent = this.agents.get(sessionId);
    if (agent?.kind !== 'custom' || !agent.frontmatter.tools.includes('read_file')) throw new Error('read_file unavailable');
    return readFile(file, 'utf8');
  }

  /** Exercise the actual MCP route supplied by the client after resume. */
  async callMCP(sessionId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const server = this.readyMCPServers.get(sessionId)?.find(server => server.name === 'claudian_sessions');
    if (!server) throw new Error('MCP unavailable before resume');
    return this.#requestMCP(server, 'tools/call', { name, arguments: args });
  }

  /** A resume gate can wait for real tool discovery before marking its servers ready. */
  async discoverMCPTools(servers: readonly ACPMCPServer[]): Promise<void> {
    await Promise.all(servers.map(server => this.#requestMCP(server, 'tools/list', {})));
  }

  async #requestMCP(server: ACPMCPServer, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!('url' in server)) throw new Error('The native fake only models HTTP MCP servers.');
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { ...Object.fromEntries((server.headers ?? []).map(header => [header.name, header.value])),
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return response.json();
  }

  /** Resolves once `count` prompts have arrived. */
  waitForPrompts(count: number): Promise<void> {
    if (this.prompts.length >= count) return Promise.resolve();
    return new Promise(resolve => { this.promptWaiters.push({ count, resolve }); });
  }

  finishPrompt(response: ACPPromptResponse = { stopReason: 'end_turn' }): void {
    this.prompts.at(-1)!.resolve(response);
  }

  emit(update: Record<string, unknown>, sessionId = 'session-existing'): void {
    this.child.stdout.push(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }) + '\n');
  }

  requestPermission(request: ACPRequestPermissionRequest): Promise<ACPRequestPermissionResponse> {
    return this.peer.request('session/request_permission', request) as Promise<ACPRequestPermissionResponse>;
  }

  createElicitation(request: ACPCreateElicitationRequest): Promise<ACPCreateElicitationResponse> {
    return this.peer.request('elicitation/create', request) as Promise<ACPCreateElicitationResponse>;
  }
}
