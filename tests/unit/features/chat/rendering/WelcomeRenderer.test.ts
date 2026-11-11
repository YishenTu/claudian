import { testDate } from '@test/helpers/testClock';

import { pickWelcomeGreeting } from '@/features/chat/rendering/WelcomeRenderer';
import { setLocale } from '@/i18n/i18n';

beforeEach(() => { setLocale('en'); });
afterEach(() => { setLocale('en'); vi.restoreAllMocks(); });

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

  // Complete pools preserve repeated candidate positions as well as their wording.
  it.each([
    { day: 0, hour: 9, name: undefined, expected: ["Happy Sunday", "Sunday session?", "Welcome to the weekend", "Good morning", "Coffee and Claudian time?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 0, hour: 9, name: "Archive", expected: ["Happy Sunday, Archive", "Sunday session?", "Welcome to the weekend", "Good morning, Archive", "Coffee and Claudian time?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 0, hour: 14, name: undefined, expected: ["Happy Sunday", "Sunday session?", "Welcome to the weekend", "Good afternoon", "Hey there", "How's it going?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 0, hour: 14, name: "Archive", expected: ["Happy Sunday, Archive", "Sunday session?", "Welcome to the weekend", "Good afternoon, Archive", "Hey there, Archive", "How's it going, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 0, hour: 20, name: undefined, expected: ["Happy Sunday", "Sunday session?", "Welcome to the weekend", "Good evening", "Evening", "How was your day?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 0, hour: 20, name: "Archive", expected: ["Happy Sunday, Archive", "Sunday session?", "Welcome to the weekend", "Good evening, Archive", "Evening, Archive", "How was your day, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 0, hour: 23, name: undefined, expected: ["Happy Sunday", "Sunday session?", "Welcome to the weekend", "Hello, night owl", "Evening", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 0, hour: 23, name: "Archive", expected: ["Happy Sunday, Archive", "Sunday session?", "Welcome to the weekend", "Hello, night owl", "Evening, Archive", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 1, hour: 9, name: undefined, expected: ["Happy Monday", "Back at it!", "Good morning", "Coffee and Claudian time?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 1, hour: 9, name: "Archive", expected: ["Happy Monday, Archive", "Back at it, Archive", "Good morning, Archive", "Coffee and Claudian time?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 1, hour: 14, name: undefined, expected: ["Happy Monday", "Back at it!", "Good afternoon", "Hey there", "How's it going?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 1, hour: 14, name: "Archive", expected: ["Happy Monday, Archive", "Back at it, Archive", "Good afternoon, Archive", "Hey there, Archive", "How's it going, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 1, hour: 20, name: undefined, expected: ["Happy Monday", "Back at it!", "Good evening", "Evening", "How was your day?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 1, hour: 20, name: "Archive", expected: ["Happy Monday, Archive", "Back at it, Archive", "Good evening, Archive", "Evening, Archive", "How was your day, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 1, hour: 23, name: undefined, expected: ["Happy Monday", "Back at it!", "Hello, night owl", "Evening", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 1, hour: 23, name: "Archive", expected: ["Happy Monday, Archive", "Back at it, Archive", "Hello, night owl", "Evening, Archive", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 2, hour: 9, name: undefined, expected: ["Happy Tuesday", "Good morning", "Coffee and Claudian time?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 2, hour: 9, name: "Archive", expected: ["Happy Tuesday, Archive", "Good morning, Archive", "Coffee and Claudian time?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 2, hour: 14, name: undefined, expected: ["Happy Tuesday", "Good afternoon", "Hey there", "How's it going?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 2, hour: 14, name: "Archive", expected: ["Happy Tuesday, Archive", "Good afternoon, Archive", "Hey there, Archive", "How's it going, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 2, hour: 20, name: undefined, expected: ["Happy Tuesday", "Good evening", "Evening", "How was your day?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 2, hour: 20, name: "Archive", expected: ["Happy Tuesday, Archive", "Good evening, Archive", "Evening, Archive", "How was your day, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 2, hour: 23, name: undefined, expected: ["Happy Tuesday", "Hello, night owl", "Evening", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 2, hour: 23, name: "Archive", expected: ["Happy Tuesday, Archive", "Hello, night owl", "Evening, Archive", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 3, hour: 9, name: undefined, expected: ["Happy Wednesday", "Good morning", "Coffee and Claudian time?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 3, hour: 9, name: "Archive", expected: ["Happy Wednesday, Archive", "Good morning, Archive", "Coffee and Claudian time?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 3, hour: 14, name: undefined, expected: ["Happy Wednesday", "Good afternoon", "Hey there", "How's it going?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 3, hour: 14, name: "Archive", expected: ["Happy Wednesday, Archive", "Good afternoon, Archive", "Hey there, Archive", "How's it going, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 3, hour: 20, name: undefined, expected: ["Happy Wednesday", "Good evening", "Evening", "How was your day?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 3, hour: 20, name: "Archive", expected: ["Happy Wednesday, Archive", "Good evening, Archive", "Evening, Archive", "How was your day, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 3, hour: 23, name: undefined, expected: ["Happy Wednesday", "Hello, night owl", "Evening", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 3, hour: 23, name: "Archive", expected: ["Happy Wednesday, Archive", "Hello, night owl", "Evening, Archive", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 4, hour: 9, name: undefined, expected: ["Happy Thursday", "Good morning", "Coffee and Claudian time?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 4, hour: 9, name: "Archive", expected: ["Happy Thursday, Archive", "Good morning, Archive", "Coffee and Claudian time?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 4, hour: 14, name: undefined, expected: ["Happy Thursday", "Good afternoon", "Hey there", "How's it going?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 4, hour: 14, name: "Archive", expected: ["Happy Thursday, Archive", "Good afternoon, Archive", "Hey there, Archive", "How's it going, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 4, hour: 20, name: undefined, expected: ["Happy Thursday", "Good evening", "Evening", "How was your day?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 4, hour: 20, name: "Archive", expected: ["Happy Thursday, Archive", "Good evening, Archive", "Evening, Archive", "How was your day, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 4, hour: 23, name: undefined, expected: ["Happy Thursday", "Hello, night owl", "Evening", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 4, hour: 23, name: "Archive", expected: ["Happy Thursday, Archive", "Hello, night owl", "Evening, Archive", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 5, hour: 9, name: undefined, expected: ["Happy Friday", "That Friday feeling", "Good morning", "Coffee and Claudian time?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 5, hour: 9, name: "Archive", expected: ["Happy Friday, Archive", "That Friday feeling, Archive", "Good morning, Archive", "Coffee and Claudian time?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 5, hour: 14, name: undefined, expected: ["Happy Friday", "That Friday feeling", "Good afternoon", "Hey there", "How's it going?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 5, hour: 14, name: "Archive", expected: ["Happy Friday, Archive", "That Friday feeling, Archive", "Good afternoon, Archive", "Hey there, Archive", "How's it going, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 5, hour: 20, name: undefined, expected: ["Happy Friday", "That Friday feeling", "Good evening", "Evening", "How was your day?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 5, hour: 20, name: "Archive", expected: ["Happy Friday, Archive", "That Friday feeling, Archive", "Good evening, Archive", "Evening, Archive", "How was your day, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 5, hour: 23, name: undefined, expected: ["Happy Friday", "That Friday feeling", "Hello, night owl", "Evening", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 5, hour: 23, name: "Archive", expected: ["Happy Friday, Archive", "That Friday feeling, Archive", "Hello, night owl", "Evening, Archive", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 6, hour: 9, name: undefined, expected: ["Happy Saturday!", "Welcome to the weekend", "Good morning", "Coffee and Claudian time?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 6, hour: 9, name: "Archive", expected: ["Happy Saturday, Archive", "Welcome to the weekend, Archive", "Good morning, Archive", "Coffee and Claudian time?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 6, hour: 14, name: undefined, expected: ["Happy Saturday!", "Welcome to the weekend", "Good afternoon", "Hey there", "How's it going?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 6, hour: 14, name: "Archive", expected: ["Happy Saturday, Archive", "Welcome to the weekend, Archive", "Good afternoon, Archive", "Hey there, Archive", "How's it going, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 6, hour: 20, name: undefined, expected: ["Happy Saturday!", "Welcome to the weekend", "Good evening", "Evening", "How was your day?", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 6, hour: 20, name: "Archive", expected: ["Happy Saturday, Archive", "Welcome to the weekend, Archive", "Good evening, Archive", "Evening, Archive", "How was your day, Archive?", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
    { day: 6, hour: 23, name: undefined, expected: ["Happy Saturday!", "Welcome to the weekend", "Hello, night owl", "Evening", "Hey there", "Hi, how are you?", "How's it going?", "Welcome back!", "What's new?", "You are absolutely right!"] },
    { day: 6, hour: 23, name: "Archive", expected: ["Happy Saturday, Archive", "Welcome to the weekend, Archive", "Hello, night owl", "Evening, Archive", "Hey there, Archive", "Hi Archive, how are you?", "How's it going, Archive?", "Welcome back, Archive!", "What's new, Archive?", "Archive returns!", "You are absolutely right!"] },
  ])('preserves the complete English pool for day $day at $hour with $name', ({ day, hour, name, expected }) => {
    const now = localTime(day, hour);
    expected.forEach((greeting, index) => {
      expect(pickWelcomeGreeting(name, now, (index + 0.5) / expected.length)).toBe(greeting);
    });
  });

  it.each([
    { hour: 4, length: 10, expected: "Hello, night owl" },
    { hour: 5, length: 10, expected: "Good morning, Archive" },
    { hour: 11, length: 10, expected: "Good morning, Archive" },
    { hour: 12, length: 11, expected: "Good afternoon, Archive" },
    { hour: 17, length: 11, expected: "Good afternoon, Archive" },
    { hour: 18, length: 11, expected: "Good evening, Archive" },
    { hour: 21, length: 11, expected: "Good evening, Archive" },
    { hour: 22, length: 10, expected: "Hello, night owl" },
  ])('switches time greetings at hour $hour', ({ hour, length, expected }) => {
    expect(pickWelcomeGreeting('Archive', localTime(2, hour), 1.5 / length)).toBe(expected);
  });

  it('uses the current language on each call and keeps names verbatim', () => {
    const monday = localTime(1, 9);
    expect(pickWelcomeGreeting('Archive', monday, 0)).toBe('Happy Monday, Archive');
    expect(pickWelcomeGreeting('  ', monday, 0)).toBe('Happy Monday,   ');
    expect(pickWelcomeGreeting('  ', monday, 9.5 / 11)).toBe('   returns!');
    expect(setLocale('zh-CN')).toBe(true);
    expect(pickWelcomeGreeting("Archive", localTime(1, 9), 0.5 / 11)).toBe("周一快乐，Archive");
    expect(pickWelcomeGreeting("Archive", localTime(1, 9), 1.5 / 11)).toBe("Archive，继续加油！");
    expect(pickWelcomeGreeting("Archive", localTime(1, 9), 2.5 / 11)).toBe("早上好，Archive");
    expect(pickWelcomeGreeting("Archive", localTime(1, 9), 3.5 / 11)).toBe("喝杯咖啡，开始用 Claudian？");
    expect(pickWelcomeGreeting("Archive", localTime(1, 9), 5.5 / 11)).toBe("Archive，你好吗？");
    expect(pickWelcomeGreeting("Archive", localTime(1, 9), 9.5 / 11)).toBe("Archive 回来了！");
    expect(pickWelcomeGreeting(undefined, localTime(1, 9), 1.5 / 10)).toBe("继续加油！");
    expect(pickWelcomeGreeting("", localTime(1, 9), 1.5 / 10)).toBe("继续加油！");
    expect(pickWelcomeGreeting("Archive", localTime(6, 9), 1.5 / 11)).toBe("Archive，周末到了");
    expect(pickWelcomeGreeting("Archive", localTime(0, 9), 1.5 / 12)).toBe("周日来一场？");
    expect(pickWelcomeGreeting("Archive", localTime(0, 9), 2.5 / 12)).toBe("周末到了");
    expect(pickWelcomeGreeting("Archive", localTime(0, 23), 3.5 / 12)).toBe("你好，夜猫子");
    expect(pickWelcomeGreeting("Welcome back", localTime(1, 9), 0.5 / 11)).toBe("周一快乐，Welcome back");
    expect(pickWelcomeGreeting("Archive?!", localTime(1, 9), 5.5 / 11)).toBe("Archive?!，你好吗？");
    expect(pickWelcomeGreeting("  ", localTime(1, 9), 9.5 / 11)).toBe("   回来了！");
    expect(setLocale('en')).toBe(true);
    expect(pickWelcomeGreeting('Archive', monday, 0)).toBe('Happy Monday, Archive');
    expect(pickWelcomeGreeting('Archive', monday, 1.5 / 11)).toBe('Back at it, Archive');
    expect(pickWelcomeGreeting('Archive', monday, 9.5 / 11)).toBe('Archive returns!');
  });
});
