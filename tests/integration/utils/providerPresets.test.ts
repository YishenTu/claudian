import { getModelsFromEnvironment, parseEnvironmentVariables } from '../../../src/utils/env';
import { PROVIDER_PRESETS } from '../../../src/utils/providerPresets';

describe('Provider presets integration with env utilities', () => {
  it.each(PROVIDER_PRESETS.map(p => [p.id, p]))('preset "%s" envVars are parseable', (_id, preset) => {
    const parsed = parseEnvironmentVariables(preset.envVars);
    expect(parsed).toHaveProperty('ANTHROPIC_BASE_URL');
    expect(parsed).toHaveProperty('ANTHROPIC_API_KEY');
    expect(parsed).toHaveProperty('ANTHROPIC_MODEL');
  });

  it.each(PROVIDER_PRESETS.map(p => [p.id, p]))('preset "%s" produces model entries', (_id, preset) => {
    const parsed = parseEnvironmentVariables(preset.envVars);
    const models = getModelsFromEnvironment(parsed);
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].value).toBe(parsed.ANTHROPIC_MODEL);
  });

  it('MiniMax preset parses correctly and produces M2.7 model', () => {
    const minimax = PROVIDER_PRESETS.find(p => p.id === 'minimax')!;
    const parsed = parseEnvironmentVariables(minimax.envVars);

    expect(parsed.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    expect(parsed.ANTHROPIC_MODEL).toBe('MiniMax-M2.7');

    const models = getModelsFromEnvironment(parsed);
    expect(models).toEqual([
      {
        value: 'MiniMax-M2.7',
        label: expect.any(String),
        description: expect.stringContaining('model'),
      },
    ]);
  });

  it('preset context limits use valid token counts', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (!preset.contextLimits) continue;
      for (const [model, limit] of Object.entries(preset.contextLimits)) {
        expect(model).toBeTruthy();
        expect(limit).toBeGreaterThan(0);
        expect(limit).toBeLessThanOrEqual(10_000_000);
      }
    }
  });
});
