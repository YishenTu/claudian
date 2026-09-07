import {
  AgentRuntimeMethodRegistry,
  type AgentRuntimePreparedInvocation,
  type CollabAgentPort,
  type ResolveCollabAgentPort,
} from './AgentRuntimeMethodRegistry';
import {
  type AgentRuntimeRpcErrorResponse,
  type AgentRuntimeRpcResponse,
  decodeAgentRuntimeRpcEnvelope,
} from './AgentRuntimeRpc';

export type { CollabAgentPort, ResolveCollabAgentPort };

export type AgentRuntimeGatewayPrepareResult =
  | {
    readonly status: 'response';
    readonly response: AgentRuntimeRpcResponse;
  }
  | {
    readonly status: 'invocation';
    readonly invocation: AgentRuntimePreparedInvocation;
  };

export class AgentRuntimeGateway {
  private readonly registry: AgentRuntimeMethodRegistry;

  constructor(resolveCollab: ResolveCollabAgentPort) {
    this.registry = new AgentRuntimeMethodRegistry(resolveCollab);
  }

  prepare(input: unknown): AgentRuntimeGatewayPrepareResult {
    const decoded = decodeAgentRuntimeRpcEnvelope(input);
    if (decoded.status === 'invalid-request') {
      return {
        response: rpcError(null, 'invalid_request', 'Invalid RPC request.'),
        status: 'response',
      };
    }

    const prepared = this.registry.prepare(decoded.envelope);
    switch (prepared.status) {
      case 'method-not-found':
        return {
          response: rpcError(
            decoded.envelope.id,
            'method_not_found',
            'Unknown RPC method.',
          ),
          status: 'response',
        };
      case 'invalid-params':
        return {
          response: rpcError(
            decoded.envelope.id,
            'invalid_params',
            'Invalid RPC params.',
          ),
          status: 'response',
        };
      case 'success':
        return { invocation: prepared.invocation, status: 'invocation' };
    }
  }

  async handle(input: unknown, signal?: AbortSignal): Promise<AgentRuntimeRpcResponse> {
    const prepared = this.prepare(input);
    if (prepared.status === 'response') return prepared.response;
    const effectiveSignal = signal ?? new AbortController().signal;
    return prepared.invocation.execute(effectiveSignal);
  }
}

function rpcError(
  id: string | null,
  code: AgentRuntimeRpcErrorResponse['error']['code'],
  message: string,
): AgentRuntimeRpcErrorResponse {
  return { error: { code, message }, id };
}
