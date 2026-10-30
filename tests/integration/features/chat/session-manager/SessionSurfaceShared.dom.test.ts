/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { fireEvent, screen } from '@testing-library/dom';
import { Menu } from 'obsidian';
import type { Mock } from 'vitest';

import { createSessionHeaderMenuAction } from '@/features/chat/session-manager/SessionSurfaceShared';



interface MockMenu {
  showAtMouseEvent: Mock;
  showAtPosition: Mock;
  hide: Mock;
}

const menus = (): MockMenu[] => (Menu as unknown as { instances: MockMenu[] }).instances;

function renderOptionsButton(): HTMLButtonElement {
  document.body.replaceChildren();
  const header = document.body.createDiv();
  createSessionHeaderMenuAction(header, 'ellipsis', 'Session options', (anchor, event) => {
    const menu = new Menu();
    if (event) menu.showAtMouseEvent(event);
    else menu.showAtPosition({ x: 0, y: 0 }, anchor.ownerDocument);
    return menu;
  });
  return screen.getByRole('button', { name: 'Session options' }) as HTMLButtonElement;
}

/** A pointer press and its click; `hidesMenu` is Obsidian closing the open menu for a press outside it. */
function press(button: HTMLElement, hidesMenu?: MockMenu): void {
  fireEvent.pointerDown(button);
  hidesMenu?.hide();
  fireEvent.click(button, { detail: 1 });
}

beforeEach(() => {
  menus().length = 0;
});

describe('menu buttons', () => {
  it('closes the open menu when pressed again, whether or not Obsidian already hid it for the press', async () => {
    const button = renderOptionsButton();
    expect(button.getAttribute('aria-haspopup')).toBe('menu');

    press(button);
    expect(menus()).toHaveLength(1);
    expect(menus()[0].showAtMouseEvent).toHaveBeenCalled();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect((await axe(document.body)).violations).toEqual([]);

    // Obsidian hides the menu on the press before the click reaches the button.
    press(button, menus()[0]);
    expect(menus()).toHaveLength(1);
    expect(button.hasAttribute('aria-expanded')).toBe(false);

    press(button);
    expect(menus()).toHaveLength(2);

    // A menu still open at the click is closed by it.
    press(button);
    expect(menus()).toHaveLength(2);
    expect(menus()[1].hide).toHaveBeenCalled();
    expect(button.hasAttribute('aria-expanded')).toBe(false);

    press(button);
    expect(menus()).toHaveLength(3);
  });

  it('reopens after the menu closed some other way, and opens under the button from the keyboard', () => {
    const button = renderOptionsButton();
    press(button);
    // An item was chosen, or the user clicked elsewhere.
    fireEvent.pointerDown(document.body);
    menus()[0].hide();

    press(button);
    expect(menus()).toHaveLength(2);
    menus()[1].hide();

    // Keyboard activation clicks without a press.
    fireEvent.click(button);
    expect(menus()).toHaveLength(3);
    expect(menus()[2].showAtPosition).toHaveBeenCalled();
  });
});
