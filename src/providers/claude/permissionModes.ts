import type { PermissionMode as SDKPermissionMode } from '@anthropic-ai/claude-agent-sdk';

import {
  buildPermissionModeOptions,
  type ProviderPermissionModeDefinition,
} from '../../core/providers/permissionModes';
import type { ProviderPermissionModeOption } from '../../core/providers/types';

/** Stored values in menu order. */
export const CLAUDE_PERMISSION_MODE_DEFINITIONS = Object.freeze([
  { value: 'auto', label: 'Auto', description: { key: 'chat.permissionMode.claude.autoDesc' } },
  { value: 'manual', label: 'Manual', description: { key: 'chat.permissionMode.claude.manualDesc' } },
  {
    value: 'acceptEdits',
    label: 'Accept edits',
    description: { key: 'chat.permissionMode.claude.acceptEditsDesc' },
  },
  {
    value: 'yolo',
    label: 'YOLO',
    description: { key: 'chat.permissionMode.claude.yoloDesc' },
    bypassesApprovals: true,
  },
] as const satisfies readonly ProviderPermissionModeDefinition[]);
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODE_DEFINITIONS[number]['value'];
const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = CLAUDE_PERMISSION_MODE_DEFINITIONS
  .map(definition => definition.value);

/**
 * The policy's fail-closed mode for unknown stored values; runtime code uses it when no valid mode
 * is selected. The policy itself lives in the model policy because its migration reads settings.
 */
export const CLAUDE_FALLBACK_PERMISSION_MODE: ClaudePermissionMode = 'manual';

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

export function getClaudePermissionModeOptions(): ProviderPermissionModeOption[] {
  return buildPermissionModeOptions(CLAUDE_PERMISSION_MODE_DEFINITIONS);
}
