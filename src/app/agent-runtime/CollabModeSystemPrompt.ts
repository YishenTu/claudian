import type { LocalAgentRuntimeHTTPServerEndpoint } from './LocalAgentRuntimeHTTPServer';

export function buildCollabModeSystemPrompt(
  endpoint: LocalAgentRuntimeHTTPServerEndpoint,
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
    'Send HTTP POST requests with Content-Type application/json. runtime.operations.list reports the maximum UTF-8 bytes of the entire JSON request; parameter schemas separately bound decoded values.',
    'The envelope id only correlates a request and response. Follow the operation retry contract returned by runtime.operations.get.',
    'For operations requiring mutationId, generate a globally unique ID (for example a UUID) for each new intent. After a timeout or lost response, reuse that mutationId and all original parameters, including revision expectations; do not assume the write failed.',
    'Publish and Update act on current state and use their existing durable workflow. After an unknown outcome, inspect the Project and My changes before deciding whether to invoke them again.',
    'Catalog request: {"id":"operations-1","method":"runtime.operations.list","params":{}}',
    'Contract request: {"id":"contract-1","method":"runtime.operations.get","params":{"name":"<operation-name>"}}',
    'Treat runtime results as current structured context. Do not invent unavailable state.',
    'Use the Project-listing operation reported by runtime.operations.list to discover Project IDs and selectedProjectId.',
    'Use a non-null selectedProjectId as the default Project for an unqualified reference, then pass it explicitly to every downstream Project-scoped operation.',
    'Resolve Member references through the open Request list and Ticket references through the Ticket list before reading their detail.',
    'If selectedProjectId is null, a display name is duplicated or missing, a Member has no open Request, or a Ticket is missing, ask for clarification or report the missing context; never guess.',
    'Use collab.projects.get to inspect Update availability. Unknown or offline state does not prove that an update is available. When incoming is included and nextAction is null, team content is already present; no explicit Update is needed. Preserve local work and let the next normal publication integrate the accepted history. Follow nextAction: publish-pending requires completing the existing publication before Update. Offline state may retain a local Update conflict or recovery task, but continuation requires reconnection.',
    'Use collab.projects.update to receive accepted updates locally while preserving personal work; it does not publish that work or change a Request.',
    'Conflict reads expose immutable evidence and identify whether the conflict belongs to Update, My changes, or a Request.',
    'Edit the real Project files with normal file tools. Continue an Update conflict with collab.projects.update; continue a Publish conflict with collab.changes.publish.',
    'Do not edit a Request snapshot or run Git directly to resolve a conflict.',
    'The runtime owns LAN or Cloud routing after a Project ID is supplied.',
    'Calling an operation whose access is write mutates Collab state immediately and does not navigate the Obsidian UI.',
    'If the active tool or sandbox policy cannot reach loopback HTTP, state that limitation.',
  ].join('\n');
}
