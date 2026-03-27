import { CODEX_PROVIDER_CAPABILITIES } from '@/providers/codex/capabilities';

describe('CODEX_PROVIDER_CAPABILITIES', () => {
  it('should have codex as providerId', () => {
    expect(CODEX_PROVIDER_CAPABILITIES.providerId).toBe('codex');
  });

  it('should support persistent runtime', () => {
    expect(CODEX_PROVIDER_CAPABILITIES.supportsPersistentRuntime).toBe(true);
  });

  it('should support native history', () => {
    expect(CODEX_PROVIDER_CAPABILITIES.supportsNativeHistory).toBe(true);
  });

  it('should not support plan mode', () => {
    expect(CODEX_PROVIDER_CAPABILITIES.supportsPlanMode).toBe(false);
  });

  it('should not support rewind', () => {
    expect(CODEX_PROVIDER_CAPABILITIES.supportsRewind).toBe(false);
  });

  it('should not support fork', () => {
    expect(CODEX_PROVIDER_CAPABILITIES.supportsFork).toBe(false);
  });

  it('should not support provider commands', () => {
    expect(CODEX_PROVIDER_CAPABILITIES.supportsProviderCommands).toBe(false);
  });

  it('should use effort-based reasoning control', () => {
    expect(CODEX_PROVIDER_CAPABILITIES.reasoningControl).toBe('effort');
  });

  it('should be frozen', () => {
    expect(Object.isFrozen(CODEX_PROVIDER_CAPABILITIES)).toBe(true);
  });
});
