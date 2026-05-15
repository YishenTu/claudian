export type ComposerMode = 'compact' | 'expanded' | 'manual-collapsed';

export interface ComposerInputState {
  hasText: boolean;
  overflowsCompact: boolean;
}

export function getComposerModeAfterInput(
  mode: ComposerMode,
  input: ComposerInputState,
): ComposerMode {
  if (!input.hasText) {
    return 'compact';
  }

  if (mode === 'manual-collapsed' || mode === 'expanded') {
    return mode;
  }

  return input.overflowsCompact ? 'expanded' : 'compact';
}

export function getComposerModeAfterToggle(
  mode: ComposerMode,
  hasText: boolean,
): ComposerMode {
  if (mode === 'expanded') {
    return hasText ? 'manual-collapsed' : 'compact';
  }

  return 'expanded';
}

export function getComposerModeAfterReset(_mode: ComposerMode): ComposerMode {
  return 'compact';
}
