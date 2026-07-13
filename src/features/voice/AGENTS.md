# Voice Feature

`src/features/voice/` owns hands-free voice interaction: one-shot dictation into the composer and a full speak-and-listen conversation loop. Audio capture (STT) and playback (TTS) live in an external Python bridge subprocess speaking a JSON-line protocol over stdio. The plugin owns the agent; the bridge never sees the conversation, only text in and audio out.

## Main Parts

| Area | Owns |
| --- | --- |
| `VoiceFeature` | Lifecycle facade on the plugin; owns the stream bus and feature-lifetime state streams that per-tab UI subscribes to |
| `VoiceController` | Conversation turn state machine (`listening` → `pending` → `thinking` → `speaking`), barge-in, confirm window, mute |
| `DictationController` | One-shot capture inserted at the composer caret (or auto-sent) |
| `ResidentBridge` | Reference-counted shared bridge process with idle linger — dictation and conversation share one mic |
| `VoiceBridge` | Subprocess + protocol layer: JSON-line commands in (`listen`/`speak`/`interrupt`), typed events out (`transcript`/`speak-done`/…) |
| `StateStream` | Tiny value-holding observable (replay-on-subscribe, isolated listeners) used for all voice state fan-out |
| Pure helpers | `sentences`, `speakable`, `voiceCommands`, `dictationInsert`, `queuedInputSnippet`, `waveformState` — no DOM or I/O, unit-tested directly |
| UI glue | `VoiceInputControls` (mic/waveform/mute buttons + indicator), `PendingCommandBadge`, `QueuedInputBadge` |

## Integration Points

- `StreamController` forwards every handled chunk into `plugin.voiceBus`, tagged with its tab id. The tap is a no-op until voice runs.
- `VoiceController` locks TTS to the tab a command was submitted to; other tabs' streams are ignored.
- `InputController.onQueueChanged` drives the queued-input badge.
- Settings live under the `settings.voice*` i18n keys and `voice*` fields on `ClaudianSettings`.

## Gotchas

- Half-duplex by design: the bridge captures or plays, never both. The mic re-arms only after the turn finishes streaming and TTS fully drains.
- Fenced code is never spoken: closed blocks are dropped, a still-streaming block is held in the remainder until its closing fence arrives.
- Non-JSON stdout from the bridge becomes an `error` event; during startup an `error` rejects the handshake. Bridge diagnostics must go to stderr.
- `ResidentBridge` keeps the process warm for 30s after the last release, so bridge-side config changes need the linger to expire before they apply.
