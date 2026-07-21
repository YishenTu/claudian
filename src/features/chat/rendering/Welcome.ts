const WELCOME_BRAND_NAME = 'Claudian';

export function renderWelcomeContent(
  welcomeEl: HTMLElement,
  greeting?: string,
): void {
  welcomeEl.empty();
  welcomeEl.createDiv({
    cls: 'claudian-welcome-brand claudian-welcome-text',
    text: WELCOME_BRAND_NAME,
  });

  if (greeting) {
    welcomeEl.createDiv({
      cls: 'claudian-welcome-greeting claudian-welcome-text',
      text: greeting,
    });
  }
}

export function createWelcomeElement(
  parentEl: HTMLElement,
  greeting?: string,
): HTMLElement {
  const welcomeEl = parentEl.createDiv({ cls: 'claudian-welcome' });
  renderWelcomeContent(welcomeEl, greeting);
  return welcomeEl;
}
