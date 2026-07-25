import {
  KIMI_DEFAULT_MODE_ID,
  KIMI_PLAN_MODE_ID,
  KIMI_YOLO_MODE_ID,
  resolveKimiModeForPermissionMode,
  resolvePermissionModeForKimiMode,
} from '@/providers/kimi/modes';

describe('Kimi mode mapping', () => {
  it('maps shared permission modes onto kimi mode ids', () => {
    expect(resolveKimiModeForPermissionMode('plan')).toBe(KIMI_PLAN_MODE_ID);
    expect(resolveKimiModeForPermissionMode('yolo')).toBe(KIMI_YOLO_MODE_ID);
    expect(resolveKimiModeForPermissionMode('normal')).toBe(KIMI_DEFAULT_MODE_ID);
    expect(resolveKimiModeForPermissionMode(undefined)).toBe(KIMI_DEFAULT_MODE_ID);
    expect(resolveKimiModeForPermissionMode('bogus')).toBe(KIMI_DEFAULT_MODE_ID);
  });

  it('maps kimi mode ids back to shared permission modes', () => {
    expect(resolvePermissionModeForKimiMode('plan')).toBe('plan');
    expect(resolvePermissionModeForKimiMode('yolo')).toBe('yolo');
    expect(resolvePermissionModeForKimiMode('default')).toBe('normal');
  });

  it('leaves kimi-only modes without a shared equivalent unmapped', () => {
    expect(resolvePermissionModeForKimiMode('auto')).toBeNull();
    expect(resolvePermissionModeForKimiMode(undefined)).toBeNull();
    expect(resolvePermissionModeForKimiMode('bogus')).toBeNull();
  });
});
