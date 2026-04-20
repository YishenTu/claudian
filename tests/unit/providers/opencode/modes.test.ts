import {
  extractOpencodeSessionModeState,
  getEffectiveOpencodeModes,
  getOpencodeToolbarModes,
  normalizeOpencodeAvailableModes,
  normalizeOpencodeSelectedMode,
  OPENCODE_FALLBACK_MODES,
} from '../../../../src/providers/opencode/modes';
import { opencodeChatUIConfig } from '../../../../src/providers/opencode/ui/OpencodeChatUIConfig';

describe('extractOpencodeSessionModeState', () => {
  it('prefers ACP config options when mode metadata is available there', () => {
    expect(extractOpencodeSessionModeState({
      configOptions: [
        {
          category: 'mode',
          currentValue: 'plan',
          id: 'mode',
          name: 'Mode',
          options: [
            { description: 'Default editing agent', name: 'Build', value: 'build' },
            { description: 'Planning-first agent', name: 'Plan', value: 'plan' },
          ],
          type: 'select',
        },
      ],
    })).toEqual({
      availableModes: [
        { description: 'Default editing agent', id: 'build', name: 'Build' },
        { description: 'Planning-first agent', id: 'plan', name: 'Plan' },
      ],
      currentModeId: 'plan',
    });
  });

  it('falls back to ACP mode state when config options are unavailable', () => {
    expect(extractOpencodeSessionModeState({
      modes: {
        availableModes: [
          { id: 'build', name: 'Build' },
          { description: 'Planning-first agent', id: 'plan', name: 'Plan' },
        ],
        currentModeId: 'build',
      },
    })).toEqual({
      availableModes: [
        { id: 'build', name: 'Build' },
        { description: 'Planning-first agent', id: 'plan', name: 'Plan' },
      ],
      currentModeId: 'build',
    });
  });
});

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

  it('hides the selector when OpenCode only exposes one mode', () => {
    expect(opencodeChatUIConfig.getModeSelector?.({
      providerConfigs: {
        opencode: {
          availableModes: [
            { id: 'build', name: 'Build' },
          ],
          selectedMode: 'build',
        },
      },
    })).toBeNull();
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
});
