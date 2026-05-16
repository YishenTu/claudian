import { CURSOR_PROVIDER_CAPABILITIES } from '@/providers/cursor/capabilities';

describe('CURSOR_PROVIDER_CAPABILITIES', () => {
  it('should have cursor as providerId', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.providerId).toBe('cursor');
  });

  it('should not support persistent runtime in MVP', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.supportsPersistentRuntime).toBe(false);
  });

  it('should not support native history in MVP', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.supportsNativeHistory).toBe(false);
  });

  it('should not support plan mode in MVP', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.supportsPlanMode).toBe(false);
  });

  it('should not support rewind', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.supportsRewind).toBe(false);
  });

  it('should not support fork in MVP', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.supportsFork).toBe(false);
  });

  it('should not support provider commands', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.supportsProviderCommands).toBe(false);
  });

  it('should not support image attachments in MVP', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.supportsImageAttachments).toBe(false);
  });

  it('should not support instruction mode in MVP', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.supportsInstructionMode).toBe(false);
  });

  it('should not support MCP tools', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.supportsMcpTools).toBe(false);
  });

  it('should not support turn steer', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.supportsTurnSteer).toBe(false);
  });

  it('should use no reasoning control', () => {
    expect(CURSOR_PROVIDER_CAPABILITIES.reasoningControl).toBe('none');
  });

  it('should be frozen', () => {
    expect(Object.isFrozen(CURSOR_PROVIDER_CAPABILITIES)).toBe(true);
  });
});
