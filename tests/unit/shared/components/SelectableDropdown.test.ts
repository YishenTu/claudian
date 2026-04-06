import { createMockEl } from '@test/helpers/mockElement';

import { SelectableDropdown, type SelectableDropdownRenderOptions } from '@/shared/components/SelectableDropdown';

function createRenderOptions<T>(overrides: Partial<SelectableDropdownRenderOptions<T>> = {}): SelectableDropdownRenderOptions<T> {
  return {
    items: [] as T[],
    selectedIndex: 0,
    emptyText: 'No items',
    renderItem: jest.fn(),
    ...overrides,
  };
}

describe('SelectableDropdown', () => {
  let containerEl: any;
  let dropdown: SelectableDropdown<string>;

  beforeEach(() => {
    containerEl = createMockEl();
    dropdown = new SelectableDropdown(containerEl, {
      listClassName: 'dropdown-list',
      itemClassName: 'dropdown-item',
      emptyClassName: 'dropdown-empty',
    });
  });

  afterEach(() => {
    dropdown.destroy();
  });

  describe('initial state', () => {
    it('is not visible before render', () => {
      expect(dropdown.isVisible()).toBe(false);
    });

    it('has no element before render', () => {
      expect(dropdown.getElement()).toBeNull();
    });

    it('returns 0 for selectedIndex', () => {
      expect(dropdown.getSelectedIndex()).toBe(0);
    });

    it('returns null for selectedItem', () => {
      expect(dropdown.getSelectedItem()).toBeNull();
    });

    it('returns empty items array', () => {
      expect(dropdown.getItems()).toEqual([]);
    });
  });

  describe('render with items', () => {
    it('creates dropdown element and marks it visible', () => {
      dropdown.render(createRenderOptions({
        items: ['alpha', 'beta'],
        selectedIndex: 0,
        renderItem: (item, el) => el.setText(item),
      }));

      const el = dropdown.getElement();
      expect(el).not.toBeNull();
      expect(el!.hasClass('visible')).toBe(true);
    });

    it('stores items and exposes them via getItems', () => {
      dropdown.render(createRenderOptions({
        items: ['a', 'b', 'c'],
        renderItem: jest.fn(),
      }));

      expect(dropdown.getItems()).toEqual(['a', 'b', 'c']);
    });

    it('calls renderItem for each item', () => {
      const renderItem = jest.fn();
      dropdown.render(createRenderOptions({
        items: ['x', 'y'],
        renderItem,
      }));

      expect(renderItem).toHaveBeenCalledTimes(2);
      expect(renderItem).toHaveBeenCalledWith('x', expect.anything());
      expect(renderItem).toHaveBeenCalledWith('y', expect.anything());
    });

    it('marks selected item with selected class', () => {
      dropdown.render(createRenderOptions({
        items: ['a', 'b', 'c'],
        selectedIndex: 1,
        renderItem: jest.fn(),
      }));

      expect(dropdown.getSelectedIndex()).toBe(1);
      expect(dropdown.getSelectedItem()).toBe('b');
    });

    it('creates item elements with itemClassName', () => {
      dropdown.render(createRenderOptions({
        items: ['one'],
        renderItem: jest.fn(),
      }));

      const el = dropdown.getElement()!;
      const items = el.querySelectorAll('dropdown-item');
      expect(items.length).toBe(1);
    });
  });

  describe('render with empty items', () => {
    it('shows empty text when items array is empty', () => {
      dropdown.render(createRenderOptions({
        items: [],
        emptyText: 'Nothing here',
        renderItem: jest.fn(),
      }));

      const el = dropdown.getElement()!;
      const emptyEl = el.querySelector('dropdown-empty');
      expect(emptyEl).not.toBeNull();
      expect(emptyEl!.textContent).toBe('Nothing here');
    });
  });

  describe('getItemClass support', () => {
    it('applies string class to items', () => {
      dropdown.render(createRenderOptions({
        items: ['a'],
        renderItem: jest.fn(),
        getItemClass: () => 'extra-class',
      }));

      const el = dropdown.getElement()!;
      const items = el.querySelectorAll('dropdown-item');
      expect(items[0].hasClass('extra-class')).toBe(true);
    });

    it('applies array of classes to items', () => {
      dropdown.render(createRenderOptions({
        items: ['a'],
        renderItem: jest.fn(),
        getItemClass: () => ['cls-a', 'cls-b'],
      }));

      const el = dropdown.getElement()!;
      const items = el.querySelectorAll('dropdown-item');
      expect(items[0].hasClass('cls-a')).toBe(true);
      expect(items[0].hasClass('cls-b')).toBe(true);
    });

    it('handles undefined class gracefully', () => {
      dropdown.render(createRenderOptions({
        items: ['a'],
        renderItem: jest.fn(),
        getItemClass: () => undefined,
      }));

      const el = dropdown.getElement()!;
      const items = el.querySelectorAll('dropdown-item');
      expect(items.length).toBe(1);
    });
  });

  describe('click handler', () => {
    it('calls onItemClick when item is clicked', () => {
      const onItemClick = jest.fn();
      dropdown.render(createRenderOptions({
        items: ['a', 'b'],
        renderItem: jest.fn(),
        onItemClick,
      }));

      const el = dropdown.getElement()!;
      const items = el.querySelectorAll('dropdown-item');
      items[1].dispatchEvent({ type: 'click', target: items[1] } as any);

      expect(onItemClick).toHaveBeenCalledWith('b', 1, expect.anything());
    });

    it('updates selectedIndex on click', () => {
      dropdown.render(createRenderOptions({
        items: ['a', 'b', 'c'],
        selectedIndex: 0,
        renderItem: jest.fn(),
      }));

      const el = dropdown.getElement()!;
      const items = el.querySelectorAll('dropdown-item');
      items[2].dispatchEvent({ type: 'click', target: items[2] } as any);

      expect(dropdown.getSelectedIndex()).toBe(2);
    });
  });

  describe('hover handler', () => {
    it('calls onItemHover when item is hovered', () => {
      const onItemHover = jest.fn();
      dropdown.render(createRenderOptions({
        items: ['a', 'b'],
        renderItem: jest.fn(),
        onItemHover,
      }));

      const el = dropdown.getElement()!;
      const items = el.querySelectorAll('dropdown-item');
      items[0].dispatchEvent({ type: 'mouseenter' } as any);

      expect(onItemHover).toHaveBeenCalledWith('a', 0);
    });

    it('updates selectedIndex on hover', () => {
      dropdown.render(createRenderOptions({
        items: ['a', 'b', 'c'],
        selectedIndex: 0,
        renderItem: jest.fn(),
      }));

      const el = dropdown.getElement()!;
      const items = el.querySelectorAll('dropdown-item');
      items[1].dispatchEvent({ type: 'mouseenter' } as any);

      expect(dropdown.getSelectedIndex()).toBe(1);
    });
  });

  describe('moveSelection', () => {
    it('moves selection down', () => {
      dropdown.render(createRenderOptions({
        items: ['a', 'b', 'c'],
        selectedIndex: 0,
        renderItem: jest.fn(),
      }));

      dropdown.moveSelection(1);
      expect(dropdown.getSelectedIndex()).toBe(1);
    });

    it('moves selection up', () => {
      dropdown.render(createRenderOptions({
        items: ['a', 'b', 'c'],
        selectedIndex: 2,
        renderItem: jest.fn(),
      }));

      dropdown.moveSelection(-1);
      expect(dropdown.getSelectedIndex()).toBe(1);
    });

    it('clamps at 0 when moving up past beginning', () => {
      dropdown.render(createRenderOptions({
        items: ['a', 'b'],
        selectedIndex: 0,
        renderItem: jest.fn(),
      }));

      dropdown.moveSelection(-1);
      expect(dropdown.getSelectedIndex()).toBe(0);
    });

    it('clamps at max index when moving down past end', () => {
      dropdown.render(createRenderOptions({
        items: ['a', 'b'],
        selectedIndex: 1,
        renderItem: jest.fn(),
      }));

      dropdown.moveSelection(1);
      expect(dropdown.getSelectedIndex()).toBe(1);
    });
  });

  describe('updateSelection', () => {
    it('adds selected class to current item and removes from others', () => {
      dropdown.render(createRenderOptions({
        items: ['a', 'b', 'c'],
        selectedIndex: 0,
        renderItem: jest.fn(),
      }));

      dropdown.moveSelection(2);

      const el = dropdown.getElement()!;
      const items = el.querySelectorAll('dropdown-item');
      expect(items[0].hasClass('selected')).toBe(false);
      expect(items[1].hasClass('selected')).toBe(false);
      expect(items[2].hasClass('selected')).toBe(true);
    });
  });

  describe('hide', () => {
    it('removes visible class from dropdown', () => {
      dropdown.render(createRenderOptions({
        items: ['a'],
        renderItem: jest.fn(),
      }));

      expect(dropdown.isVisible()).toBe(true);
      dropdown.hide();
      expect(dropdown.isVisible()).toBe(false);
    });

    it('is safe to call before render', () => {
      expect(() => dropdown.hide()).not.toThrow();
    });
  });

  describe('destroy', () => {
    it('removes the dropdown element', () => {
      dropdown.render(createRenderOptions({
        items: ['a'],
        renderItem: jest.fn(),
      }));

      expect(dropdown.getElement()).not.toBeNull();
      dropdown.destroy();
      expect(dropdown.getElement()).toBeNull();
    });

    it('is safe to call before render', () => {
      expect(() => dropdown.destroy()).not.toThrow();
    });

    it('is safe to call multiple times', () => {
      dropdown.render(createRenderOptions({ items: ['a'], renderItem: jest.fn() }));
      dropdown.destroy();
      expect(() => dropdown.destroy()).not.toThrow();
    });
  });

  describe('re-render', () => {
    it('reuses existing dropdown element on subsequent renders', () => {
      dropdown.render(createRenderOptions({
        items: ['a'],
        renderItem: jest.fn(),
      }));

      const firstEl = dropdown.getElement();

      dropdown.render(createRenderOptions({
        items: ['b', 'c'],
        renderItem: jest.fn(),
      }));

      expect(dropdown.getElement()).toBe(firstEl);
    });

    it('clears old items and renders new ones', () => {
      dropdown.render(createRenderOptions({
        items: ['a', 'b'],
        renderItem: jest.fn(),
      }));

      dropdown.render(createRenderOptions({
        items: ['x'],
        renderItem: jest.fn(),
      }));

      expect(dropdown.getItems()).toEqual(['x']);
    });
  });

  describe('fixed className', () => {
    it('applies fixedClassName when fixed option is true', () => {
      const fixedDropdown = new SelectableDropdown<string>(containerEl, {
        listClassName: 'dropdown-list',
        itemClassName: 'dropdown-item',
        emptyClassName: 'dropdown-empty',
        fixed: true,
        fixedClassName: 'dropdown-fixed',
      });

      fixedDropdown.render(createRenderOptions({
        items: ['a'],
        renderItem: jest.fn(),
      }));

      const el = fixedDropdown.getElement()!;
      expect(el.hasClass('dropdown-list')).toBe(true);
      expect(el.hasClass('dropdown-fixed')).toBe(true);

      fixedDropdown.destroy();
    });

    it('does not apply fixedClassName when fixed is false', () => {
      const nonFixedDropdown = new SelectableDropdown<string>(containerEl, {
        listClassName: 'dropdown-list',
        itemClassName: 'dropdown-item',
        emptyClassName: 'dropdown-empty',
        fixed: false,
        fixedClassName: 'dropdown-fixed',
      });

      nonFixedDropdown.render(createRenderOptions({
        items: ['a'],
        renderItem: jest.fn(),
      }));

      const el = nonFixedDropdown.getElement()!;
      expect(el.hasClass('dropdown-list')).toBe(true);
      expect(el.hasClass('dropdown-fixed')).toBe(false);

      nonFixedDropdown.destroy();
    });
  });
});
