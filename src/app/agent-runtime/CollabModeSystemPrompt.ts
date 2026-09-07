import type { LocalAgentRuntimeHttpServerEndpoint } from './LocalAgentRuntimeHttpServer';

export function buildCollabModeSystemPrompt(
  endpoint: LocalAgentRuntimeHttpServerEndpoint,
): string {
  return [
    '## Collab Mode',
    '',
    'Claudian exposes a Vault-scoped local Agent Runtime for Collab context and operations.',
    `RPC endpoint: ${endpoint.rpcUrl}`,
    'When a request may depend on Collab Projects, changes, requests, Tickets, comments, conflicts, roles, or membership, query the runtime instead of guessing.',
    "A plain-text reference @<exact display name>'s Changes means that active Member's current open Change Request in the selected Project.",
    'A plain-text reference #<number> means that Ticket number in the selected Project.',
    'Start with runtime.operations.list and use only operations returned by it.',
    'Before calling an operation, query its exact parameter contract with runtime.operations.get.',
    'Send HTTP POST requests with Content-Type application/json.',
    'Catalog request: {"id":"operations-1","method":"runtime.operations.list","params":{}}',
    'Contract request: {"id":"contract-1","method":"runtime.operations.get","params":{"name":"<operation-name>"}}',
    'Treat runtime results as current structured context. Do not invent unavailable state.',
    'Use the Project-listing operation reported by runtime.operations.list to discover Project IDs and selectedProjectId.',
    'Use a non-null selectedProjectId as the default Project for an unqualified reference, then pass it explicitly to every downstream Project-scoped operation.',
    'Resolve Member references through the open Request list and Ticket references through the Ticket list before reading their detail.',
    'If selectedProjectId is null, a display name is duplicated or missing, a Member has no open Request, or a Ticket is missing, ask for clarification or report the missing context; never guess.',
    'Conflict reads expose immutable conflict evidence from both unpublished My changes and an existing Request.',
    'To resolve your own conflict, edit the real Project files with normal file tools, then call collab.changes.publish.',
    'Do not edit a Request snapshot or run Git directly to resolve a conflict.',
    'The runtime owns LAN or Cloud routing after a Project ID is supplied.',
    'Calling an operation whose access is write mutates Collab state immediately and does not navigate the Obsidian UI.',
    'If the active tool or sandbox policy cannot reach loopback HTTP, state that limitation.',
  ].join('\n');
}
