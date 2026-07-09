import { octoAgentChatUIConfig } from '@/providers/octo-agent/ui/OctoAgentChatUIConfig';

describe('octoAgentChatUIConfig', () => {
  it('exposes a single octo-agent model option', () => {
    const options = octoAgentChatUIConfig.getModelOptions({});

    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('octo-agent/kimi-for-coding');
  });

  it('owns octo-agent model selection ids', () => {
    expect(octoAgentChatUIConfig.ownsModel('octo-agent', {})).toBe(true);
    expect(octoAgentChatUIConfig.ownsModel('octo-agent/octo-agent', {})).toBe(true);
    expect(octoAgentChatUIConfig.ownsModel('octo-agent/claude-sonnet-4-5', {})).toBe(true);
    expect(octoAgentChatUIConfig.ownsModel('claude-code/claude-sonnet-4-5', {})).toBe(false);
  });

  it('identifies the octo-agent default model', () => {
    expect(octoAgentChatUIConfig.isDefaultModel('octo-agent/kimi-for-coding')).toBe(true);
    expect(octoAgentChatUIConfig.isDefaultModel('octo-agent')).toBe(true);
    expect(octoAgentChatUIConfig.isDefaultModel('claude-code/claude-sonnet-4-5')).toBe(false);
  });

  it('normalizes unknown models to the octo-agent default', () => {
    expect(octoAgentChatUIConfig.normalizeModelVariant('octo-agent/kimi-for-coding', {})).toBe(
      'octo-agent/kimi-for-coding',
    );
    expect(octoAgentChatUIConfig.normalizeModelVariant('unknown', {})).toBe('octo-agent/kimi-for-coding');
  });
});
