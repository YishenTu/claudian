/** @jest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';
import type { App } from 'obsidian';

jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');
  class Modal {
    contentEl = document.createElement('section');
    open() {
      this.contentEl.setAttribute('aria-label', 'Pi extension');
      document.body.appendChild(this.contentEl);
      (this as unknown as { onOpen(): void }).onOpen();
    }
    close() {
      (this as unknown as { onClose(): void }).onClose();
      this.contentEl.remove();
    }
  }
  return { ...actual, Modal };
});
import { ObsidianPiExtensionUIRenderer } from '@/providers/pi/ui/ObsidianPiExtensionUIRenderer';
HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...names) { this.classList.add(...names); };

it.each(['input', 'editor'] as const)('submits an accessible %s field', async method => {
  const controller = new AbortController();
  const renderer = new ObsidianPiExtensionUIRenderer({} as App);
  const result = renderer[method]({ id: 'request-1', method, type: 'extension_ui_request', title: 'Your answer', defaultValue: 'Initial answer' }, controller.signal);
  try {
    const region = within(document.body).getByRole('region', { name: 'Pi extension' });
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
  const renderer = new ObsidianPiExtensionUIRenderer({} as App);
  const result = renderer[method]({ id: 'request-1', title: 'Your answer' }, controller.signal);
  try {
    const region = within(document.body).getByRole('region', { name: 'Pi extension' });
    fireEvent.input(within(region).getByRole('textbox', { name: 'Your answer' }), { target: { value: 'Unsaved answer' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Cancel' }));
    await expect(result).resolves.toEqual({ cancelled: true });
    expect(within(document.body).queryByRole('region', { name: 'Pi extension' })).toBeNull();
  } finally {
    controller.abort();
    await result;
    document.body.replaceChildren();
  }
});

it.each(['input', 'editor'] as const)('closes an active %s dialog when its request is aborted', async method => {
  const controller = new AbortController();
  const renderer = new ObsidianPiExtensionUIRenderer({} as App);
  const result = renderer[method]({ id: 'request-1', title: 'Your answer' }, controller.signal);
  try {
    expect(within(document.body).getByRole('textbox', { name: 'Your answer' })).toBeTruthy();
    controller.abort();
    await expect(result).resolves.toEqual({ cancelled: true });
    expect(within(document.body).queryByRole('region', { name: 'Pi extension' })).toBeNull();
  } finally {
    controller.abort();
    await result;
    document.body.replaceChildren();
  }
});
