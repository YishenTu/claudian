import {
  getComposerModeAfterInput,
  getComposerModeAfterReset,
  getComposerModeAfterToggle,
} from '@/features/chat/ui/composerMode';

describe('composerMode', () => {
  it('auto-expands compact composer when text overflows', () => {
    expect(getComposerModeAfterInput('compact', { hasText: true, overflowsCompact: true }))
      .toBe('expanded');
  });

  it('keeps compact composer compact when text fits', () => {
    expect(getComposerModeAfterInput('compact', { hasText: true, overflowsCompact: false }))
      .toBe('compact');
  });

  it('keeps expanded composer expanded while typing more text', () => {
    expect(getComposerModeAfterInput('expanded', { hasText: true, overflowsCompact: true }))
      .toBe('expanded');
  });

  it('manual collapse keeps long text compact even when it still overflows', () => {
    const collapsed = getComposerModeAfterToggle('expanded', true);

    expect(collapsed).toBe('manual-collapsed');
    expect(getComposerModeAfterInput(collapsed, { hasText: true, overflowsCompact: true }))
      .toBe('manual-collapsed');
  });

  it('re-expands from manual-collapsed when toggled', () => {
    expect(getComposerModeAfterToggle('manual-collapsed', true)).toBe('expanded');
  });

  it('clearing text resets any mode to compact', () => {
    expect(getComposerModeAfterInput('expanded', { hasText: false, overflowsCompact: false }))
      .toBe('compact');
    expect(getComposerModeAfterInput('manual-collapsed', { hasText: false, overflowsCompact: false }))
      .toBe('compact');
  });

  it('send/reset returns any mode to compact', () => {
    expect(getComposerModeAfterReset('expanded')).toBe('compact');
    expect(getComposerModeAfterReset('manual-collapsed')).toBe('compact');
  });
});
