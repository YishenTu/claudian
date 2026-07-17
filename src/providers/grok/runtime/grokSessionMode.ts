/**
 * Map Claudian permission modes onto Grok Build ACP session modes.
 *
 * Verified against Grok Build 0.2.102:
 * - `session/set_mode` accepts `modeId: "plan"` and `modeId: "default"`.
 * YOLO remains a process launch flag (`--always-approve`), not an ACP mode.
 */
export type GrokAcpModeId = 'plan' | 'default';

export function resolveGrokAcpModeId(
  permissionMode: string | null | undefined,
): GrokAcpModeId {
  return permissionMode === 'plan' ? 'plan' : 'default';
}
