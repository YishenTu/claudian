import { buildSystemPrompt, computeSystemPromptKey } from '@/core/prompt/mainAgent';
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

  it('uses the complete shared Claudian system prompt', () => {
    const prompt = buildGrokSystemPrompt(promptSettings);

    expect(prompt).toBe(buildSystemPrompt(promptSettings));
    expect(prompt).toContain("inside **Ada**'s Obsidian Vault");
    expect(prompt).toContain('Vault absolute path: /vault');
    expect(prompt).toContain('Keep my explicit instructions.');
    expect(prompt).toContain('bash: date');
    expect(prompt).toContain('## Vault Media');
  });

  it('uses the shared Claudian prompt key', () => {
    expect(computeGrokSystemPromptKey(promptSettings)).toBe(
      computeSystemPromptKey(promptSettings),
    );
  });
});

describe('buildGrokSessionMeta', () => {
  const promptSettings = {
    customPrompt: 'Custom instruction',
    vaultPath: '/vault',
  };

  it('omits an invalid unqualified model and fails invalid permissions safe', () => {
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
