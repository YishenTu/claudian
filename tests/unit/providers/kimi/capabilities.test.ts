import { KIMI_PROVIDER_CAPABILITIES } from '@/providers/kimi/capabilities';

describe('KIMI_PROVIDER_CAPABILITIES', () => {
  it('exposes the locked Kimi v1 capability contract', () => {
    expect(KIMI_PROVIDER_CAPABILITIES).toEqual({
      providerId: 'kimi',
      reasoningControl: 'none',
      supportsFork: false,
      supportsImageAttachments: true,
      supportsInstructionMode: false,
      supportsMcpTools: true,
      supportsNativeHistory: true,
      supportsPersistentRuntime: true,
      supportsPlanMode: false,
      supportsProviderCommands: true,
      supportsRewind: false,
      supportsTurnSteer: false,
    });
  });
});
