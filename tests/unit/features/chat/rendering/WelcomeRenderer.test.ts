import { testDate } from '@test/helpers/testClock';

import { pickWelcomeGreeting } from '@/features/chat/rendering/WelcomeRenderer';

describe('pickWelcomeGreeting', () => {
  function localTime(day: number, hour: number): Date {
    const date = testDate();
    date.setDate(date.getDate() + ((day - date.getDay() + 7) % 7));
    date.setHours(hour, 0, 0, 0);
    return date;
  }

  it.each([
    { name: 'morning (5-12)', hour: 9, day: 1, patterns: ['morning', 'Coffee'] },
    { name: 'afternoon (12-18)', hour: 14, day: 2, patterns: ['afternoon'] },
    { name: 'evening (18-22)', hour: 20, day: 3, patterns: ['evening', 'Evening', 'your day'] },
    { name: 'night owl (22+)', hour: 23, day: 4, patterns: ['night owl', 'Evening'] },
    { name: 'early morning night owl (0-4)', hour: 2, day: 0, patterns: ['night owl', 'Evening'] },
  ])('should include $name greetings', ({ hour, day, patterns }) => {
    const now = localTime(day, hour);

    const greetings = new Set(
      Array.from({ length: 50 }, (_, i) => pickWelcomeGreeting(undefined, now, i / 50)),
    );

    const hasTimeBased = [...greetings].some(g =>
      patterns.some(p => g.includes(p))
    );
    expect(hasTimeBased).toBe(true);
  });
});
