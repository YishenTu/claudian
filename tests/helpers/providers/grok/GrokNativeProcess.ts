import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { createNativeRPCProcess } from '@test/helpers/providers/NativeRPCTestProcess';

import type { ACPLoadSessionRequest, ACPNewSessionRequest, ACPNewSessionResponse, ACPPromptRequest,
  ACPSetSessionModelRequest, ACPSetSessionModeRequest } from '@/providers/acp';

/** Raw peer responses and notifications, recorded after the real ACP transport serializes them. */
export class GrokNativeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly loadRequests: ACPLoadSessionRequest[] = [];
  readonly modeRequests: ACPSetSessionModeRequest[] = [];
  readonly modelRequests: ACPSetSessionModelRequest[] = [];
  readonly newRequests: ACPNewSessionRequest[] = [];
  readonly promptRequests: ACPPromptRequest[] = [];
  readonly forkCalls: Record<string, unknown>[] = [];
  readonly rewindCalls: Record<string, unknown>[] = [];
  shutdownCalls = 0;
  readonly commandRequests: Record<string, unknown>[] = [];
  commandsImplementation: () => unknown | Promise<unknown> = () => { throw new Error('Unexpected command discovery'); };
  newImplementation = async (_request: ACPNewSessionRequest): Promise<ACPNewSessionResponse> => ({ sessionId: 'session-new' });
  loadImplementation = async (request: ACPLoadSessionRequest): Promise<unknown> => ({ sessionId: request.sessionId });
  modelImplementation = async (): Promise<unknown> => ({});
  promptImplementation = async (): Promise<Record<string, unknown>> => ({ stopReason: 'end_turn' });
  rewindImplementation = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => ({
    success: true, targetPromptIndex: params.targetPromptIndex, mode: params.mode,
    cleanFiles: ['note.md'], conflicts: [], error: null, revertedFiles: [],
  });

  constructor() {
    this.child = createNativeRPCProcess(async (method, params) => {
      switch (method) {
        case 'initialize': return {
          protocolVersion: 1, agentCapabilities: { loadSession: true,
            _meta: { 'x.ai/hooks': { blockingEvents: ['pre_tool_use'], decisions: ['deny'] } } },
        };
        case '_x.ai/commands/list':
          this.commandRequests.push(params);
          return this.commandsImplementation();
        case 'session/load':
          this.loadRequests.push(params as unknown as ACPLoadSessionRequest);
          return this.loadImplementation(params as unknown as ACPLoadSessionRequest);
        case 'session/new':
          this.newRequests.push(params as unknown as ACPNewSessionRequest);
          return this.newImplementation(params as unknown as ACPNewSessionRequest);
        case 'session/set_model':
          this.modelRequests.push(params as unknown as ACPSetSessionModelRequest);
          return this.modelImplementation();
        case 'session/set_mode':
          this.modeRequests.push(params as unknown as ACPSetSessionModeRequest);
          return {};
        case 'session/prompt':
          this.promptRequests.push(params as unknown as ACPPromptRequest);
          return this.promptImplementation();
        case '_x.ai/session/fork':
          this.forkCalls.push(params);
          return { newCwd: params.newCwd, newSessionId: 'session-forked', parentSessionId: params.sourceSessionId };
        case '_x.ai/rewind/execute':
          this.rewindCalls.push(params);
          return this.rewindImplementation(params);
        default: throw new Error('Unexpected native method: ' + method);
      }
    });
    this.child.on('exit', () => { this.shutdownCalls += 1; });
  }

  emit(
    update: Record<string, unknown>, source: 'extension' | 'standard' = 'standard',
    metadata?: Record<string, unknown>, sessionId = 'session-existing',
  ): void {
    this.child.stdout.push(JSON.stringify({ jsonrpc: '2.0',
      method: source === 'standard' ? 'session/update' : '_x.ai/session/update',
      params: { sessionId, update, ...(metadata ? { _meta: metadata } : {}) },
    }) + '\n');
  }
}
