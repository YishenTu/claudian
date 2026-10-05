import { testDate } from '@test/helpers/testClock';

import { formatSessionDate } from '@/features/chat/session-manager/SessionStatusPresentation';

describe('formatSessionDate', () => {
  it('should return time format for today', () => {
    const now = testDate();

    expect(formatSessionDate(now.getTime(), now)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('should return month/day format for a past date', () => {
    const now = testDate();
    const pastDate = testDate({ days: -400 });
    const result = formatSessionDate(pastDate.getTime(), now);

    expect(result).toContain(String(pastDate.getDate()));
    expect(result).not.toMatch(/^\d{2}:\d{2}$/);
  });

  it('should return month/day format for yesterday', () => {
    const now = testDate();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    expect(formatSessionDate(yesterday.getTime(), now)).not.toMatch(/^\d{2}:\d{2}$/);
  });
});
