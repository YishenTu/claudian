import {
  getComposerModeAfterReset,
  getComposerModeAfterToggle,
} from '@/features/chat/ui/composerMode';

describe('composerMode', () => {
  it('toggles compact to expanded', () => {
    expect(getComposerModeAfterToggle('compact')).toBe('expanded');
  });

  it('toggles expanded back to compact', () => {
    expect(getComposerModeAfterToggle('expanded')).toBe('compact');
  });

  it('reset from any mode returns to compact', () => {
    expect(getComposerModeAfterReset('expanded')).toBe('compact');
    expect(getComposerModeAfterReset('compact')).toBe('compact');
  });
});
