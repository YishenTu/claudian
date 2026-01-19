/**
 * Agent SDK Configuration
 *
 * This file controls which SDK backend is used for AI interactions.
 * Change SDK_BACKEND to switch between Claude and iFlow.
 */

/**
 * Available SDK backends.
 */
export type SDKBackend = 'claude' | 'iflow';

/**
 * Current SDK backend configuration.
 *
 * Set to 'claude' to use Claude Agent SDK (original)
 * Set to 'iflow' to use iFlow SDK (ACP protocol)
 */
export const SDK_BACKEND: SDKBackend = 'iflow';

/**
 * Check if using Claude SDK.
 */
export function isClaudeBackend(): boolean {
  return SDK_BACKEND === 'claude';
}

/**
 * Check if using iFlow SDK.
 */
export function isIFlowBackend(): boolean {
  return SDK_BACKEND === 'iflow';
}
