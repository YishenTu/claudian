import { GROK_PROVIDER_CAPABILITIES } from '@/providers/grok/capabilities';

describe('GROK_PROVIDER_CAPABILITIES', () => {
  it('exposes the locked Grok v1 capability contract', () => {
    expect(GROK_PROVIDER_CAPABILITIES).toEqual({
      providerId: 'grok',
      reasoningControl: 'effort',
      supportsFork: true,
      supportsImageAttachments: true,
      supportsInstructionMode: true,
      supportsMcpTools: false,
      supportsNativeHistory: true,
      supportsPersistentRuntime: true,
      supportsPlanMode: true,
      supportsProviderCommands: true,
      supportsRewind: true,
      supportsTurnSteer: true,
    });
  });
});
