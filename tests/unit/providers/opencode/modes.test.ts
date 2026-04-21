import {
  getEffectiveOpencodeModes,
  getManagedOpencodeModes,
  getOpencodeToolbarModes,
  normalizeManagedOpencodeSelectedMode,
  normalizeOpencodeAvailableModes,
  normalizeOpencodeSelectedMode,
  OPENCODE_FALLBACK_MODES,
} from '../../../../src/providers/opencode/modes';
import { opencodeChatUIConfig } from '../../../../src/providers/opencode/ui/OpencodeChatUIConfig';

describe('OpenCode mode settings', () => {
  it('normalizes duplicate/invalid mode entries', () => {
    expect(normalizeOpencodeAvailableModes([
      { id: 'build', name: 'Build' },
      { id: 'build', name: 'Duplicate build' },
      { id: 'plan', name: 'Plan', description: 'Planning-first agent' },
      null,
    ])).toEqual([
      { id: 'build', name: 'Build' },
      { description: 'Planning-first agent', id: 'plan', name: 'Plan' },
    ]);
  });

  it('preserves a saved mode string until fresh discovery decides whether it is valid', () => {
    expect(normalizeOpencodeSelectedMode('plan')).toBe('plan');
  });

  it('falls back to the built-in primary modes before ACP discovery finishes', () => {
    expect(getEffectiveOpencodeModes([])).toEqual(OPENCODE_FALLBACK_MODES);
  });

  it('filters auxiliary OpenCode primary modes out of the toolbar selector', () => {
    expect(getOpencodeToolbarModes([
      { id: 'build', name: 'build' },
      { id: 'compaction', name: 'compaction' },
      { id: 'plan', name: 'plan' },
      { id: 'summary', name: 'summary' },
      { id: 'title', name: 'title' },
    ])).toEqual([
      { id: 'build', name: 'build' },
        { id: 'plan', name: 'plan' },
    ]);
  });

  it('keeps Claudian on managed build/plan modes even when discovery only reports custom agents', () => {
    expect(getManagedOpencodeModes([
      { id: 'compaction', name: 'compaction' },
      { id: 'summary', name: 'summary' },
    ])).toEqual(OPENCODE_FALLBACK_MODES);
  });

  it('normalizes saved custom mode selections back to build', () => {
    expect(normalizeManagedOpencodeSelectedMode('compaction')).toBe('build');
  });
});

describe('opencodeChatUIConfig.getModeSelector', () => {
  it('returns a shared toolbar config for discovered OpenCode modes', () => {
    expect(opencodeChatUIConfig.getModeSelector?.({
      providerConfigs: {
        opencode: {
          availableModes: [
            { id: 'build', name: 'Build', description: 'Default editing agent' },
            { id: 'plan', name: 'Plan', description: 'Planning-first agent' },
          ],
          selectedMode: 'plan',
        },
      },
    })).toEqual({
      activeValue: 'build',
      label: 'Mode',
      options: [
        { description: 'Default editing agent', label: 'Build', value: 'build' },
        { description: 'Planning-first agent', label: 'Plan', value: 'plan' },
      ],
      value: 'plan',
    });
  });

  it('fills in the managed plan mode when OpenCode discovery only reports build', () => {
    expect(opencodeChatUIConfig.getModeSelector?.({
      providerConfigs: {
        opencode: {
          availableModes: [
            { id: 'build', name: 'Build' },
          ],
          selectedMode: 'build',
        },
      },
    })).toEqual({
      activeValue: 'build',
      label: 'Mode',
      options: [
        { label: 'Build', value: 'build' },
        {
          description: 'Plan mode. Disallows all edit tools.',
          label: 'Plan',
          value: 'plan',
        },
      ],
      value: 'build',
    });
  });

  it('shows fallback build/plan modes before ACP discovery finishes', () => {
    expect(opencodeChatUIConfig.getModeSelector?.({
      providerConfigs: {
        opencode: {
          availableModes: [],
          selectedMode: '',
        },
      },
    })).toEqual({
      activeValue: 'build',
      label: 'Mode',
      options: [
        {
          description: 'The default agent. Executes tools based on configured permissions.',
          label: 'Build',
          value: 'build',
        },
        {
          description: 'Plan mode. Disallows all edit tools.',
          label: 'Plan',
          value: 'plan',
        },
      ],
      value: 'build',
    });
  });

  it('falls back to build/plan when a saved custom mode cannot be managed safely', () => {
    expect(opencodeChatUIConfig.getModeSelector?.({
      providerConfigs: {
        opencode: {
          availableModes: [],
          selectedMode: 'compaction',
        },
      },
    })).toEqual({
      activeValue: 'build',
      label: 'Mode',
      options: [
        {
          description: 'The default agent. Executes tools based on configured permissions.',
          label: 'Build',
          value: 'build',
        },
        {
          description: 'Plan mode. Disallows all edit tools.',
          label: 'Plan',
          value: 'plan',
        },
      ],
      value: 'build',
    });
  });

  it('keeps the toolbar on build/plan even when OpenCode reports auxiliary primary modes', () => {
    expect(opencodeChatUIConfig.getModeSelector?.({
      providerConfigs: {
        opencode: {
          availableModes: [
            { description: 'Default editing agent', id: 'build', name: 'build' },
            { description: 'Internal compaction agent', id: 'compaction', name: 'compaction' },
            { description: 'Planning-first agent', id: 'plan', name: 'plan' },
          ],
          selectedMode: 'plan',
        },
      },
    })).toEqual({
      activeValue: 'build',
      label: 'Mode',
      options: [
        { description: 'Default editing agent', label: 'Build', value: 'build' },
        { description: 'Planning-first agent', label: 'Plan', value: 'plan' },
      ],
      value: 'plan',
    });
  });

  it('ignores custom-only discovery and still shows managed build/plan modes', () => {
    expect(opencodeChatUIConfig.getModeSelector?.({
      providerConfigs: {
        opencode: {
          availableModes: [
            { description: 'Internal compaction agent', id: 'compaction', name: 'compaction' },
            { description: 'Internal summary agent', id: 'summary', name: 'summary' },
          ],
          selectedMode: 'summary',
        },
      },
    })).toEqual({
      activeValue: 'build',
      label: 'Mode',
      options: [
        {
          description: 'The default agent. Executes tools based on configured permissions.',
          label: 'Build',
          value: 'build',
        },
        {
          description: 'Plan mode. Disallows all edit tools.',
          label: 'Plan',
          value: 'plan',
        },
      ],
      value: 'build',
    });
  });
});
