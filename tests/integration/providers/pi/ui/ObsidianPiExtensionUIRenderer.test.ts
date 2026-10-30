/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { App } from 'obsidian';

import { setLocale } from '@/i18n/i18n';
import { PiExtensionUIBridge } from '@/providers/pi/runtime/PiExtensionUIBridge';
import type { PiRPCTransport } from '@/providers/pi/runtime/PiRPCTransport';
import { ObsidianPiExtensionUIRenderer } from '@/providers/pi/ui/ObsidianPiExtensionUIRenderer';

it.each(['select', 'confirm', 'input', 'editor'] as const)('names the native %s modal for assistive technology', async method => {
  const controller = new AbortController();
  const renderer = new ObsidianPiExtensionUIRenderer(new App());
  const result = renderer[method]({ id: 'named', title: ' Review deployment ', options: ['Proceed'] }, controller.signal);
  try {
    const dialog = within(document.body).getByRole('dialog', { name: 'Review deployment' });
    expect(await axe(dialog)).toHaveNoViolations();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await expect(result).resolves.toEqual(method === 'confirm' ? { confirmed: false } : { cancelled: true });
  } finally {
    controller.abort();
    await result;
    document.body.replaceChildren();
  }
});

it.each(['input', 'editor'] as const)('submits an accessible %s field', async method => {
  const controller = new AbortController();
  const renderer = new ObsidianPiExtensionUIRenderer(new App());
  const result = renderer[method]({ id: 'request-1', method, type: 'extension_ui_request', title: 'Your answer', defaultValue: 'Initial answer' }, controller.signal);
  try {
    const region = within(document.body).getByRole('dialog');
    const field = within(region).getByRole('textbox', { name: 'Your answer' }) as HTMLInputElement;
    expect(field.value).toBe('Initial answer');
    const violations = await axe(region);
    fireEvent.input(field, { target: { value: 'Updated answer' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Submit' }));
    await expect(result).resolves.toEqual({ value: 'Updated answer' });
    expect(violations).toHaveNoViolations();
  } finally {
    controller.abort();
    await result;
    document.body.replaceChildren();
  }
});

it.each(['input', 'editor'] as const)('cancels the %s dialog without submitting edited text', async method => {
  const controller = new AbortController();
  const renderer = new ObsidianPiExtensionUIRenderer(new App());
  const result = renderer[method]({ id: 'request-1', title: 'Your answer' }, controller.signal);
  try {
    const region = within(document.body).getByRole('dialog');
    fireEvent.input(within(region).getByRole('textbox', { name: 'Your answer' }), { target: { value: 'Unsaved answer' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Cancel' }));
    await expect(result).resolves.toEqual({ cancelled: true });
    expect(within(document.body).queryByRole('dialog')).toBeNull();
  } finally {
    controller.abort();
    await result;
    document.body.replaceChildren();
  }
});

it.each(['input', 'editor'] as const)('closes an active %s dialog when its request is aborted', async method => {
  const controller = new AbortController();
  const renderer = new ObsidianPiExtensionUIRenderer(new App());
  const result = renderer[method]({ id: 'request-1', title: 'Your answer' }, controller.signal);
  try {
    expect(within(document.body).getByRole('textbox', { name: 'Your answer' })).toBeTruthy();
    controller.abort();
    await expect(result).resolves.toEqual({ cancelled: true });
    expect(within(document.body).queryByRole('dialog')).toBeNull();
  } finally {
    controller.abort();
    await result;
    document.body.replaceChildren();
  }
});

it.each(['input', 'editor'] as const)('localizes fallback %s titles and controls without altering submitted text', async method => {
  setLocale('zh-CN');
  const controller = new AbortController();
  const renderer = new ObsidianPiExtensionUIRenderer(new App());
  const result = renderer[method]({ id: 'localized', defaultValue: 'Provider text' }, controller.signal);
  try {
    const region = within(document.body).getByRole('dialog');
    expect(within(document.body).getByRole('dialog', { name: 'Pi 扩展' })).toBeDefined();
    expect(within(region).getByRole('textbox', { name: 'Pi 扩展' })).toHaveProperty('value', 'Provider text');
    expect(within(region).getByRole('button', { name: '取消' })).toBeDefined();
    fireEvent.click(within(region).getByRole('button', { name: '提交' }));
    await expect(result).resolves.toEqual({ value: 'Provider text' });
  } finally {
    controller.abort();
    await result;
    document.body.replaceChildren();
    setLocale('en');
  }
});

it.each([false, true])('keeps native editor prefill through submission (edited: %s)', async edited => {
  const send = vi.fn();
  const bridge = new PiExtensionUIBridge({ send } as unknown as PiRPCTransport, new ObsidianPiExtensionUIRenderer(new App()));
  const prefill = '  Initial text\nSecond line  ';
  try {
    bridge.handleRequest({ type: 'extension_ui_request', id: 'editor-prefill', method: 'editor', title: 'Edit draft', prefill });
    const region = within(document.body).getByRole('dialog');
    const field = within(region).getByRole('textbox', { name: 'Edit draft' });
    expect(field).toHaveProperty('value', prefill);
    const violations = await axe(region);
    const value = edited ? prefill + '\nAdded line' : prefill;
    if (edited) fireEvent.input(field, { target: { value } });
    fireEvent.click(within(region).getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'editor-prefill', value }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(violations).toHaveNoViolations();
  } finally {
    bridge.cleanup();
    document.body.replaceChildren();
  }
});

it.each(['  Keep indentation', 'Keep trailing space  ', '\tKeep both  '])('returns the original native select option %j', async value => {
  const send = vi.fn();
  const bridge = new PiExtensionUIBridge({ send } as unknown as PiRPCTransport, new ObsidianPiExtensionUIRenderer(new App()));
  try {
    bridge.handleRequest({ type: 'extension_ui_request', id: 'select-value', method: 'select', title: 'Choose text', options: [value, 'Other'] });
    const region = within(document.body).getByRole('dialog');
    const violations = await axe(region);
    fireEvent.click(within(region).getByRole('button', { name: value.trim() }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'select-value', value }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(within(document.body).queryByRole('dialog')).toBeNull();
    expect(violations).toHaveNoViolations();
  } finally {
    bridge.cleanup();
    document.body.replaceChildren();
  }
});
