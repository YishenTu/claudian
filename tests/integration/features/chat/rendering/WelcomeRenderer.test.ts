/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { testDate } from '@test/helpers/testClock';
import { within } from '@testing-library/dom';

import { createWelcomeElement, pickWelcomeGreeting, renderWelcomeContent } from '@/features/chat/rendering/WelcomeRenderer';
import { setLocale, t } from '@/i18n/i18n';

afterEach(() => { setLocale('en'); document.body.replaceChildren(); vi.restoreAllMocks(); });

it('renders the brand before a greeting arrives and replaces greetings without duplicating content', () => {
  const parent = document.createElement('div');
  const welcome = createWelcomeElement(parent);
  expect(within(welcome).getByText('Claudian')).toBeDefined();
  renderWelcomeContent(welcome, 'Good morning');
  expect(within(welcome).getByText('Good morning')).toBeDefined();
  renderWelcomeContent(welcome, 'Welcome back');
  expect(within(welcome).getAllByText('Claudian')).toHaveLength(1);
  expect(within(welcome).getAllByText('Welcome back')).toHaveLength(1);
  expect(within(welcome).queryByText('Good morning')).toBeNull();
});

it('renders and replaces translated picker greetings while preserving caller data', async () => {
  const englishBackAtIt = t('chat.welcome.backAtItNamed', { name: 'Archive' });
  setLocale('zh-CN');
  const backAtIt = t('chat.welcome.backAtItNamed', { name: 'Archive' });
  const hiHow = t('chat.welcome.hiHowNamed', { name: 'Archive' });
  const coffee = t('chat.welcome.coffee', { brand: 'Claudian' });
  expect(backAtIt).not.toBe(englishBackAtIt);
  const monday = testDate();
  monday.setDate(monday.getDate() + ((1 - monday.getDay() + 7) % 7));
  monday.setHours(9, 0, 0, 0);
  const parent = document.body.createDiv();
  const welcome = createWelcomeElement(parent, pickWelcomeGreeting('Archive', monday, 1.5 / 11));
  expect(welcome.isConnected).toBe(true);
  expect(within(welcome).getByText(backAtIt)).toBeDefined();

  renderWelcomeContent(welcome, pickWelcomeGreeting('Archive', monday, 5.5 / 11));
  expect(within(welcome).getByText(hiHow)).toBeDefined();
  expect(within(welcome).queryByText(backAtIt)).toBeNull();
  expect(welcome.querySelectorAll('.claudian-welcome-brand')).toHaveLength(1);
  expect(welcome.querySelector('.claudian-welcome-brand')?.textContent).toBe('Claudian');
  expect(welcome.querySelectorAll('.claudian-welcome-greeting')).toHaveLength(1);
  expect(welcome.querySelectorAll('.claudian-welcome-linked-content')).toHaveLength(1);

  renderWelcomeContent(welcome, pickWelcomeGreeting('Archive', monday, 3.5 / 11));
  expect(within(welcome).getByText(coffee)).toBeDefined();
  expect(welcome.querySelectorAll('.claudian-welcome-brand')).toHaveLength(1);
  expect(welcome.querySelectorAll('.claudian-welcome-linked-content')).toHaveLength(1);

  for (const greeting of ['Good morning', 'Welcome back', 'Archive?!']) {
    renderWelcomeContent(welcome, greeting);
    expect(welcome.querySelector('.claudian-welcome-greeting')?.textContent).toBe(greeting);
    expect(welcome.querySelectorAll('.claudian-welcome-brand')).toHaveLength(1);
    expect(welcome.querySelectorAll('.claudian-welcome-linked-content')).toHaveLength(1);
  }
  expect((await axe(welcome, { runOnly: ['aria-valid-attr', 'aria-valid-attr-value'] })).violations).toEqual([]);
});
