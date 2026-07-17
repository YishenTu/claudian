import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolFunctionSpec,
  LegacyDynamicToolSpec,
} from './codexAppServerTypes';

export type CodexDynamicToolHandler = (
  params: DynamicToolCallParams,
) => Promise<DynamicToolCallResponse>;

export interface CodexDynamicToolRegistration {
  includeInThreadStart: boolean;
  namespace?: {
    name: string;
    description: string;
  };
  tool: DynamicToolFunctionSpec;
  handler: CodexDynamicToolHandler;
}

function registrationKey(namespace: string | null | undefined, tool: string): string {
  return `${namespace ?? ''}\u0000${tool}`;
}

export class CodexDynamicToolRegistry {
  private registrations = new Map<string, CodexDynamicToolRegistration>();

  register(registration: CodexDynamicToolRegistration): void {
    const key = registrationKey(registration.namespace?.name, registration.tool.name);
    if (this.registrations.has(key)) {
      throw new Error(`Duplicate dynamic tool registration: ${registration.tool.name}`);
    }
    this.registrations.set(key, registration);
  }

  getThreadStartSpecs(): LegacyDynamicToolSpec[] {
    const specs: LegacyDynamicToolSpec[] = [];
    const namespaceDescriptions = new Map<string, string>();

    for (const registration of this.registrations.values()) {
      if (!registration.includeInThreadStart) continue;

      if (registration.namespace) {
        const existingDescription = namespaceDescriptions.get(registration.namespace.name);
        if (
          existingDescription !== undefined
          && existingDescription !== registration.namespace.description
        ) {
          throw new Error(
            `Conflicting dynamic tool namespace description: ${registration.namespace.name}`,
          );
        }
        namespaceDescriptions.set(registration.namespace.name, registration.namespace.description);
      }

      const { name, description, inputSchema, deferLoading } = registration.tool;
      specs.push({
        ...(registration.namespace ? { namespace: registration.namespace.name } : {}),
        name,
        description,
        inputSchema,
        ...(deferLoading !== undefined ? { deferLoading } : {}),
      });
    }

    return specs;
  }

  isIncludedInThreadStart(namespace: string | null, tool: string): boolean {
    return this.registrations.get(registrationKey(namespace, tool))?.includeInThreadStart === true;
  }

  async execute(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const registration = this.registrations.get(registrationKey(params.namespace, params.tool));
    if (!registration) {
      const qualifiedName = params.namespace
        ? `${params.namespace}.${params.tool}`
        : params.tool;
      throw new Error(`Unsupported dynamic tool: ${qualifiedName}`);
    }

    return registration.handler(params);
  }
}
