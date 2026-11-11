import { t } from '@/i18n/i18n';
import type { TranslationKey } from '@/i18n/types';

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

  const personalize = (unnamed: TranslationKey, named: TranslationKey): string =>
    name ? t(named, { name }) : t(unnamed);

  const dayGreetings: Record<number, string[]> = {
    0: [
      personalize('chat.welcome.sunday', 'chat.welcome.sundayNamed'),
      t('chat.welcome.sundaySession'),
      t('chat.welcome.weekend'),
    ],
    1: [
      personalize('chat.welcome.monday', 'chat.welcome.mondayNamed'),
      personalize('chat.welcome.backAtIt', 'chat.welcome.backAtItNamed'),
    ],
    2: [personalize('chat.welcome.tuesday', 'chat.welcome.tuesdayNamed')],
    3: [personalize('chat.welcome.wednesday', 'chat.welcome.wednesdayNamed')],
    4: [personalize('chat.welcome.thursday', 'chat.welcome.thursdayNamed')],
    5: [
      personalize('chat.welcome.friday', 'chat.welcome.fridayNamed'),
      personalize('chat.welcome.fridayFeeling', 'chat.welcome.fridayFeelingNamed'),
    ],
    6: [
      personalize('chat.welcome.saturday', 'chat.welcome.saturdayNamed'),
      personalize('chat.welcome.weekend', 'chat.welcome.weekendNamed'),
    ],
  };

  const timeGreetings = (): string[] => {
    if (hour >= 5 && hour < 12) {
      return [
        personalize('chat.welcome.morning', 'chat.welcome.morningNamed'),
        t('chat.welcome.coffee', { brand: WELCOME_BRAND_NAME }),
      ];
    } else if (hour >= 12 && hour < 18) {
      return [
        personalize('chat.welcome.afternoon', 'chat.welcome.afternoonNamed'),
        personalize('chat.welcome.hey', 'chat.welcome.heyNamed'),
        personalize('chat.welcome.howGoing', 'chat.welcome.howGoingNamed'),
      ];
    } else if (hour >= 18 && hour < 22) {
      return [
        personalize('chat.welcome.evening', 'chat.welcome.eveningNamed'),
        personalize('chat.welcome.eveningShort', 'chat.welcome.eveningShortNamed'),
        personalize('chat.welcome.howDay', 'chat.welcome.howDayNamed'),
      ];
    }
    return [t('chat.welcome.nightOwl'), personalize('chat.welcome.eveningShort', 'chat.welcome.eveningShortNamed')];
  };

  const generalGreetings = [
    personalize('chat.welcome.hey', 'chat.welcome.heyNamed'),
    personalize('chat.welcome.hiHow', 'chat.welcome.hiHowNamed'),
    personalize('chat.welcome.howGoing', 'chat.welcome.howGoingNamed'),
    personalize('chat.welcome.welcomeBack', 'chat.welcome.welcomeBackNamed'),
    personalize('chat.welcome.whatsNew', 'chat.welcome.whatsNewNamed'),
    ...(name ? [t('chat.welcome.returnsNamed', { name })] : []),
    t('chat.welcome.right'),
  ];

  const greetings = [
    ...(dayGreetings[day] || []),
    ...timeGreetings(),
    ...generalGreetings,
  ];

  return greetings[Math.floor(random * greetings.length)];
}
