import {
  formatReasoningValueLabel,
  resolvePreferredReasoningDefault,
} from '@/core/providers/reasoning';

describe('provider reasoning helpers', () => {
  describe('formatReasoningValueLabel', () => {
    it.each([
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['xhigh', 'xHigh'],
      [' XHIGH ', 'xHigh'],
      ['', ''],
    ])('formats %p as %p', (value, expected) => {
      expect(formatReasoningValueLabel(value)).toBe(expected);
    });
  });

  describe('resolvePreferredReasoningDefault', () => {
    it('prefers high when it is available', () => {
      expect(resolvePreferredReasoningDefault(['low', 'high'], 'low')).toBe('high');
    });

    it('uses the fallback or first available value when high is unavailable', () => {
      expect(resolvePreferredReasoningDefault(['low', 'medium'], 'medium')).toBe('medium');
      expect(resolvePreferredReasoningDefault(['low', 'medium'], 'max')).toBe('low');
    });
  });
});
