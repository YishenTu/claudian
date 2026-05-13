import { createMockEl } from '@test/helpers/mockElement';

import {
  collapseElement,
  type CollapsibleState,
  setupCollapsible,
} from '@/features/chat/rendering/collapsible';

describe('collapsible', () => {
  let wrapper: ReturnType<typeof createMockEl>;
  let header: ReturnType<typeof createMockEl>;
  let content: ReturnType<typeof createMockEl>;
  let state: CollapsibleState;

  beforeEach(() => {
    wrapper = createMockEl();
    header = createMockEl();
    content = createMockEl();
    state = { isExpanded: false };
  });

  describe('setupCollapsible', () => {
    it('should start collapsed by default', () => {
      setupCollapsible(wrapper, header, content, state);

      expect(state.isExpanded).toBe(false);
      expect(content.hasClass('claudian-hidden')).toBe(true);
      expect(header.getAttribute('aria-expanded')).toBe('false');
      expect(wrapper.hasClass('expanded')).toBe(false);
    });

    it('should start expanded when initiallyExpanded is true', () => {
      setupCollapsible(wrapper, header, content, state, { initiallyExpanded: true });

      expect(state.isExpanded).toBe(true);
      expect(content.hasClass('claudian-hidden')).toBe(false);
      expect(header.getAttribute('aria-expanded')).toBe('true');
      expect(wrapper.hasClass('expanded')).toBe(true);
    });

    it('should toggle on click', () => {
      setupCollapsible(wrapper, header, content, state);

      const clickHandlers = header._eventListeners.get('click') || [];
      expect(clickHandlers.length).toBe(1);

      // Expand
      clickHandlers[0]();
      expect(state.isExpanded).toBe(true);
      expect(wrapper.hasClass('expanded')).toBe(true);
      expect(content.hasClass('claudian-hidden')).toBe(false);
      expect(header.getAttribute('aria-expanded')).toBe('true');

      // Collapse
      clickHandlers[0]();
      expect(state.isExpanded).toBe(false);
      expect(wrapper.hasClass('expanded')).toBe(false);
      expect(content.hasClass('claudian-hidden')).toBe(true);
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('should toggle on Enter key', () => {
      setupCollapsible(wrapper, header, content, state);

      const keydownHandlers = header._eventListeners.get('keydown') || [];
      const event = { key: 'Enter', preventDefault: jest.fn() };
      keydownHandlers[0](event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(state.isExpanded).toBe(true);
    });

    it('should toggle on Space key', () => {
      setupCollapsible(wrapper, header, content, state);

      const keydownHandlers = header._eventListeners.get('keydown') || [];
      const event = { key: ' ', preventDefault: jest.fn() };
      keydownHandlers[0](event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(state.isExpanded).toBe(true);
    });

    it('should not toggle on other keys', () => {
      setupCollapsible(wrapper, header, content, state);

      const keydownHandlers = header._eventListeners.get('keydown') || [];
      const event = { key: 'Tab', preventDefault: jest.fn() };
      keydownHandlers[0](event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(state.isExpanded).toBe(false);
    });

    it('should call onToggle callback with new state', () => {
      const onToggle = jest.fn();

      setupCollapsible(wrapper, header, content, state, { onToggle });

      const clickHandlers = header._eventListeners.get('click') || [];

      clickHandlers[0]();
      expect(onToggle).toHaveBeenCalledWith(true);

      clickHandlers[0]();
      expect(onToggle).toHaveBeenCalledWith(false);
    });

    it('should set aria-label with baseAriaLabel', () => {
      setupCollapsible(wrapper, header, content, state, { baseAriaLabel: 'Read: file.ts' });

      expect(header.getAttribute('aria-label')).toBe('Read: file.ts - click to expand');

      // Expand and check label changes
      const clickHandlers = header._eventListeners.get('click') || [];
      clickHandlers[0]();
      expect(header.getAttribute('aria-label')).toBe('Read: file.ts - click to collapse');
    });

    it('should set aria-label for initially expanded with baseAriaLabel', () => {
      setupCollapsible(wrapper, header, content, state, {
        initiallyExpanded: true,
        baseAriaLabel: 'Tool',
      });

      expect(header.getAttribute('aria-label')).toBe('Tool - click to collapse');
    });

    it('should not set aria-label without baseAriaLabel', () => {
      setupCollapsible(wrapper, header, content, state);

      expect(header.getAttribute('aria-label')).toBeNull();
    });
  });

  describe('collapseElement', () => {
    it('should collapse an expanded element', () => {
      state.isExpanded = true;
      wrapper.addClass('expanded');
      content.style.display = 'block';
      header.setAttribute('aria-expanded', 'true');

      collapseElement(wrapper, header, content, state);

      expect(state.isExpanded).toBe(false);
      expect(wrapper.hasClass('expanded')).toBe(false);
      expect(content.hasClass('claudian-hidden')).toBe(true);
      expect(header.getAttribute('aria-expanded')).toBe('false');
    });

    it('should be safe to call on already collapsed element', () => {
      collapseElement(wrapper, header, content, state);

      expect(state.isExpanded).toBe(false);
      expect(content.hasClass('claudian-hidden')).toBe(true);
    });
  });
});
