import { QODER_PROVIDER_CAPABILITIES } from '@/providers/qoder/capabilities';

describe('QODER_PROVIDER_CAPABILITIES', () => {
  it('exposes the locked Qoder capability contract', () => {
    expect(QODER_PROVIDER_CAPABILITIES).toEqual({
      providerId: 'qoder',
      reasoningControl: 'effort',
      supportsFork: true,
      supportsImageAttachments: true,
      supportsInstructionMode: true,
      supportsMcpTools: true,
      supportsNativeHistory: true,
      supportsPersistentRuntime: false,
      supportsPlanMode: true,
      supportsProviderCommands: true,
      supportsRewind: true,
      supportsTurnSteer: true,
    });
  });
});
