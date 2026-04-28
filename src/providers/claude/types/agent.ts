export const AGENT_PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan', 'delegate'] as const;
export type AgentPermissionMode = typeof AGENT_PERMISSION_MODES[number];
