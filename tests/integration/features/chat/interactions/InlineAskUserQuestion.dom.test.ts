/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { InlineAskUserQuestion } from '@/features/chat/interactions/InlineAskUserQuestion';
import { SessionInteractions } from '@/features/chat/interactions/SessionInteractions';
import { NavigationController } from '@/features/chat/navigation/NavigationController';
import { setLocale } from '@/i18n/i18n';

beforeEach(() => document.body.replaceChildren());

it.each([
  ['ArrowDown', 'Always allow'],
  ['ArrowUp', 'Allow once'],
])('keeps permission selection aligned with native focus before %s', (key, expected) => {
  const resolve = vi.fn();
  const panel = new InlineAskUserQuestion(document.body.createDiv(), {
    questions: [{
      question: 'Allow this command?', header: 'Permission',
      options: ['Deny', 'Allow once', 'Always allow'].map(label => ({ label })),
    }],
  }, resolve, undefined, { immediateSelect: true, showCustomInput: false });
  panel.render();
  const choice = within(document.body).getByRole('button', { name: 'Always allow' });
  // Native Tab navigation focuses choices without clicking them.
  choice.focus();
  fireEvent.keyDown(choice, { key });
  const root = within(document.body).getByRole('region', { name: 'Question' });
  expect(document.activeElement).toBe(root);
  fireEvent.keyDown(root, { key: 'Enter' });
  expect(resolve).toHaveBeenCalledWith({ 'Allow this command?': expected });
});

it('checks the multi-select custom answer as soon as text is typed', () => {
  const panel = new InlineAskUserQuestion(document.body.createDiv(), {
    questions: [{ question: 'Which checks?', isOther: true, multiSelect: true, options: [{ label: 'Lint' }] }],
  }, vi.fn());
  panel.render();
  const input = within(document.body).getByRole('textbox', { name: 'Which checks?' });
  const customRow = input.closest('.claudian-ask-custom-item')!;

  fireEvent.input(input, { target: { value: 'Typecheck' } });
  expect(customRow.querySelector('.claudian-ask-check')?.classList.contains('is-checked')).toBe(true);

  fireEvent.input(input, { target: { value: '' } });
  expect(customRow.querySelector('.claudian-ask-check')?.classList.contains('is-checked')).toBe(false);
});

it('submits a __proto__ question id as an own answer key with exact JSON', async () => {
  const resolve = vi.fn();
  const parent = document.body.createDiv();
  const panel = new InlineAskUserQuestion(parent, {
    questions: [{ id: '__proto__', question: 'Color?', options: [{ label: 'Blue' }, { label: 'Red' }] }],
  }, resolve, undefined, { showCustomInput: false });
  panel.render();
  const region = within(parent).getByRole('region', { name: 'Question' });

  fireEvent.click(within(region).getByRole('button', { name: 'Blue' }));
  fireEvent.click(within(region).getByRole('button', { name: 'Submit' }));
  // The review tab is the displayed confirmation of the chosen answer.
  expect(within(region).getByText('Blue')).toBeDefined();
  expect(await axe(region)).toHaveNoViolations();
  fireEvent.click(within(region).getByRole('button', { name: 'Submit answers' }));

  expect(resolve).toHaveBeenCalledTimes(1);
  const payload = resolve.mock.calls[0][0] as Record<string, unknown>;
  expect(Object.getOwnPropertyDescriptor(payload, '__proto__')).toMatchObject({ value: 'Blue', enumerable: true });
  expect(JSON.stringify(payload)).toBe('{"__proto__":"Blue"}');
  parent.remove();
});

