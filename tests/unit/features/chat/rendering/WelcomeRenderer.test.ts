import { createMockEl } from '@test/helpers/MockElement';

import {
  createWelcomeElement,
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
