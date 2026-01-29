import { formatDurationMmSs, getTodayDate } from '../../../src/utils/date';

describe('getTodayDate', () => {
  it('returns readable date with ISO suffix', () => {
    const result = getTodayDate();
    // Should end with ISO date in parentheses, e.g. "(2024-01-15)"
    expect(result).toMatch(/\(\d{4}-\d{2}-\d{2}\)$/);
  });

  it('includes day of week and full date', () => {
    const result = getTodayDate();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const now = new Date();
    expect(result).toContain(days[now.getDay()]);
    expect(result).toContain(months[now.getMonth()]);
    expect(result).toContain(String(now.getFullYear()));
  });

  it('ISO portion matches current date', () => {
    const result = getTodayDate();
    const isoMatch = result.match(/\((\d{4}-\d{2}-\d{2})\)/);
    expect(isoMatch).not.toBeNull();
    const today = new Date().toISOString().split('T')[0];
    expect(isoMatch![1]).toBe(today);
  });
});

describe('formatDurationMmSs', () => {
  it('formats 0 seconds as 0s', () => {
    expect(formatDurationMmSs(0)).toBe('0s');
  });

  it('formats 59 seconds as 59s', () => {
    expect(formatDurationMmSs(59)).toBe('59s');
  });

  it('formats 60 seconds as 1m 0s', () => {
    expect(formatDurationMmSs(60)).toBe('1m 0s');
  });

  it('formats 61 seconds as 1m 1s', () => {
    expect(formatDurationMmSs(61)).toBe('1m 1s');
  });

  it('formats single digit seconds without leading zero', () => {
    expect(formatDurationMmSs(5)).toBe('5s');
  });

  it('formats minutes and seconds correctly', () => {
    expect(formatDurationMmSs(125)).toBe('2m 5s');
  });

  it('formats large durations correctly', () => {
    // 10 minutes 30 seconds = 630 seconds
    expect(formatDurationMmSs(630)).toBe('10m 30s');
  });

  it('formats hour+ durations correctly', () => {
    // 1 hour 5 minutes = 65 minutes = 3900 seconds
    expect(formatDurationMmSs(3900)).toBe('65m 0s');
  });

  describe('input validation', () => {
    it('returns 0s for negative values', () => {
      expect(formatDurationMmSs(-1)).toBe('0s');
      expect(formatDurationMmSs(-60)).toBe('0s');
      expect(formatDurationMmSs(-100)).toBe('0s');
    });

    it('returns 0s for NaN', () => {
      expect(formatDurationMmSs(NaN)).toBe('0s');
    });

    it('returns 0s for Infinity', () => {
      expect(formatDurationMmSs(Infinity)).toBe('0s');
      expect(formatDurationMmSs(-Infinity)).toBe('0s');
    });
  });
});