it('immediately submits the native option value under an own __proto__ question-text key', () => {
  const resolve = vi.fn();
  const panel = new InlineAskUserQuestion(document.body.createDiv(), {
    questions: [{ question: '__proto__', options: [{ label: 'Blue', value: 'blue-id' }, { label: 'Red', value: 'red-id' }] }],
  }, resolve, undefined, { immediateSelect: true, showCustomInput: false });
  panel.render();

  fireEvent.click(within(document.body).getByRole('button', { name: 'Blue' }));

  expect(resolve).toHaveBeenCalledTimes(1);
  const payload = resolve.mock.calls[0][0] as Record<string, unknown>;
  expect(Object.getOwnPropertyDescriptor(payload, '__proto__')).toMatchObject({ value: 'blue-id', enumerable: true });
  expect(JSON.stringify(payload)).toBe('{"__proto__":"blue-id"}');
});

it('keeps multi-select and custom answers together in one own __proto__ reviewable array', () => {
  const resolve = vi.fn();
  const parent = document.body.createDiv();
  const panel = new InlineAskUserQuestion(parent, {
    questions: [{ id: '__proto__', question: 'Color?', multiSelect: true, isOther: true, options: [{ label: 'Blue' }, { label: 'Red' }] }],
  }, resolve);
  panel.render();
  const region = within(parent).getByRole('region', { name: 'Question' });

  fireEvent.click(within(region).getByRole('button', { name: 'Blue' }));
  fireEvent.click(within(region).getByRole('button', { name: 'Red' }));
  fireEvent.input(within(region).getByRole('textbox', { name: 'Color?' }), { target: { value: 'Green' } });
  fireEvent.click(within(region).getByRole('button', { name: 'Submit' }));
  expect(within(region).getByText('Blue, Red, Green')).toBeDefined();
  fireEvent.click(within(region).getByRole('button', { name: 'Submit answers' }));

  expect(resolve).toHaveBeenCalledTimes(1);
  const payload = resolve.mock.calls[0][0] as Record<string, unknown>;
  expect(Object.getOwnPropertyDescriptor(payload, '__proto__')).toMatchObject({ value: ['Blue', 'Red', 'Green'], enumerable: true });
  expect(JSON.stringify(payload)).toBe('{"__proto__":["Blue","Red","Green"]}');
  parent.remove();
});

it('delivers a custom scalar answer through the async onSubmit path', async () => {
  const resolve = vi.fn();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const parent = document.body.createDiv();
  const panel = new InlineAskUserQuestion(parent, {
    questions: [{ question: 'Color?', isOther: true, options: [{ label: 'Blue' }] }],
  }, resolve, undefined, { onSubmit });
  panel.render();
  const region = within(parent).getByRole('region', { name: 'Question' });

  fireEvent.input(within(region).getByRole('textbox', { name: 'Color?' }), { target: { value: 'Green' } });
  fireEvent.click(within(region).getByRole('button', { name: 'Submit' }));
  fireEvent.click(within(region).getByRole('button', { name: 'Submit answers' }));

  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit.mock.calls[0][0]).toEqual({ 'Color?': 'Green' });
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
  expect(resolve.mock.calls[0][0]).toBe(onSubmit.mock.calls[0][0]);
  parent.remove();
});


it('localizes question chrome while submitting provider-authored options unchanged', async () => {
  setLocale('zh-CN');
  const resolve = vi.fn();
  const parent = document.body.createDiv();
  const panel = new InlineAskUserQuestion(parent, {
    questions: [{ question: 'Which checks?', isOther: true, options: [{ label: 'Lint' }] }],
  }, resolve);
  try {
    panel.render();
    const region = within(parent).getByRole('region', { name: '问题' });
    expect(within(region).getByPlaceholderText('输入你的回答…')).toBeDefined();
    fireEvent.click(within(region).getByRole('button', { name: 'Lint' }));
    fireEvent.click(within(region).getByRole('button', { name: '提交' }));
    expect(within(region).getByText('准备提交回答了吗？')).toBeDefined();
    expect(within(region).getByRole('button', { name: '取消' })).toBeDefined();
    expect(await axe(region)).toHaveNoViolations();
    fireEvent.click(within(region).getByRole('button', { name: '提交回答' }));
    expect(resolve).toHaveBeenCalledWith({ 'Which checks?': 'Lint' });
  } finally {
    panel.destroy();
    parent.remove();
    setLocale('en');
  }
});


