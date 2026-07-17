import { GROK_PROVIDER_CAPABILITIES } from '@/providers/grok/capabilities';

describe('GROK_PROVIDER_CAPABILITIES', () => {
  it('uses conservative Grok Build capabilities', () => {
    expect(GROK_PROVIDER_CAPABILITIES).toEqual({
      providerId: 'grok',
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: true,
      supportsRewind: false,
      supportsFork: false,
      supportsProviderCommands: false,
      supportsImageAttachments: false,
      supportsInstructionMode: true,
      supportsMcpTools: false,
      supportsTurnSteer: false,
      reasoningControl: 'effort',
    });
    expect(Object.isFrozen(GROK_PROVIDER_CAPABILITIES)).toBe(true);
  });
});
