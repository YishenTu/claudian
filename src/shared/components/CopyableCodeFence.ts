import { t } from '@/i18n/i18n';

const COPY_FEEDBACK_DURATION_MS = 1_500;

/** Copies `text()` on click and shows copied feedback until the shared timeout elapses. */
export function bindCopyFeedback(
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
    const copyLabel = t('chat.codeBlock.copyAriaLabel', { language });
    const copied = t('chat.codeBlock.copied');
    // The accessible name keeps the visible language (label-in-name); the status announces feedback.
    const label = wrapper.createEl('button', {
      cls: 'claudian-code-lang-label',
      text: language,
      attr: { type: 'button', 'aria-label': copyLabel },
    });
    const status = wrapper.createSpan({ cls: 'claudian-code-copy-status', attr: { role: 'status' } });
    bindCopyFeedback(
      label,
      () => code.textContent ?? '',
      () => {
        label.setText(copied);
        label.setAttribute('aria-label', copied);
        status.setText(copied);
      },
      () => {
        label.setText(language);
        label.setAttribute('aria-label', copyLabel);
        status.setText('');
      },
    );
  }

  const copyButton = pre.querySelector<HTMLElement>('.copy-code-button');
  if (copyButton) wrapper.appendChild(copyButton);
  return wrapper;
}
