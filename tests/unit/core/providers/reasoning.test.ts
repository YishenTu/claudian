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
    ])('formats %o as %o', (value, expected) => {
      expect(formatReasoningValueLabel(value)).toBe(expected);
    });
  });

});
