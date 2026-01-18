/**
 * Unit tests for date utilities.
 */

import { formatDurationMmSs } from '../../../src/utils/date';

describe('formatDurationMmSs', () => {
  it('formats 0 seconds as 00:00', () => {
    expect(formatDurationMmSs(0)).toBe('00:00');
  });

  it('formats 59 seconds as 00:59', () => {
    expect(formatDurationMmSs(59)).toBe('00:59');
  });

  it('formats 60 seconds as 01:00', () => {
    expect(formatDurationMmSs(60)).toBe('01:00');
  });

  it('formats 61 seconds as 01:01', () => {
    expect(formatDurationMmSs(61)).toBe('01:01');
  });

  it('formats single digit seconds with leading zero', () => {
    expect(formatDurationMmSs(5)).toBe('00:05');
  });

  it('formats single digit minutes with leading zero', () => {
    expect(formatDurationMmSs(125)).toBe('02:05');
  });

  it('formats large durations correctly', () => {
    // 10 minutes 30 seconds = 630 seconds
    expect(formatDurationMmSs(630)).toBe('10:30');
  });

  it('formats hour+ durations correctly', () => {
    // 1 hour 5 minutes = 65 minutes = 3900 seconds
    expect(formatDurationMmSs(3900)).toBe('65:00');
  });

  describe('input validation', () => {
    it('returns 00:00 for negative values', () => {
      expect(formatDurationMmSs(-1)).toBe('00:00');
      expect(formatDurationMmSs(-60)).toBe('00:00');
      expect(formatDurationMmSs(-100)).toBe('00:00');
    });

    it('returns 00:00 for NaN', () => {
      expect(formatDurationMmSs(NaN)).toBe('00:00');
    });

    it('returns 00:00 for Infinity', () => {
      expect(formatDurationMmSs(Infinity)).toBe('00:00');
      expect(formatDurationMmSs(-Infinity)).toBe('00:00');
    });
  });
});
