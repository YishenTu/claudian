import { Setting } from 'obsidian';

import { getEnvironmentReviewKeysForScope } from '../../../core/providers/providerEnvironment';
import type { EnvironmentScope } from '../../../core/types/settings';
import type ClaudianPlugin from '../../../main';
import { EnvSnippetManager } from './EnvSnippetManager';

interface EnvironmentSettingsSectionOptions {
  container: HTMLElement;
  plugin: ClaudianPlugin;
  scope: EnvironmentScope;
  heading?: string;
  name: string;
  desc: string;
  placeholder: string;
  renderCustomContextLimits?: (container: HTMLElement) => void;
}

export function renderEnvironmentSettingsSection(
  options: EnvironmentSettingsSectionOptions,
): void {
  const {
    container,
    plugin,
    scope,
    heading,
    name,
    desc,
    placeholder,
    renderCustomContextLimits,
  } = options;

  if (heading) {
    new Setting(container).setName(heading).setHeading();
  }

  let envTextarea: HTMLTextAreaElement | null = null;
  const reviewEl = container.createDiv({
    cls: 'claudian-env-review-warning claudian-setting-validation claudian-setting-validation-warning claudian-hidden',
  });

  const updateReviewWarning = () => {
    const reviewKeys = getEnvironmentReviewKeysForScope(envTextarea?.value ?? '', scope);
    if (reviewKeys.length === 0) {
      reviewEl.toggleClass('claudian-hidden', true);
      reviewEl.empty();
      return;
    }

    reviewEl.setText(`Review environment ownership for: ${reviewKeys.join(', ')}`);
    reviewEl.toggleClass('claudian-hidden', false);
  };

  new Setting(container)
    .setName(name)
    .setDesc(desc)
    .addTextArea((text) => {
      text
        .setPlaceholder(placeholder)
        .setValue(plugin.getEnvironmentVariablesForScope(scope));
      text.inputEl.rows = 6;
      text.inputEl.cols = 50;
      text.inputEl.addClass('claudian-settings-env-textarea');
      text.inputEl.dataset.envScope = scope;
      text.inputEl.addEventListener('input', () => updateReviewWarning());
      text.inputEl.addEventListener('blur', () => {
        void (async (): Promise<void> => {
          await plugin.applyEnvironmentVariables(scope, text.inputEl.value);
          renderCustomContextLimits?.(contextLimitsContainer);
          updateReviewWarning();
        })();
      });
      envTextarea = text.inputEl;
    });

  updateReviewWarning();

  const contextLimitsContainer = container.createDiv({ cls: 'claudian-context-limits-container' });
  renderCustomContextLimits?.(contextLimitsContainer);

  const envSnippetsContainer = container.createDiv({ cls: 'claudian-env-snippets-container' });
  new EnvSnippetManager(envSnippetsContainer, plugin, scope, () => {
    renderCustomContextLimits?.(contextLimitsContainer);
  });
}
