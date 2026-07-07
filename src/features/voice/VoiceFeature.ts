// Lifecycle facade the plugin uses to turn voice mode on and off.
//
// Owns the stream bus (so the StreamController can forward chunks without
// knowing about voice internals) and the VoiceController it drives. The bus is
// created eagerly and exposed on the plugin as `voiceBus`, so the single guarded
// tap in StreamController is a cheap no-op until voice is actually enabled.

import { dirname } from 'node:path';

import { Notice } from 'obsidian';

import type { StreamChunk } from '../../core/types';
import type ClaudianPlugin from '../../main';
import { VoiceController, type VoiceRuntimeConfig, type VoiceStreamBus } from './VoiceController';

/**
 * A tiny synchronous fan-out bus for stream chunks. The StreamController calls
 * `emit` for every chunk it handles; the VoiceController subscribes while voice
 * is running. When there are no subscribers, `emit` is a no-op.
 */
export class VoiceStreamBusImpl implements VoiceStreamBus {
  private readonly listeners = new Set<(chunk: StreamChunk) => void>();

  emit(chunk: StreamChunk): void {
    if (this.listeners.size === 0) {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(chunk);
      } catch {
        // A voice-side error must never disrupt chat rendering.
      }
    }
  }

  subscribe(listener: (chunk: StreamChunk) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export class VoiceFeature {
  private readonly plugin: ClaudianPlugin;
  private readonly bus: VoiceStreamBusImpl;
  private controller: VoiceController | null = null;
  private starting = false;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
    this.bus = new VoiceStreamBusImpl();
    // Expose the bus so StreamController's guarded tap can reach it.
    this.plugin.voiceBus = this.bus;
  }

  /** True while a voice session is running. */
  isRunning(): boolean {
    return this.controller !== null;
  }

  /** Toggle voice mode on/off. */
  async toggle(): Promise<void> {
    if (this.isRunning()) {
      await this.disable();
    } else {
      await this.enable();
    }
  }

  /** Start a voice session using the current settings. */
  async enable(): Promise<void> {
    if (this.controller || this.starting) {
      return;
    }

    const config = this.resolveConfig();
    if (!config) {
      return; // resolveConfig surfaced the reason via Notice
    }

    this.starting = true;
    const controller = new VoiceController(this.plugin, this.bus, config);
    try {
      await controller.start();
      this.controller = controller;
      new Notice('Voice mode on — listening.');
    } catch {
      // VoiceController.start() already surfaced the failure via Notice and
      // tore itself down; just stay disabled.
      this.controller = null;
    } finally {
      this.starting = false;
    }
  }

  /** Stop the running voice session, if any. */
  async disable(): Promise<void> {
    const controller = this.controller;
    this.controller = null;
    if (controller) {
      await controller.stop();
      new Notice('Voice mode off.');
    }
  }

  /** Resolve the Python bridge launch config from settings, or explain why not. */
  private resolveConfig(): VoiceRuntimeConfig | null {
    const settings = this.plugin.settings;
    const bridgeScriptPath = settings.voiceBridgeScriptPath?.trim() ?? '';
    if (bridgeScriptPath === '') {
      new Notice('Voice: set the bridge script path in Claudian settings first.');
      return null;
    }
    const pythonPath = settings.voicePythonPath?.trim() || 'python3';
    return {
      pythonPath,
      bridgeScriptPath,
      // The bridge imports the voicecode package relative to its own directory.
      cwd: dirname(bridgeScriptPath),
    };
  }
}
