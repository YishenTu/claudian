import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '@/shared/settings/ProviderModelEnablementWarning';

describe('renderProviderModelEnablementWarning', () => {
  it('shows only while the provider is enabled without an available model', () => {
    let enabled = true;
    let hasModels = false;
    const warningEl = createElement();
    const notifyProviderModelOptionsChanged = jest.fn();
    const container = {
      createDiv: jest.fn(() => warningEl),
    } as unknown as HTMLElement;

    const warning = renderProviderModelEnablementWarning(
      container,
      {
        notifyProviderModelOptionsChanged,
      } as any,
      {
        getHasEnabledModels: () => hasModels,
        getIsEnabled: () => enabled,
        providerId: 'codex',
        providerName: 'Codex',
      },
    );

    expect(container.createDiv).toHaveBeenCalledWith({
      cls: expect.stringContaining('claudian-setting-validation-warning'),
      text: 'No Codex models are enabled. Go to Models below and enable at least one model.',
    });
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', false);

    hasModels = true;
    warning.context.notifyProviderModelOptionsChanged('codex');
    expect(notifyProviderModelOptionsChanged).toHaveBeenCalledWith('codex');
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', true);

    hasModels = false;
    enabled = false;
    warning.refresh();
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', true);
  });
});

describe('renderLastEnabledProviderWarning', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows accessibly for ten seconds and then hides', () => {
    const warningEl = createElement();
    const container = {
      createDiv: jest.fn(() => warningEl),
    } as unknown as HTMLElement;

    const warning = renderLastEnabledProviderWarning(container);

    expect(container.createDiv).toHaveBeenCalledWith({
      attr: {
        'aria-live': 'polite',
        role: 'status',
      },
      cls: expect.stringContaining('claudian-setting-validation-warning'),
      text: 'At least one provider must remain enabled for Claudian to work.',
    });
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', true);

    warning.showFor();
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', false);

    jest.advanceTimersByTime(9_999);
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', false);

    jest.advanceTimersByTime(1);
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', true);
  });

  it('restarts the timer on repeated attempts and supports immediate hiding', () => {
    const warningEl = createElement();
    const container = {
      createDiv: jest.fn(() => warningEl),
    } as unknown as HTMLElement;
    const warning = renderLastEnabledProviderWarning(container);

    warning.showFor();
    jest.advanceTimersByTime(9_000);
    warning.showFor();
    jest.advanceTimersByTime(1_000);
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', false);

    warning.hide();
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', true);
    jest.advanceTimersByTime(10_000);
    expect(warningEl.toggleClass).toHaveBeenLastCalledWith('claudian-hidden', true);
  });
});

function createElement(): Pick<HTMLElement, 'toggleClass'> {
  return {
    toggleClass: jest.fn(),
  } as unknown as Pick<HTMLElement, 'toggleClass'>;
}
