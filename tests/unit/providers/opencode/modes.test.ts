import {
  getEffectiveOpencodeModes,
  getManagedOpencodeModes,
  normalizeManagedOpencodeSelectedMode,
  normalizeOpencodeAvailableModes,
  normalizeOpencodeSelectedMode,
  OPENCODE_BUILD_MODE_ID,
  OPENCODE_FALLBACK_MODES,
  OPENCODE_SAFE_MODE_ID,
  OPENCODE_YOLO_MODE_ID,
  resolveOpencodeModeForPermissionMode,
  resolvePermissionModeForManagedOpencodeMode,
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

  it('keeps Claudian on managed YOLO/safe/plan modes even when discovery only reports custom agents', () => {
    expect(getManagedOpencodeModes([
      { id: 'compaction', name: 'compaction' },
      { id: 'summary', name: 'summary' },
    ])).toEqual(OPENCODE_FALLBACK_MODES);
  });

  it('normalizes unsupported saved mode selections to the managed safe mode', () => {
    expect(normalizeManagedOpencodeSelectedMode('compaction')).toBe(OPENCODE_SAFE_MODE_ID);
    expect(normalizeManagedOpencodeSelectedMode(123)).toBe(OPENCODE_SAFE_MODE_ID);
    expect(normalizeManagedOpencodeSelectedMode(null)).toBe(OPENCODE_SAFE_MODE_ID);
  });

  it('preserves absent and blank saved mode selections as unset', () => {
    expect(normalizeManagedOpencodeSelectedMode(undefined)).toBe('');
    expect(normalizeManagedOpencodeSelectedMode('   ')).toBe('');
  });

  it('normalizes the legacy build id back to the managed YOLO mode', () => {
    expect(normalizeManagedOpencodeSelectedMode(OPENCODE_BUILD_MODE_ID)).toBe(OPENCODE_YOLO_MODE_ID);
  });

  it('maps shared permission modes onto managed OpenCode modes', () => {
    expect(resolveOpencodeModeForPermissionMode('yolo')).toBe(OPENCODE_YOLO_MODE_ID);
    expect(resolveOpencodeModeForPermissionMode('normal')).toBe(OPENCODE_SAFE_MODE_ID);
    expect(resolveOpencodeModeForPermissionMode('plan')).toBe('plan');
    expect(resolveOpencodeModeForPermissionMode('danger-full-access')).toBe(OPENCODE_SAFE_MODE_ID);
  });

  it('maps managed OpenCode modes back to shared permission modes', () => {
    expect(resolvePermissionModeForManagedOpencodeMode(OPENCODE_BUILD_MODE_ID)).toBe('yolo');
    expect(resolvePermissionModeForManagedOpencodeMode(OPENCODE_YOLO_MODE_ID)).toBe('yolo');
    expect(resolvePermissionModeForManagedOpencodeMode(OPENCODE_SAFE_MODE_ID)).toBe('normal');
    expect(resolvePermissionModeForManagedOpencodeMode('plan')).toBe('plan');
    expect(resolvePermissionModeForManagedOpencodeMode('summary')).toBeNull();
  });
});

describe('opencodeChatUIConfig permission mode wiring', () => {
  it('exposes the shared Safe/YOLO/Plan toggle instead of a provider-owned mode selector', () => {
    expect(opencodeChatUIConfig.getModeSelector?.({
      providerConfigs: {
        opencode: {
          availableModes: [
            { id: OPENCODE_YOLO_MODE_ID, name: 'YOLO' },
            { id: OPENCODE_SAFE_MODE_ID, name: 'Safe' },
            { id: 'plan', name: 'Plan' },
          ],
          selectedMode: OPENCODE_SAFE_MODE_ID,
        },
      },
    }) ?? null).toBeNull();

    expect(opencodeChatUIConfig.getPermissionModeToggle?.()).toEqual({
      activeLabel: 'YOLO',
      activeValue: 'yolo',
      inactiveLabel: 'Safe',
      inactiveValue: 'normal',
      planLabel: 'Plan',
      planValue: 'plan',
    });
  });

  it('derives shared permission mode from the saved managed OpenCode mode', () => {
    expect(opencodeChatUIConfig.resolvePermissionMode?.({
      providerConfigs: {
        opencode: {
          selectedMode: OPENCODE_BUILD_MODE_ID,
        },
      },
    })).toBe('yolo');

    expect(opencodeChatUIConfig.resolvePermissionMode?.({
      providerConfigs: {
        opencode: {
          selectedMode: OPENCODE_SAFE_MODE_ID,
        },
      },
    })).toBe('normal');

    expect(opencodeChatUIConfig.resolvePermissionMode?.({
      providerConfigs: {
        opencode: {
          selectedMode: OPENCODE_YOLO_MODE_ID,
        },
      },
    })).toBe('yolo');

    expect(opencodeChatUIConfig.resolvePermissionMode?.({
      providerConfigs: {
        opencode: {
          selectedMode: 'plan',
        },
      },
    })).toBe('plan');
  });

  it('maps shared permission mode changes back into managed OpenCode modes', () => {
    const settings: Record<string, unknown> = {
      permissionMode: 'yolo',
      providerConfigs: {
        opencode: {
          availableModes: [
            { id: OPENCODE_YOLO_MODE_ID, name: 'YOLO' },
            { id: OPENCODE_SAFE_MODE_ID, name: 'Safe' },
            { id: 'plan', name: 'Plan' },
          ],
          selectedMode: OPENCODE_YOLO_MODE_ID,
        },
      },
    };

    opencodeChatUIConfig.applyPermissionMode?.('normal', settings);
    expect(settings.permissionMode).toBe('normal');
    expect((settings.providerConfigs as Record<string, Record<string, unknown>>).opencode.selectedMode).toBe(OPENCODE_SAFE_MODE_ID);

    opencodeChatUIConfig.applyPermissionMode?.('plan', settings);
    expect((settings.providerConfigs as Record<string, Record<string, unknown>>).opencode.selectedMode).toBe('plan');

    opencodeChatUIConfig.applyPermissionMode?.('yolo', settings);
    expect((settings.providerConfigs as Record<string, Record<string, unknown>>).opencode.selectedMode).toBe(OPENCODE_YOLO_MODE_ID);
  });
});
