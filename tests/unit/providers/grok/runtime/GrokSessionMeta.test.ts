import {
  buildGrokSystemPrompt,
  computeGrokSystemPromptKey,
} from '@/providers/grok/prompt/GrokSystemPrompt';
import { buildGrokSessionMeta } from '@/providers/grok/runtime/GrokSessionMeta';

describe('Grok system prompt', () => {
  const promptSettings = {
    customPrompt: 'Keep my explicit instructions.',
    mediaFolder: 'attachments',
    userName: 'Ada',
    vaultPath: '/vault',
  };

  it('uses the provider-native profile without duplicating Claudian tool recipes', () => {
    const prompt = buildGrokSystemPrompt(promptSettings);

    expect(prompt).toContain('You are collaborating with **Ada**');
    expect(prompt).toContain('Vault absolute path: /vault');
    expect(prompt).toContain('Keep my explicit instructions.');
    expect(prompt).not.toContain('bash: date');
    expect(prompt).not.toContain('WebFetch does NOT support images');
    expect(prompt).not.toContain('curl -sfo');
  });

  it('uses the provider-native profile in the prompt key', () => {
    expect(computeGrokSystemPromptKey(promptSettings)).not.toBe(
      [
        promptSettings.mediaFolder,
        promptSettings.customPrompt,
        promptSettings.vaultPath,
        promptSettings.userName,
      ].join('::'),
    );
  });
});

describe('buildGrokSessionMeta', () => {
  const promptSettings = {
    customPrompt: 'Custom instruction',
    vaultPath: '/vault',
  };

  it('omits a model for the synthetic default and fails invalid permissions safe', () => {
    expect(buildGrokSessionMeta({
      model: 'grok',
      permissionMode: 'legacy-bypass',
      promptSettings,
    })).toEqual({
      systemPromptOverride: buildGrokSystemPrompt(promptSettings),
      yoloMode: false,
    });
  });

  it('decodes explicit models and enables YOLO only for the explicit yolo value', () => {
    expect(buildGrokSessionMeta({
      model: 'grok/kimi-coding',
      permissionMode: 'yolo',
      promptSettings,
    })).toEqual({
      modelId: 'kimi-coding',
      systemPromptOverride: buildGrokSystemPrompt(promptSettings),
      yoloMode: true,
    });
  });

  it('produces the same metadata for new and loaded session call sites', () => {
    const input = {
      model: 'grok/glm-coding',
      permissionMode: 'normal',
      promptSettings,
    };

    const newSessionMeta = buildGrokSessionMeta(input);
    const loadedSessionMeta = buildGrokSessionMeta(input);

    expect(loadedSessionMeta).toEqual(newSessionMeta);
    expect(newSessionMeta).not.toHaveProperty('rules');
    expect(newSessionMeta).not.toHaveProperty('agentProfile');
    expect(newSessionMeta).not.toHaveProperty('tools');
  });
});
