/** @vitest-environment jsdom */

import { within } from '@testing-library/dom';

import { createWelcomeElement, renderWelcomeContent } from '@/features/chat/rendering/WelcomeRenderer';

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
