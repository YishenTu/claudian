import { createMockEl } from '@test/helpers/MockElement';
import { testDate } from '@test/helpers/testClock';

import {
  createWelcomeElement,
  pickWelcomeGreeting,
  renderWelcomeContent,
} from '@/features/chat/rendering/WelcomeRenderer';

describe('Welcome', () => {
  it('renders Claudian branding before the dynamic greeting', () => {
    const parentEl = createMockEl();

    const welcomeEl = createWelcomeElement(parentEl, 'Good morning');

    expect(welcomeEl.hasClass('claudian-welcome')).toBe(true);
    expect(welcomeEl.children).toHaveLength(3);
    expect(welcomeEl.children[0].hasClass('claudian-welcome-brand')).toBe(true);
    expect(welcomeEl.children[0].hasClass('claudian-welcome-text')).toBe(true);
    expect(welcomeEl.children[0].textContent).toBe('Claudian');
    expect(welcomeEl.children[1].hasClass('claudian-welcome-greeting')).toBe(true);
    expect(welcomeEl.children[1].hasClass('claudian-welcome-text')).toBe(true);
    expect(welcomeEl.children[1].textContent).toBe('Good morning');
    expect(welcomeEl.children[2].hasClass('claudian-welcome-linked-content')).toBe(true);
  });

  it('replaces existing welcome content instead of duplicating branding', () => {
    const welcomeEl = createMockEl();

    renderWelcomeContent(welcomeEl, 'Hello');
    renderWelcomeContent(welcomeEl, 'Welcome back');

    expect(welcomeEl.children).toHaveLength(3);
    expect(welcomeEl.querySelectorAll('.claudian-welcome-brand')).toHaveLength(1);
    expect(welcomeEl.querySelector('.claudian-welcome-greeting')?.textContent)
      .toBe('Welcome back');
    expect(welcomeEl.querySelectorAll('.claudian-welcome-linked-content')).toHaveLength(1);
  });

  it('can render the brand before a greeting is available', () => {
    const parentEl = createMockEl();

    const welcomeEl = createWelcomeElement(parentEl);

    expect(welcomeEl.children).toHaveLength(2);
    expect(welcomeEl.children[0].textContent).toBe('Claudian');
    expect(welcomeEl.children[1].hasClass('claudian-welcome-linked-content')).toBe(true);
  });
});

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
