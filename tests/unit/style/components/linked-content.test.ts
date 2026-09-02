import fs from 'fs';
import path from 'path';

const messagesCss = fs.readFileSync(
  path.join(process.cwd(), 'src/style/components/messages.css'),
  'utf8',
);
const contextTrayCss = fs.readFileSync(
  path.join(process.cwd(), 'src/style/components/context-tray.css'),
  'utf8',
);
const composerDropdownCss = fs.readFileSync(
  path.join(process.cwd(), 'src/style/components/composer-dropdown.css'),
  'utf8',
);

describe('Linked content styles', () => {
  it('sizes the picker from the available chat-panel container width', () => {
    expect(messagesCss).toMatch(/\.claudian-welcome-linked-content\s*{[^}]*position:\s*relative;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*box-sizing:\s*border-box;/);
    expect(messagesCss).toMatch(/\.claudian-linked-content-picker\.claudian-composer-dropdown\.is-visible\s*{[^}]*position:\s*absolute;[^}]*inset-inline:\s*0;[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*box-sizing:\s*border-box;/);
  });

  it('renders the selected value as a chromeless inline editor trigger', () => {
    const selectorRule = messagesCss.match(/\.claudian-linked-content-selector\s*{[^}]*}/)?.[0];
    expect(selectorRule).toMatch(/padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;[^}]*color:\s*var\(--text-muted\)/);
    expect(selectorRule).not.toContain('border-bottom');
    expect(messagesCss).toMatch(/\.claudian-linked-content-selector-row\.is-editing\s+\.claudian-linked-content-selector\s*{[^}]*display:\s*none;/);
    expect(messagesCss).toMatch(/\.claudian-linked-content-selector:focus-visible\s*{[^}]*outline:\s*none;/);
    expect(messagesCss).toMatch(/\.claudian-linked-content-picker-search\s*{[^}]*width:\s*auto;[^}]*max-width:\s*100%;[^}]*border:\s*0;[^}]*border-bottom:\s*1px solid var\(--interactive-accent\);[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/);
    expect(messagesCss).toMatch(/\.claudian-welcome-linked-content\s+\.claudian-linked-content-selector-row\s*>\s*input\[type='text'\]\.claudian-linked-content-picker-search[^}]*appearance:\s*none;[^}]*min-height:\s*0;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*border-bottom:\s*1px solid var\(--interactive-accent\);[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/);
    expect(messagesCss).not.toContain('.claudian-linked-content-picker-status');
    expect(messagesCss).not.toContain('.claudian-linked-content-picker-retry');
  });

  it('truncates a long welcome selector only at its right edge', () => {
    const selectorRule = messagesCss.match(/\.claudian-linked-content-selector\s*{[^}]*}/)?.[0];
    expect(selectorRule).toMatch(/display:\s*block;/);
    expect(selectorRule).toMatch(/flex:\s*0\s+1\s+auto;/);
    expect(selectorRule).toMatch(/direction:\s*ltr;/);
    expect(selectorRule).toMatch(/text-align:\s*left;/);
    expect(selectorRule).toMatch(/text-overflow:\s*ellipsis;/);
  });

  it('inherits menu and selected-item visuals from the shared composer dropdown', () => {
    expect(composerDropdownCss).toMatch(/\.claudian-composer-dropdown\s*{[^}]*background:\s*var\(--background-secondary\);[^}]*border:/);
    expect(composerDropdownCss).toMatch(/\.claudian-composer-dropdown-item:hover,[\s\S]*?\.claudian-composer-dropdown-item\.is-selected\s*{[^}]*background:\s*var\(--background-modifier-hover\);/);
  });

  it('keeps picker items transparent until hover or selection', () => {
    expect(messagesCss).toMatch(/\.claudian-linked-content-picker\s+button\.claudian-linked-content-picker-option\s*{[^}]*background:\s*transparent;/);
    expect(messagesCss).toMatch(/\.claudian-linked-content-picker\s+button\.claudian-linked-content-picker-option:hover,[\s\S]*?\.claudian-linked-content-picker\s+button\.claudian-linked-content-picker-option\.is-selected\s*{[^}]*background:\s*var\(--background-modifier-hover\);/);
  });

  it('separates picker item names from their path descriptions', () => {
    expect(messagesCss).toMatch(/\.claudian-linked-content-picker-option-path::before\s*{[^}]*content:\s*' ';/);
  });

  it('prevents Obsidian themes from restoring selector background chrome', () => {
    expect(messagesCss).toMatch(/\.claudian-welcome-linked-content\s+\.claudian-linked-content-selector-row\s*>\s*button\.claudian-linked-content-selector[^}]*min-width:\s*0;[^}]*width:\s*auto;[^}]*padding:\s*0;[^}]*background:\s*transparent;[^}]*outline:\s*none;/);
    expect(messagesCss).not.toContain('!important');
  });

  it('styles Linked content and Missing content as context-tray modifiers', () => {
    expect(contextTrayCss).toMatch(/\.claudian-context-chip--content\s*{/);
    expect(contextTrayCss).toMatch(/\.claudian-context-chip--missing\s*{/);
  });

  it('balances locked Linked content when the remove control is absent', () => {
    expect(contextTrayCss).toMatch(/\.claudian-context-chip--content:not\(:has\(\.claudian-context-chip-remove\)\)\s*{[^}]*padding-right:\s*10px;/);
  });

  it('keeps context removal controls muted and chromeless until interaction', () => {
    expect(contextTrayCss).toMatch(/\.claudian-context-chip-remove\s*{[^}]*background:\s*transparent;[^}]*color:\s*var\(--text-muted\);/);
    expect(contextTrayCss).toMatch(/\.claudian-context-chip\s*>\s*button\.claudian-context-chip-remove,[\s\S]*?\.claudian-context-chip\s*>\s*button\.claudian-context-chip-remove:active\s*{[^}]*background:\s*transparent;[^}]*color:\s*var\(--text-muted\);/);
    expect(contextTrayCss).toMatch(/\.claudian-context-chip\s*>\s*button\.claudian-context-chip-remove:hover,[\s\S]*?\.claudian-context-chip\s*>\s*button\.claudian-context-chip-remove:focus-visible\s*{[^}]*background:\s*transparent;[^}]*color:\s*var\(--text-normal\);/);
  });
});
