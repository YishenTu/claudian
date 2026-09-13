import {
  AGENT_RUNTIME_RPC_ID_MAX_LENGTH,
  type AgentRuntimeOperationDescriptor,
  type AgentRuntimeValueSchema,
} from './AgentRuntimeRpc';

/** Covers compact JSON for every advertised operation, plus framing whitespace. */
export function agentRuntimeRequestBudget(operations: readonly AgentRuntimeOperationDescriptor[]): number {
  return Math.max(64 * 1024, ...operations.map(operation => (
    Buffer.byteLength(JSON.stringify({ id: '', method: operation.name, params: {} }), 'utf8')
    + AGENT_RUNTIME_RPC_ID_MAX_LENGTH * 6
    + encodedValueBudget({ type: 'object', additionalProperties: false, properties: operation.parameters }) - 2
    + 1024
  )));
}

function encodedValueBudget(schema: AgentRuntimeValueSchema): number {
  if (schema.type === 'integer') return 20;
  if (schema.type === 'string') {
    if (schema.enum) return Math.max(2, ...schema.enum.map(value => Buffer.byteLength(JSON.stringify(value), 'utf8')));
    const bound = Math.min(schema.maxLength ?? Infinity, schema.maxBytes ?? Infinity);
    if (!Number.isSafeInteger(bound) || bound < 0) throw new Error('Agent Runtime strings require a finite bound.');
    // An ASCII control byte can require six JSON bytes (a Unicode escape).
    return 2 + bound * 6;
  }
  if (schema.type === 'array') {
    const count = schema.maxItems;
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Agent Runtime arrays require a finite bound.');
    }
    return 2 + count * encodedValueBudget(schema.items) + Math.max(0, count - 1);
  }
  return 2 + schema.properties.reduce((bytes, property) => (
    bytes + Buffer.byteLength(JSON.stringify(property.name), 'utf8') + 1 + encodedValueBudget(property.schema)
  ), 0) + Math.max(0, schema.properties.length - 1);
}
