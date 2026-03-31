import type { ProviderPreset } from '../../../src/utils/providerPresets';
import { getProviderPreset, PROVIDER_PRESETS } from '../../../src/utils/providerPresets';

describe('PROVIDER_PRESETS', () => {
  it('contains at least one preset', () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThan(0);
  });

  it('has unique IDs', () => {
    const ids = PROVIDER_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique names', () => {
    const names = PROVIDER_PRESETS.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(PROVIDER_PRESETS.map(p => [p.id, p]))('preset "%s" has required fields', (_id, preset) => {
    const p = preset as ProviderPreset;
    expect(p.id).toBeTruthy();
    expect(p.name).toBeTruthy();
    expect(p.description).toBeTruthy();
    expect(p.envVars).toBeTruthy();
    expect(p.docsUrl).toBeTruthy();
  });

  it.each(PROVIDER_PRESETS.map(p => [p.id, p]))('preset "%s" envVars contains ANTHROPIC_BASE_URL', (_id, preset) => {
    const p = preset as ProviderPreset;
    expect(p.envVars).toContain('ANTHROPIC_BASE_URL=');
  });

  it.each(PROVIDER_PRESETS.map(p => [p.id, p]))('preset "%s" envVars contains ANTHROPIC_API_KEY', (_id, preset) => {
    const p = preset as ProviderPreset;
    expect(p.envVars).toContain('ANTHROPIC_API_KEY=');
  });

  it.each(PROVIDER_PRESETS.map(p => [p.id, p]))('preset "%s" envVars contains ANTHROPIC_MODEL', (_id, preset) => {
    const p = preset as ProviderPreset;
    expect(p.envVars).toContain('ANTHROPIC_MODEL=');
  });

  it.each(PROVIDER_PRESETS.map(p => [p.id, p]))('preset "%s" docsUrl is a valid URL', (_id, preset) => {
    const p = preset as ProviderPreset;
    expect(() => new URL(p.docsUrl)).not.toThrow();
  });
});

describe('MiniMax preset', () => {
  const minimax = PROVIDER_PRESETS.find(p => p.id === 'minimax');

  it('exists', () => {
    expect(minimax).toBeDefined();
  });

  it('uses Anthropic-compatible API endpoint', () => {
    expect(minimax!.envVars).toContain('ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic');
  });

  it('sets MiniMax-M2.7 as default model', () => {
    expect(minimax!.envVars).toContain('ANTHROPIC_MODEL=MiniMax-M2.7');
  });

  it('sets 204K context limit', () => {
    expect(minimax!.contextLimits).toEqual({ 'MiniMax-M2.7': 204_000 });
  });
});

describe('getProviderPreset', () => {
  it('returns preset by ID', () => {
    const preset = getProviderPreset('minimax');
    expect(preset).toBeDefined();
    expect(preset!.name).toBe('MiniMax');
  });

  it('returns undefined for unknown ID', () => {
    expect(getProviderPreset('nonexistent')).toBeUndefined();
  });

  it('finds each preset by its ID', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(getProviderPreset(preset.id)).toBe(preset);
    }
  });
});
