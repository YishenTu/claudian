import { KIMI_PROVIDER_CAPABILITIES } from '@/providers/kimi/capabilities';

describe('KIMI_PROVIDER_CAPABILITIES', () => {
  it('declares conservative but real ACP capabilities', () => {
    expect(KIMI_PROVIDER_CAPABILITIES).toMatchObject({
      providerId: 'kimi',
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: true,
      supportsRewind: false,
      supportsFork: false,
      supportsProviderCommands: true,
      supportsImageAttachments: true,
      supportsInstructionMode: true,
      supportsMcpTools: false,
      supportsTurnSteer: false,
      reasoningControl: 'effort',
    });
  });
});
