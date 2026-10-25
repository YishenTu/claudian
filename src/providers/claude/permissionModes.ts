import type { PermissionMode as SDKPermissionMode } from '@anthropic-ai/claude-agent-sdk';

export const CLAUDE_PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'yolo'] as const;
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number];

const SDK_PERMISSION_MODES: Record<ClaudePermissionMode, SDKPermissionMode> = {
  auto: 'auto',
  manual: 'default',
  acceptEdits: 'acceptEdits',
  yolo: 'bypassPermissions',
};

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return (CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(value);
}

export function toClaudeSDKPermissionMode(mode: ClaudePermissionMode): SDKPermissionMode {
  return SDK_PERMISSION_MODES[mode];
}

/** Native modes outside the four offered (plan, dontAsk, ...) have no toolbar value. */
export function fromClaudeSDKPermissionMode(mode: unknown): ClaudePermissionMode | null {
  return CLAUDE_PERMISSION_MODES.find(value => SDK_PERMISSION_MODES[value] === mode) ?? null;
}
