import {
  formatReasoningValueLabel,
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

});