it('localizes plugin-owned approval prompts and returns stable decisions', async () => {
  setLocale('zh-CN');
  const parent = document.body.createDiv();
  const interactions = new SessionInteractions({ getPromptParentEl: () => parent });
  try {
    const decision = interactions.requestApproval('approval', 'Bash', {}, 'Execute: npm test', { agentID: 'agent-1' });
    const region = within(parent).getByRole('region', { name: '需要授权' });
    expect(within(region).getByText('允许此操作吗？')).toBeDefined();
    expect(within(region).getByRole('region', { name: 'Bash 授权详情' }).textContent).toBe('Execute: npm test');
    expect(within(region).getByText('代理：agent-1')).toBeDefined();
    expect(within(region).getByRole('button', { name: '拒绝' })).toBeDefined();
    expect(within(region).getByRole('button', { name: '始终允许' })).toBeDefined();
    expect(await axe(region)).toHaveNoViolations();
    fireEvent.click(within(region).getByRole('button', { name: '允许一次' }));
    await expect(decision).resolves.toBe('allow');
  } finally {
    interactions.dismiss('approval');
    parent.remove();
    setLocale('en');
  }
});


it.each(['w', 's', 'i'])('leaves %s in a custom question answer to the native input', async key => {
  const messages = document.body.createDiv();
  const composer = document.body.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  const navigation = new NavigationController({ getMessagesEl: () => messages, getInputEl: () => composer,
    getSettings: () => ({ scrollUpKey: 'w', scrollDownKey: 's', focusInputKey: 'i' }), isStreaming: () => true });
  const resolve = vi.fn();
  const panel = new InlineAskUserQuestion(messages, {
    questions: [{ question: 'Which task?', isOther: true, options: [{ label: 'Default' }] }],
  }, resolve);
  navigation.initialize();
  panel.render();
  try {
    const region = within(messages).getByRole('region', { name: 'Question' });
    await waitFor(() => expect(document.activeElement).toBe(region));
    const input = within(region).getByRole('textbox', { name: 'Which task?' });
    input.focus();
    messages.scrollTop = 100;
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(messages.scrollTop).toBe(100);
    // Input is the browser's editing event boundary; the actual question owner collects the answer.
    fireEvent.input(input, { target: { value: 'wise' } });
    expect(await axe(region)).toHaveNoViolations();
    fireEvent.click(within(region).getByRole('button', { name: 'Submit' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Submit answers' }));
    expect(resolve).toHaveBeenCalledWith({ 'Which task?': 'wise' });
    messages.focus();
    fireEvent.keyDown(messages, { key: 'i' });
    expect(document.activeElement).toBe(composer);
  } finally { navigation.dispose(); panel.disposePresentation(); messages.remove(); composer.remove(); }
});


it.each(['textarea', 'select', 'contenteditable'] as const)('leaves navigation shortcuts inside an embedded %s control alone', kind => {
  const messages = document.body.createDiv();
  const composer = document.body.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  const navigation = new NavigationController({ getMessagesEl: () => messages, getInputEl: () => composer,
    getSettings: () => ({ scrollUpKey: 'w', scrollDownKey: 's', focusInputKey: 'i' }), isStreaming: () => false });
  const editor = messages.createEl(kind === 'contenteditable' ? 'div' : kind, {
    attr: { 'aria-label': 'Embedded editor', tabindex: '0' },
  });
  if (kind === 'contenteditable') editor.setAttribute('contenteditable', 'true');
  const target = kind === 'contenteditable' ? editor.createSpan({ text: 'Editable child' }) : editor;
  navigation.initialize();
  try {
    editor.focus();
    messages.scrollTop = 100;
    for (const key of ['w', 's', 'i']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(editor);
      expect(messages.scrollTop).toBe(100);
    }
  } finally { navigation.dispose(); messages.remove(); composer.remove(); }
});
