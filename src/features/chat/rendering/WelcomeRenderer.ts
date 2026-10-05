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

  welcomeEl.createDiv({ cls: 'claudian-welcome-linked-content' });
}

export function createWelcomeElement(
  parentEl: HTMLElement,
  greeting?: string,
): HTMLElement {
  const welcomeEl = parentEl.createDiv({ cls: 'claudian-welcome' });
  renderWelcomeContent(welcomeEl, greeting);
  return welcomeEl;
}

/**
 * Picks a welcome greeting for the day and hour of `now`, personalized when a name is set.
 * `random` is a number in [0, 1) that selects among the candidates.
 */
export function pickWelcomeGreeting(name: string | undefined, now: Date, random: number): string {
  const hour = now.getHours();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday

  const personalize = (base: string, noNameFallback?: string): string =>
    name ? `${base}, ${name}` : (noNameFallback ?? base);

  const dayGreetings: Record<number, string[]> = {
    0: [personalize('Happy Sunday'), 'Sunday session?', 'Welcome to the weekend'],
    1: [personalize('Happy Monday'), personalize('Back at it', 'Back at it!')],
    2: [personalize('Happy Tuesday')],
    3: [personalize('Happy Wednesday')],
    4: [personalize('Happy Thursday')],
    5: [personalize('Happy Friday'), personalize('That Friday feeling')],
    6: [personalize('Happy Saturday', 'Happy Saturday!'), personalize('Welcome to the weekend')],
  };

  const timeGreetings = (): string[] => {
    if (hour >= 5 && hour < 12) {
      return [personalize('Good morning'), 'Coffee and Claudian time?'];
    } else if (hour >= 12 && hour < 18) {
      return [personalize('Good afternoon'), personalize('Hey there'), personalize("How's it going") + '?'];
    } else if (hour >= 18 && hour < 22) {
      return [personalize('Good evening'), personalize('Evening'), personalize('How was your day') + '?'];
    }
    return ['Hello, night owl', personalize('Evening')];
  };

  const generalGreetings = [
    personalize('Hey there'),
    name ? `Hi ${name}, how are you?` : 'Hi, how are you?',
    personalize("How's it going") + '?',
    personalize('Welcome back') + '!',
    personalize("What's new") + '?',
    ...(name ? [`${name} returns!`] : []),
    'You are absolutely right!',
  ];

  const greetings = [
    ...(dayGreetings[day] || []),
    ...timeGreetings(),
    ...generalGreetings,
  ];

  return greetings[Math.floor(random * greetings.length)];
}
