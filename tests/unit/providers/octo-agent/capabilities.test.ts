import { OCTO_AGENT_PROVIDER_CAPABILITIES } from '@/providers/octo-agent/capabilities';

describe('OCTO_AGENT_PROVIDER_CAPABILITIES', () => {
  it('exposes the octo-agent capability contract', () => {
    expect(OCTO_AGENT_PROVIDER_CAPABILITIES).toMatchObject({
      providerId: 'octo-agent',
      reasoningControl: 'effort',
      supportsFork: true,
      supportsImageAttachments: false,
      supportsInstructionMode: true,
      supportsMcpTools: false,
      supportsPersistentRuntime: true,
      supportsPlanMode: false,
      supportsProviderCommands: false,
      supportsRewind: false,
      supportsTurnSteer: false,
    });
  });
});
