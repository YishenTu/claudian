import { KIMI_PROVIDER_CAPABILITIES } from '@/providers/kimi/capabilities';

describe('KIMI_PROVIDER_CAPABILITIES', () => {
  it('exposes the locked Kimi v1 capability contract', () => {
    expect(KIMI_PROVIDER_CAPABILITIES).toEqual({
      providerId: 'kimi',
      reasoningControl: 'effort',
      supportsFork: false,
      supportsImageAttachments: true,
      supportsInstructionMode: true,
      supportsMcpTools: true,
      supportsNativeHistory: true,
      supportsPersistentRuntime: true,
      supportsPlanMode: true,
      supportsProviderCommands: true,
      supportsRewind: false,
      supportsTurnSteer: false,
    });
  });
});
