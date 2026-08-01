import { renderProviderModelEnablementWarning } from '@/shared/settings/ProviderModelEnablementWarning';

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

function createElement(): Pick<HTMLElement, 'toggleClass'> {
  return {
    toggleClass: jest.fn(),
  } as unknown as Pick<HTMLElement, 'toggleClass'>;
}
