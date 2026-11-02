# Plugin API (experimental)

Other Obsidian plugins can list and open Claudian sessions, send prompts to them, stop them, follow their output as it streams, read their replies, and answer their approvals and questions. A voice companion, for example, sends the user's transcript, speaks the reply as it arrives, and reads approvals aloud.

The API reports state and events as Claudian has them and makes no decisions for the caller: which streamed blocks to use, which approval options to offer, and how to present them are up to the client.

The API is experimental: its shape may change in minor releases while `version` is `1`. Check `version` before using it.

## Getting the API

```ts
const claudian = this.app.plugins.getPlugin('realclaudian') as { api?: ClaudianAPI } | null;
const api = claudian?.api;
if (api?.version !== 1) return; // Claudian is missing, disabled, still loading, or incompatible
```

Resolve the API when you need it rather than caching it across plugin reloads: disabling or updating Claudian replaces the plugin instance.

## Interface

```ts
interface ClaudianAPI {
  readonly version: 1;
  /** The session shown in the focused chat view, or null. */
  getActiveSessionId(): string | null;
  /** Sessions most recently active first, with their status; archived sessions are omitted. */
  listSessions(options?: { limit?: number }): Promise<{ sessions: SessionSummary[]; truncated?: true }>;
  /** Shows the session in a chat view, opening one when none exists; focus moves only when asked. */
  openSession(sessionId: string, options?: { focus?: boolean }): Promise<void>;
  /** Delivers text as the user's own prompt; `interrupt` without text only stops the session. */
  send(sessionId: string, options: { text?: string; mode?: 'queue' | 'steer' | 'interrupt' }): Promise<SendStatus>;
  /** The last finished turn's final reply as Markdown; empty when no turn has finished. */
  read(sessionId: string): Promise<string>;
  /** Approvals and questions awaiting the user, with every option the prompt offers. */
  getPendingInteractions(sessionId: string): PendingInteraction[];
  /** Answers a pending request as its on-screen prompt would. */
  answerInteraction(sessionId: string, interactionId: string, answers: Record<string, string | string[]>): Promise<void>;
}

type SendStatus = 'started' | 'queued' | 'steered' | 'uncertain' | 'interrupted' | 'idle';

interface SessionSummary {
  sessionId: string;
  title: string;
  provider: string;
  /** `awaiting-user`: an approval or question waits for an answer. */
  status: 'idle' | 'running' | 'awaiting-user';
  /** The session shown in the focused chat view. */
  active: boolean;
}
```

### `listSessions`

Returns non-archived sessions, most recently active first. `limit` is an integer from 1 to 200 and defaults to 50; `truncated` is `true` when more sessions exist. Use `status` to check whether a session is busy before sending.

### `openSession`

Shows the session the way the session list does: in the viewer of the wide layout, or in a tab of the compact layout, reusing the tab that already shows it. When no chat view exists, one opens at the configured placement. `{ focus: true }` also reveals the chat view and focuses its composer. Without it, Claudian does not activate the view itself, but showing a session follows the same path as a click in the session list: a session already open in another tab or view is revealed there, and a pending approval or question takes focus as it does on screen. It rejects when the session does not exist or is archived.

### `send`

The text arrives in the session as an ordinary user prompt, exactly as if the user had typed it. The session runs on its own provider, model and reasoning settings, and it does not need to be open in a tab.

| `mode` | Behavior | Status |
|---|---|---|
| `queue` (default) | Starts a turn, or waits until the session finishes its current work and the user's queued input. | `started`, `queued` |
| `steer` | Joins the running turn. Without a turn to join, it is queued instead. | `steered`, `uncertain`, or the `queue` statuses |
| `interrupt` | Stops the session's work like the Stop button, then delivers the text first. | `interrupted`, or the `queue` statuses when nothing was running |

