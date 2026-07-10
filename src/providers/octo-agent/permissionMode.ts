/**
 * Claudian uses a generic permission-mode vocabulary for the toggle UI:
 *   yolo  -> tools run automatically
 *   normal-> ask before executing tools
 *   plan  -> plan mode
 *
 * octo-agent stores them as auto / interactive / plan. These helpers convert
 * between the two value domains so the runtime talks to the server correctly
 * while the UI and persisted settings remain provider-agnostic.
 */

export type OctoAgentPermissionMode = 'auto' | 'interactive' | 'plan';
export type ClaudianPermissionMode = 'yolo' | 'normal' | 'plan';

export function toOctoAgentPermissionMode(
  mode: string | undefined,
): OctoAgentPermissionMode {
  switch (mode) {
    case 'yolo':
    case 'auto':
      return 'auto';
    case 'normal':
    case 'interactive':
      return 'interactive';
    case 'plan':
      return 'plan';
    default:
      return 'auto';
  }
}

export function toClaudianPermissionMode(
  mode: string | undefined,
): ClaudianPermissionMode {
  switch (mode) {
    case 'auto':
    case 'yolo':
      return 'yolo';
    case 'interactive':
    case 'normal':
      return 'normal';
    case 'plan':
      return 'plan';
    default:
      return 'yolo';
  }
}

export function isValidClaudianPermissionMode(mode: string): mode is ClaudianPermissionMode {
  return mode === 'yolo' || mode === 'normal' || mode === 'plan';
}
