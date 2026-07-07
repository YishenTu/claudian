// Per-tab voice input controls: a dictation mic button and a full-conversation
// waveform toggle, plus a state-animated waveform indicator rendered inline in
// the input wrapper. Motion is driven purely from turn state (no real audio
// levels); `prefers-reduced-motion` falls back to a static opacity indicator.
//
// This is UI glue only — all voice logic lives in VoiceFeature. Buttons are
// always shown; if the bridge isn't configured, VoiceFeature surfaces a Notice
// pointing to settings when clicked.

import { setIcon } from 'obsidian';

import type ClaudianPlugin from '../../main';
import type { TabData } from '../chat/tabs/types';
import { createQueuedInputBadge } from './QueuedInputBadge';
import type { VoiceState } from './VoiceController';
import { type WaveformMode,waveformModeClass, waveformModeForState } from './waveformState';

/** Number of bars in the waveform indicator. Kept small to stay lightweight. */
const WAVEFORM_BAR_COUNT = 5;

export interface VoiceInputControlsHandle {
  /**
   * Re-render the queued-input badge from tab.state.queuedMessage. Wire this to
   * InputController's onQueueChanged so the glanceable badge stays in sync with
   * the composer-side queue indicator (enqueue / discard / process).
   */
  notifyQueueChanged: () => void;
  /** Detach listeners and remove DOM. Registered on the tab's eventCleanups. */
  destroy: () => void;
}

/**
 * Build the mic + waveform buttons (appended to `toolbarEl`) and the waveform
 * indicator (prepended into `inputWrapperEl`, above the textarea). Returns a
 * handle whose destroy() unsubscribes from voice state and removes the DOM.
 */
export function createVoiceInputControls(
  plugin: ClaudianPlugin,
  toolbarEl: HTMLElement,
  inputWrapperEl: HTMLElement,
  tab: TabData,
): VoiceInputControlsHandle {
  const voice = plugin.voiceFeature;

  const container = toolbarEl.createDiv({ cls: 'claudian-voice-controls' });

  // Queued-input badge: shows next to the mic when this tab has a message queued
  // (typically the user's mid-reply speech in conversation mode), with a kill (✕)
  // button to discard it hands-free. Rendered immediately below so it reflects an
  // already-queued message if the controls mount after a queue is set.
  const queuedBadge = createQueuedInputBadge(container, tab);

  // --- Dictation mic button ---
  const micBtn = container.createDiv({ cls: 'claudian-voice-mic-btn' });
  micBtn.setAttribute('role', 'button');
  micBtn.setAttribute('aria-label', 'Dictate (voice to text)');
  micBtn.setAttribute('title', 'Dictate (voice to text)');
  const micIcon = micBtn.createSpan({ cls: 'claudian-voice-mic-icon' });
  setIcon(micIcon, 'mic');

  // --- Conversation waveform toggle button ---
  const convoBtn = container.createDiv({ cls: 'claudian-voice-convo-btn' });
  convoBtn.setAttribute('role', 'button');
  convoBtn.setAttribute('aria-label', 'Voice conversation');
  convoBtn.setAttribute('title', 'Voice conversation');
  const convoIcon = convoBtn.createSpan({ cls: 'claudian-voice-convo-icon' });
  setIcon(convoIcon, 'audio-lines');

  // --- Inline waveform indicator (hidden until conversation is active) ---
  // Appended into the wrapper via the codebase's createDiv idiom; CSS `order:-1`
  // floats it to the top of the (column-flex) wrapper, above the textarea. This
  // is the least-invasive placement and avoids DOM insertion-order plumbing.
  const indicator = inputWrapperEl.createDiv({
    cls: 'claudian-voice-waveform claudian-hidden',
    attr: { 'aria-hidden': 'true' },
  });
  for (let i = 0; i < WAVEFORM_BAR_COUNT; i += 1) {
    const bar = indicator.createDiv({ cls: 'claudian-voice-waveform-bar' });
    // Stagger animation per bar via a custom property (used by CSS keyframes).
    // Guarded: minimal DOM shims (tests) may lack CSSStyleDeclaration.setProperty.
    bar.style?.setProperty?.('--claudian-voice-bar-index', String(i));
  }

  // --- Wiring ---
  micBtn.addEventListener('click', () => {
    void voice?.startDictation();
  });
  convoBtn.addEventListener('click', () => {
    void voice?.toggleConversation();
  });

  const applyWaveformMode = (mode: WaveformMode): void => {
    indicator.classList.remove(
      waveformModeClass('calm'),
      waveformModeClass('listening'),
      waveformModeClass('speaking'),
    );
    indicator.classList.add(waveformModeClass(mode));
  };

  const applyConversationState = (state: VoiceState): void => {
    const active = state !== 'idle';
    convoBtn.toggleClass('active', active);
    indicator.toggleClass('claudian-hidden', !active);
    applyWaveformMode(waveformModeForState(state));
  };

  const applyDictationState = (listening: boolean): void => {
    micBtn.toggleClass('active', listening);
  };

  // Subscribe to live voice state. Both fire immediately with current state.
  const unsubConvo = voice?.onConversationStateChange(applyConversationState) ?? (() => {});
  const unsubDict = voice?.onDictationStateChange((s) => applyDictationState(s === 'listening'))
    ?? (() => {});

  // Reflect any message already queued when the controls mount (e.g. a tab
  // rebuilt mid-turn). Subsequent changes arrive via notifyQueueChanged().
  queuedBadge.render();

  return {
    notifyQueueChanged: () => queuedBadge.render(),
    destroy: () => {
      unsubConvo();
      unsubDict();
      queuedBadge.destroy();
      container.remove?.();
      indicator.remove?.();
    },
  };
}
