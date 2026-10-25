import type { ProviderToolPolicy } from '@/core/execution';

import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolFunctionSpec,
  LegacyDynamicToolSpec,
} from './codexAppServerTypes';
import { invokeCodexSessionTool, isCodexSessionTool } from './CodexSessionTools';

export interface CodexDynamicToolContext {
  readonly signal: AbortSignal;
  readonly toolPolicy: ProviderToolPolicy;
}

export type CodexDynamicToolHandler = (
  params: DynamicToolCallParams,
  context: CodexDynamicToolContext,
) => Promise<DynamicToolCallResponse>;

export interface CodexDynamicToolRegistration {
  includeInThreadStart: boolean;
  namespace?: string;
  tool: DynamicToolFunctionSpec;
  handler: CodexDynamicToolHandler;
}

function registrationKey(namespace: string | null | undefined, tool: string): string {
  return `${namespace ?? ''}\u0000${tool}`;
}

export class CodexDynamicToolRegistry {
  private registrations = new Map<string, CodexDynamicToolRegistration>();

  register(registration: CodexDynamicToolRegistration): void {
    this.registrations.set(
      registrationKey(registration.namespace, registration.tool.name),
      registration,
    );
  }

  getThreadStartSpecs(): LegacyDynamicToolSpec[] {
    const specs: LegacyDynamicToolSpec[] = [];

    for (const registration of this.registrations.values()) {
      if (!registration.includeInThreadStart) continue;

      const { name, description, inputSchema, deferLoading } = registration.tool;
      specs.push({
        ...(registration.namespace ? { namespace: registration.namespace } : {}),
        name,
        description,
        inputSchema,
        ...(deferLoading !== undefined ? { deferLoading } : {}),
      });
    }

    return specs;
  }

  async execute(params: DynamicToolCallParams, context: CodexDynamicToolContext): Promise<DynamicToolCallResponse> {
    const registration = this.registrations.get(registrationKey(params.namespace, params.tool));
    if (!registration) {
      if (isCodexSessionTool(params.namespace, params.tool)) {
        return invokeCodexSessionTool(params, { ...context, port: undefined });
      }
      const qualifiedName = params.namespace
        ? `${params.namespace}.${params.tool}`
        : params.tool;
      throw new Error(`Unsupported dynamic tool: ${qualifiedName}`);
    }

    return registration.handler(params, context);
  }
}
