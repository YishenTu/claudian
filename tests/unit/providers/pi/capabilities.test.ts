import { PI_PROVIDER_CAPABILITIES } from '@/providers/pi/capabilities';

describe('PI_PROVIDER_CAPABILITIES', () => {
  it('exposes the Phase 1-3 Pi capability contract', () => {
    expect(PI_PROVIDER_CAPABILITIES).toMatchObject({
      providerId: 'pi',
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: false,
      supportsRewind: false,
      supportsFork: false,
      supportsProviderCommands: true,
      supportsImageAttachments: true,
      supportsInstructionMode: true,
      supportsMcpTools: false,
      supportsTurnSteer: true,
      reasoningControl: 'effort',
    });
  });
});
