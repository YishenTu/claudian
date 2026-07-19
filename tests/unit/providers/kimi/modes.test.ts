import {
  resolveKimiModeForPermissionMode,
  resolvePermissionModeForKimiMode,
} from '@/providers/kimi/modes';

describe('kimi modes', () => {
  it('maps shared permission modes onto Kimi ACP modes', () => {
    expect(resolveKimiModeForPermissionMode('normal')).toBe('default');
    expect(resolveKimiModeForPermissionMode('plan')).toBe('plan');
    expect(resolveKimiModeForPermissionMode('yolo')).toBe('yolo');
  });

  it('maps Kimi modes back to shared permission modes', () => {
    expect(resolvePermissionModeForKimiMode('default')).toBe('normal');
    expect(resolvePermissionModeForKimiMode('plan')).toBe('plan');
    expect(resolvePermissionModeForKimiMode('yolo')).toBe('yolo');
    expect(resolvePermissionModeForKimiMode('auto')).toBe('yolo');
  });
});