- `text` is required, except that `{ mode: 'interrupt' }` without text only stops the session (`interrupted`, or `idle` when nothing was running).
- `uncertain` means a steer may or may not have reached the provider. Do not resend it.
- `send` resolves as soon as the text is accepted; it does not wait for the reply. Use the turn-ended event below.
- It rejects when the session does not exist or is archived, or when `text` is missing or empty.
- If the agent asks for permission or a question during the turn, the turn waits until the user answers on screen.

### `read`

Returns the final answer of the last finished turn as Markdown: the text the agent wrote after its last piece of work, without progress commentary, tool calls or thinking. A turn still running is not included, even after a prompt was steered into it. When a turn produced no text, it returns `(interrupted)`, `(error)` or `(no reply)`. Stripping Markdown, for example for speech, is up to the caller.

### `getPendingInteractions` and `answerInteraction`

Each pending request lists its questions exactly as the on-screen prompt shows them. An approval is one question whose options carry a `decision`; a question from the agent can hold several questions.

```ts
interface PendingInteraction {
  interactionId: string;
  kind: 'approval' | 'question';
  /** Approvals only. */
  toolName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  agentId?: string;
  questions: Array<{
    id?: string;
    header: string;
    question: string;
    options: Array<{
      label: string;
      value: string;
      description?: string;
      /** Approvals: 'allow', 'allow-always', 'deny'; absent for provider-specific options. */
      decision?: string;
    }>;
    multiSelect: boolean;
    /** Free-text answers are accepted. */
    isOther: boolean;
    /** The on-screen prompt masks the typed answer. */
    isSecret: boolean;
  }>;
}
```

Every option is listed, including "Always allow"; which ones to offer is the caller's choice.

`answers` holds one entry per question, keyed by its `id`, else its `question` text:

- A single-select answer is one option `value`, or free text when `isOther` is `true`.
- A multi-select answer is a non-empty array of option values, which may include one free-text entry when `isOther` is `true`.

`answerInteraction` rejects answers the prompt could not submit, and requests that are no longer pending. When a question is answered after its turn has moved on, it resolves only once the answer is delivered and rejects if delivery fails. The on-screen prompt closes either way it is answered.

Only the session's main transcript is covered; a side chat's requests are answered on screen.

## Turn-ended event

Claudian fires a workspace event when a session finishes its turn and any work the turn left running:

```ts
this.registerEvent(this.app.workspace.on('claudian:turn-ended', async ({ sessionId }: { sessionId: string }) => {
  if (sessionId !== mySessionId) return;
  const reply = await api.read(sessionId);
  // speak or display the reply
}));
```

The event fires for every session and every turn, whether it was started from the chat view, by another agent, or through this API. Filter by `sessionId`.

## Turn progress event

`claudian:turn-progress` fires for every change to a streamed block, as Claudian receives it, without throttling or filtering:

```ts
type TurnProgress =
  | { sessionId: string; kind: 'text' | 'thinking'; messageId: string; blockIndex: number; text: string }
  | { sessionId: string; kind: 'tool'; messageId: string; toolId: string; toolName: string; status: 'running' | 'completed' | 'error' | 'blocked' };
```

- `text` holds everything so far in the block, so a missed event loses nothing. A new block has a new `blockIndex` within the same `messageId`.
- Notices and errors arrive as text, appended to the open text block as the transcript shows them.
- A reply the provider produced in the background, outside a turn Claudian started, arrives in one burst once it is rendered.
- Text written before a tool call streams too. Claudian does not mark which block is the final answer; `read()` returns it once the turn ends.
- Subagent output is not included. Listeners run for every chunk and must stay cheap.

## Interaction events

`claudian:interaction-requested` fires with `{ sessionId, interactionId }` when an approval or question starts waiting for the user. `claudian:interaction-settled` fires with the same payload when it stops waiting, whether it was answered on screen or through the API, dismissed, or stopped with its turn.

## Example: one spoken exchange

```ts
const sessionId = api.getActiveSessionId();
if (!sessionId) return;
await api.send(sessionId, { text: transcript });
// ...the 'claudian:turn-ended' listener reads and speaks the reply.

// The user talks over the reply:
await api.send(sessionId, { text: newTranscript, mode: 'interrupt' });
```
