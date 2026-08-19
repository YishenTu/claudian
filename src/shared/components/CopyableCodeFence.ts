import { setIcon } from 'obsidian';

export interface CopyableCodeFenceOptions {
  readonly copiedLabel?: string;
  readonly copyLabel: string;
}

const COPY_FEEDBACK_DURATION_MS = 1_500;

function bindCopyFeedback(
  target: HTMLElement,
  text: () => string,
  renderCopied: () => void,
  renderIdle: () => void,
): void {
  let feedbackTimeout: number | null = null;
  target.addEventListener('click', () => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(text()).then(() => {
      if (feedbackTimeout !== null) {
        window.clearTimeout(feedbackTimeout);
      }
      renderCopied();
      feedbackTimeout = window.setTimeout(() => {
        renderIdle();
        feedbackTimeout = null;
      }, COPY_FEEDBACK_DURATION_MS);
    }).catch(() => undefined);
  });
}

/** Builds the same plain code-fence surface used by rendered chat messages. */
export function renderCopyableCodeFence(
  container: HTMLElement,
  text: string,
  options: CopyableCodeFenceOptions,
): HTMLElement {
  const wrapper = container.createDiv({ cls: 'claudian-code-wrapper' });
  const pre = wrapper.createEl('pre');
  pre.createEl('code', { text });

  const copyButton = wrapper.createEl('button', {
    attr: { type: 'button' },
    cls: 'copy-code-button',
  });
  copyButton.setAttribute('aria-label', options.copyLabel);
  copyButton.title = options.copyLabel;

  const renderIdle = (): void => {
    copyButton.empty();
    setIcon(copyButton, 'copy');
    copyButton.classList.remove('copied');
  };
  renderIdle();
  bindCopyFeedback(
    copyButton,
    () => text,
    () => {
      copyButton.empty();
      copyButton.setText(options.copiedLabel ?? 'Copied!');
      copyButton.classList.add('copied');
    },
    renderIdle,
  );
  return wrapper;
}

/** Adopts an Obsidian-rendered `pre` and preserves its native copy button. */
export function enhanceRenderedCodeFence(pre: HTMLPreElement): HTMLElement {
  if (pre.parentElement?.classList.contains('claudian-code-wrapper')) {
    return pre.parentElement;
  }

  const wrapper = createDiv({ cls: 'claudian-code-wrapper' });
  pre.parentElement?.insertBefore(wrapper, pre);
  wrapper.appendChild(pre);

  const code = pre.querySelector<HTMLElement>('code[class*="language-"]');
  const language = code?.className.match(/language-(\w+)/)?.[1];
  if (code && language) {
    wrapper.classList.add('has-language');
    const label = createSpan({
      cls: 'claudian-code-lang-label',
      text: language,
    });
    wrapper.appendChild(label);
    bindCopyFeedback(
      label,
      () => code.textContent ?? '',
      () => label.setText('Copied!'),
      () => label.setText(language),
    );
  }

  const copyButton = pre.querySelector<HTMLElement>('.copy-code-button');
  if (copyButton) wrapper.appendChild(copyButton);
  return wrapper;
}
