import { OPENCODE_PROVIDER_CAPABILITIES } from '@/providers/opencode/capabilities';

describe('OPENCODE_PROVIDER_CAPABILITIES', () => {
  it('should have opencode as providerId', () => {
    expect(OPENCODE_PROVIDER_CAPABILITIES.providerId).toBe('opencode');
  });

  it('should support native history', () => {
    expect(OPENCODE_PROVIDER_CAPABILITIES.supportsNativeHistory).toBe(true);
  });

  it('should support plan mode', () => {
    expect(OPENCODE_PROVIDER_CAPABILITIES.supportsPlanMode).toBe(true);
  });

  it('should not support rewind', () => {
    expect(OPENCODE_PROVIDER_CAPABILITIES.supportsRewind).toBe(false);
  });

  it('should not support fork', () => {
    expect(OPENCODE_PROVIDER_CAPABILITIES.supportsFork).toBe(false);
  });

  it('should support provider commands', () => {
    expect(OPENCODE_PROVIDER_CAPABILITIES.supportsProviderCommands).toBe(true);
  });

  it('should let provider-owned deadlines bound command discovery', () => {
    expect(OPENCODE_PROVIDER_CAPABILITIES.commandDiscoveryDeadline).toBe('provider-owned');
  });

  it('should use effort-based reasoning control', () => {
    expect(OPENCODE_PROVIDER_CAPABILITIES.reasoningControl).toBe('effort');
  });

  it('should be frozen', () => {
    expect(Object.isFrozen(OPENCODE_PROVIDER_CAPABILITIES)).toBe(true);
  });
});
