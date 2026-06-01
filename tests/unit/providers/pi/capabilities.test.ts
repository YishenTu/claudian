import { PI_PROVIDER_CAPABILITIES } from '@/providers/pi/capabilities';

describe('PI_PROVIDER_CAPABILITIES', () => {
  it('exposes the Pi capability contract', () => {
    expect(PI_PROVIDER_CAPABILITIES).toMatchObject({
      providerId: 'pi',
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: false,
      supportsRewind: false,
      supportsFork: true,
      supportsProviderCommands: true,
      supportsImageAttachments: true,
      supportsInstructionMode: true,
      supportsMcpTools: false,
      supportsTurnSteer: true,
      reasoningControl: 'effort',
    });
  });
});
