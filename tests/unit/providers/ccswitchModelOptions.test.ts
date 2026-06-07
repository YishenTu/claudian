import { getClaudeModelOptions, resolveClaudeModelSelection } from '@/providers/claude/modelOptions';
import { getCodexModelOptions, resolveCodexModelSelection } from '@/providers/codex/modelOptions';

describe('CC-Switch model options', () => {
  it('adds the active Claude CC-Switch model to the picker', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        claude: {
          followCCSwitch: true,
          ccSwitchSnapshot: {
            providerId: 'claude',
            model: 'claude-opus-4-8',
            configHash: 'hash-a',
          },
        },
      },
    };

    expect(getClaudeModelOptions(settings)[0]).toMatchObject({
      value: 'claude-opus-4-8',
      description: 'CC-Switch active model',
    });
    expect(resolveClaudeModelSelection(settings, '')).toBe('claude-opus-4-8');
  });

  it('adds the active Codex CC-Switch model to the picker', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: {
          enabled: true,
          followCCSwitch: true,
          ccSwitchSnapshot: {
            providerId: 'codex',
            model: 'gpt-5.5',
            modelProvider: 'openai-compatible',
            configHash: 'hash-b',
          },
        },
      },
    };

    expect(getCodexModelOptions(settings)[0]).toMatchObject({
      value: 'gpt-5.5',
      description: 'CC-Switch active model',
    });
    expect(resolveCodexModelSelection(settings, '')).toBe('gpt-5.5');
  });

  it('ignores CC-Switch model options when following is disabled', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        codex: {
          enabled: true,
          followCCSwitch: false,
          ccSwitchSnapshot: {
            providerId: 'codex',
            model: 'gpt-ccswitch-only',
          },
        },
      },
    };

    expect(getCodexModelOptions(settings).some(option => option.value === 'gpt-ccswitch-only')).toBe(false);
  });
});
