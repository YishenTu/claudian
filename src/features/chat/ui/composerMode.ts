export type ComposerMode = 'compact' | 'expanded';

export function getComposerModeAfterToggle(mode: ComposerMode): ComposerMode {
  return mode === 'expanded' ? 'compact' : 'expanded';
}

export function getComposerModeAfterReset(_mode: ComposerMode): ComposerMode {
  return 'compact';
}
