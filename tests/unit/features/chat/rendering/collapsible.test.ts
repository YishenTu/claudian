/** @jest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import {
  collapseElement,
  type CollapsibleOptions,
  type CollapsibleState,
  setupCollapsible,
  setupDisclosureButton,
} from '@/features/chat/rendering/collapsible';

HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

function buildCollapsible(options?: CollapsibleOptions) {
  const wrapper = document.body.createDiv();
  const header = wrapper.createDiv({ text: 'Section' });
  const content = wrapper.createDiv({ text: 'Details' });
  const state: CollapsibleState = { isExpanded: false };
  setupCollapsible(wrapper, header, content, state, options);
  return { wrapper, header, content, state };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('collapsible', () => {
  describe('setupCollapsible', () => {
    it('makes the header a focusable button that starts collapsed', async () => {
      const { wrapper, content, state } = buildCollapsible();
      const header = within(wrapper).getByRole('button', { name: 'Section' });

      expect(header.tabIndex).toBe(0);
      expect(header.getAttribute('aria-expanded')).toBe('false');
      expect(state.isExpanded).toBe(false);
      expect(content.classList.contains('claudian-hidden')).toBe(true);
      expect(wrapper.classList.contains('expanded')).toBe(false);
      expect(await axe(wrapper)).toHaveNoViolations();
    });

    it('starts expanded when initiallyExpanded is true', () => {
      const { wrapper, content, state } = buildCollapsible({ initiallyExpanded: true });
      const header = within(wrapper).getByRole('button', { name: 'Section' });

      expect(state.isExpanded).toBe(true);
      expect(content.classList.contains('claudian-hidden')).toBe(false);
      expect(header.getAttribute('aria-expanded')).toBe('true');
      expect(wrapper.classList.contains('expanded')).toBe(true);
    });

    it('toggles on click', () => {
      const { wrapper, content, state } = buildCollapsible();
      const header = within(wrapper).getByRole('button', { name: 'Section' });

      fireEvent.click(header);
      expect(state.isExpanded).toBe(true);
      expect(wrapper.classList.contains('expanded')).toBe(true);
      expect(content.classList.contains('claudian-hidden')).toBe(false);
      expect(header.getAttribute('aria-expanded')).toBe('true');

      fireEvent.click(header);
      expect(state.isExpanded).toBe(false);
      expect(wrapper.classList.contains('expanded')).toBe(false);
      expect(content.classList.contains('claudian-hidden')).toBe(true);
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it.each([['Enter'], [' ']])('toggles aria-expanded on the %j key without a default action', (key) => {
      const { wrapper, state } = buildCollapsible();
      const header = within(wrapper).getByRole('button', { name: 'Section' });

      expect(fireEvent.keyDown(header, { key })).toBe(false);
      expect(header.getAttribute('aria-expanded')).toBe('true');
      expect(state.isExpanded).toBe(true);

      fireEvent.keyDown(header, { key });
      expect(header.getAttribute('aria-expanded')).toBe('false');
      expect(state.isExpanded).toBe(false);
    });

    it('does not toggle or swallow other keys', () => {
      const { wrapper, state } = buildCollapsible();
      const header = within(wrapper).getByRole('button', { name: 'Section' });

      expect(fireEvent.keyDown(header, { key: 'Tab' })).toBe(true);
      expect(header.getAttribute('aria-expanded')).toBe('false');
      expect(state.isExpanded).toBe(false);
    });

    it('calls onToggle with the new state', () => {
      const onToggle = jest.fn();
      const { wrapper } = buildCollapsible({ onToggle });
      const header = within(wrapper).getByRole('button', { name: 'Section' });

      fireEvent.click(header);
      fireEvent.keyDown(header, { key: 'Enter' });

      expect(onToggle.mock.calls).toEqual([[true], [false]]);
    });

    it('does not call onToggle during setup', () => {
      const onToggle = jest.fn();
      buildCollapsible({ initiallyExpanded: true, onToggle });

      expect(onToggle).not.toHaveBeenCalled();
    });

    it('labels the header with the base label and the available action', () => {
      const { wrapper } = buildCollapsible({ baseAriaLabel: 'Read: file.ts' });
      const header = within(wrapper).getByRole('button', { name: 'Read: file.ts - click to expand' });

      fireEvent.click(header);

      expect(within(wrapper).getByRole('button', { name: 'Read: file.ts - click to collapse' })).toBe(header);
    });

    it('labels an initially expanded header as collapsible', () => {
      const { wrapper } = buildCollapsible({ initiallyExpanded: true, baseAriaLabel: 'Tool' });

      expect(within(wrapper).getByRole('button', { name: 'Tool - click to collapse' })).toBeDefined();
    });

    it('leaves the header text as its accessible name without a base label', () => {
      const { wrapper } = buildCollapsible();

      expect(within(wrapper).getByRole('button', { name: 'Section' }).hasAttribute('aria-label')).toBe(false);
    });

    describe('onFirstExpand', () => {
      it('runs once, before the content is first shown, however often the section toggles', () => {
        const visibleWhenRun: boolean[] = [];
        const wrapper = document.body.createDiv();
        const header = wrapper.createDiv({ text: 'Section' });
        const content = wrapper.createDiv();
        const onFirstExpand = jest.fn(() => {
          visibleWhenRun.push(!content.classList.contains('claudian-hidden'));
        });
        setupCollapsible(wrapper, header, content, { isExpanded: false }, { onFirstExpand });
        expect(onFirstExpand).not.toHaveBeenCalled();

        fireEvent.click(header);
        fireEvent.click(header);
        fireEvent.keyDown(header, { key: 'Enter' });
        fireEvent.click(header);

        expect(onFirstExpand).toHaveBeenCalledTimes(1);
        expect(visibleWhenRun).toEqual([false]);
      });

      it('runs during setup when initially expanded and never again', () => {
        const onFirstExpand = jest.fn();
        const { header } = buildCollapsible({ initiallyExpanded: true, onFirstExpand });
        expect(onFirstExpand).toHaveBeenCalledTimes(1);

        fireEvent.click(header);
        fireEvent.click(header);

        expect(onFirstExpand).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('collapseElement', () => {
    it('collapses an expanded element', () => {
      const { wrapper, header, content, state } = buildCollapsible({ initiallyExpanded: true });

      collapseElement(wrapper, header, content, state);

      expect(state.isExpanded).toBe(false);
      expect(wrapper.classList.contains('expanded')).toBe(false);
      expect(content.classList.contains('claudian-hidden')).toBe(true);
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('is safe to call on an already collapsed element', () => {
      const { wrapper, header, content, state } = buildCollapsible();

      collapseElement(wrapper, header, content, state);

      expect(state.isExpanded).toBe(false);
      expect(content.classList.contains('claudian-hidden')).toBe(true);
    });
  });

  describe('setupDisclosureButton', () => {
    function buildDisclosure(onFirstExpand?: () => void, bodyId = 'details-body') {
      const root = document.body.createDiv();
      const button = root.createEl('button', { text: 'Show details' });
      const body = root.createDiv({ text: 'Details', attr: bodyId ? { id: bodyId } : {} });
      setupDisclosureButton(button, body, { onFirstExpand });
      return { root, button, body };
    }

    it('starts collapsed with the body hidden and controlled by the button', async () => {
      const { root, body } = buildDisclosure();
      const button = within(root).getByRole('button', { name: 'Show details' });

      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-controls')).toBe('details-body');
      expect(body.hidden).toBe(true);
      expect(await axe(root)).toHaveNoViolations();
    });

    it('shows and hides the body with aria-expanded as the button is clicked', () => {
      const { root, body } = buildDisclosure();
      const button = within(root).getByRole('button', { name: 'Show details' });

      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(body.hidden).toBe(false);
      expect(within(root).getByText('Details')).toBe(body);

      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(body.hidden).toBe(true);
    });

    it('omits aria-controls when the body has no id', () => {
      const { button } = buildDisclosure(undefined, '');

      expect(button.hasAttribute('aria-controls')).toBe(false);
    });

    it('runs onFirstExpand once, before the body is first shown', () => {
      const hiddenWhenRun: boolean[] = [];
      const bodyRef: { current?: HTMLElement } = {};
      const onFirstExpand = jest.fn(() => { hiddenWhenRun.push(bodyRef.current!.hasAttribute('hidden')); });
      const built = buildDisclosure(onFirstExpand);
      bodyRef.current = built.body;
      expect(onFirstExpand).not.toHaveBeenCalled();

      fireEvent.click(built.button);
      fireEvent.click(built.button);
      fireEvent.click(built.button);

      expect(onFirstExpand).toHaveBeenCalledTimes(1);
      expect(hiddenWhenRun).toEqual([true]);
    });
  });
});
