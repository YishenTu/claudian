// @test-ci {"inputs":["src/style/base/visibility.css"]}
/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { axe } from '@test/helpers/accessibility';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { within } from '@testing-library/dom';

import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '@/shared/settings/ProviderModelEnablementWarning';

let style: HTMLStyleElement;
beforeEach(() => {
  style = document.head.createEl('style');
  style.textContent = readFileSync(path.resolve('src/style/base/visibility.css'), 'utf8');
});
afterEach(() => { vi.useRealTimers(); style.remove(); document.body.replaceChildren(); });

it('shows the model warning only when enabled without models and forwards relevant notifications', async () => {
  const { host } = await createProviderHostFixture();
  let enabled = true;
  let hasModels = false;
  const container = document.body.createEl('main');
  const notify = vi.fn();
  const warning = renderProviderModelEnablementWarning(container, {
    plugin: host, renderCustomContextLimits() {}, notifyProviderModelOptionsChanged: notify,
  }, { getIsEnabled: () => enabled, getHasEnabledModels: () => hasModels,
    providerId: 'codex', providerName: 'Codex' });
  const message = within(container).getByText('No Codex models are enabled. Go to Models below and enable at least one model.');
  expect(getComputedStyle(message).display).not.toBe('none');
  hasModels = true;
  warning.context.notifyProviderModelOptionsChanged('codex');
  expect(getComputedStyle(message).display).toBe('none');
  expect(notify).toHaveBeenCalledExactlyOnceWith('codex');
  hasModels = false;
  warning.context.notifyProviderModelOptionsChanged('claude');
  expect(getComputedStyle(message).display).toBe('none');
  expect(notify).toHaveBeenLastCalledWith('claude');
  warning.refresh();
  expect(getComputedStyle(message).display).not.toBe('none');
  enabled = false;
  warning.refresh();
  expect(getComputedStyle(message).display).toBe('none');
  expect(await axe(container)).toHaveNoViolations();
});

it('exposes a live last-provider warning for ten seconds before hiding it', async () => {
  const container = document.body.createEl('main');
  const warning = renderLastEnabledProviderWarning(container);
  expect(within(container).queryByRole('status')).toBeNull();
  vi.useFakeTimers();
  warning.showFor();
  const message = within(container).getByRole('status');
  expect(message.textContent).toBe('At least one provider must remain enabled for Claudian to work.');
  expect(message.getAttribute('aria-live')).toBe('polite');
  await vi.advanceTimersByTimeAsync(9999);
  expect(within(container).getByRole('status')).toBe(message);
  await vi.advanceTimersByTimeAsync(1);
  expect(within(container).queryByRole('status')).toBeNull();
  vi.useRealTimers();
  warning.showFor();
  try { expect(await axe(container)).toHaveNoViolations(); } finally { warning.hide(); }
});

it('restarts the same warning deadline after a repeated attempt and supports immediate hiding', async () => {
  const container = document.body.createEl('main');
  const warning = renderLastEnabledProviderWarning(container);
  vi.useFakeTimers();
  warning.showFor();
  const message = within(container).getByRole('status');
  await vi.advanceTimersByTimeAsync(9000);
  warning.showFor();
  await vi.advanceTimersByTimeAsync(1000);
  expect(within(container).getByRole('status')).toBe(message);
  warning.hide();
  expect(within(container).queryByRole('status')).toBeNull();
  await vi.advanceTimersByTimeAsync(10000);
  expect(within(container).queryByRole('status')).toBeNull();
});
