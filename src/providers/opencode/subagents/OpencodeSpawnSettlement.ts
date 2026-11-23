import type { OpencodeSubagentReport } from '../normalization/opencodeSyntheticReports';

/**
 * What a child session did, in native order, as its live events and its stored rows both record it:
 * each delivered prompt, and each assistant text part with the message it belongs to.
 */
export type OpencodeChildEntry =
  | { readonly kind: 'prompt'; readonly id: string; readonly text: string }
  | { readonly kind: 'text'; readonly messageId: string; readonly text: string };

/** OpenCode prefixes a child's first prompt with its subagent preamble. */
const CHILD_PREAMBLE = 'You are a subagent spawned by another session.\n';

function promptText(text: string): string {
  const prompt = text.trim();
  return prompt.startsWith(CHILD_PREAMBLE) ? prompt.slice(CHILD_PREAMBLE.length).trim() : prompt;
}

/** A spawn as pairing sees it: the prompt it sent, and whether its launch failed before delivering one. */
export interface OpencodeSpawnPrompt { readonly prompt: string | undefined; readonly failed?: boolean }

/**
 * The child prompt each spawn delivered. OpenCode links a spawn to its child only by session, so
 * spawns that launched first take prompts with their own text, in order; one left unmatched then
 * takes the first prompt nobody claimed after those earlier spawns took. A failed spawn rarely
 * delivered one, so it takes only an unclaimed prompt with its own text. A spawn with no prompt
 * left gets none rather than another task's.
 */
export function pairOpencodeSpawns(spawns: readonly OpencodeSpawnPrompt[], entries: readonly OpencodeChildEntry[]): Array<string | undefined> {
  const prompts = entries.filter(entry => entry.kind === 'prompt');
  const paired: Array<number | undefined> = spawns.map(() => undefined);
  const claimed = new Set<number>();
  const take = (index: number, position: number) => { paired[index] = position; claimed.add(position); };
  const matches = (spawn: OpencodeSpawnPrompt, position: number) => {
    const wanted = spawn.prompt?.trim();
    return !!wanted && !claimed.has(position) && promptText(prompts[position].text) === wanted;
  };
  let next = 0;
  spawns.forEach((spawn, index) => {
    if (spawn.failed) return;
    const position = prompts.findIndex((_, candidate) => candidate >= next && matches(spawn, candidate));
    if (position < 0) return;
    take(index, position);
    next = position + 1;
  });
  let after = -1;
  spawns.forEach((spawn, index) => {
    const own = paired[index];
    if (own !== undefined) { after = Math.max(after, own); return; }
    if (spawn.failed) return;
    const position = prompts.findIndex((_, candidate) => candidate > after && !claimed.has(candidate));
    if (position < 0) return;
    take(index, position);
    after = position;
  });
  spawns.forEach((spawn, index) => {
    if (!spawn.failed) return;
    const position = prompts.findIndex((_, candidate) => matches(spawn, candidate));
    if (position >= 0) take(index, position);
  });
  return paired.map(position => position === undefined ? undefined : prompts[position].id);
}

interface Round { readonly promptIds: string[]; readonly messages: Map<string, string[]> }

/**
 * Child output grouped by the prompts it answers. A prompt delivered before the current round has
 * any text joins it, since one answer then covers both; a later prompt opens its own round.
 */
function groupRounds(entries: readonly OpencodeChildEntry[]): Round[] {
  const rounds: Round[] = [];
  for (const entry of entries) {
    const current = rounds.at(-1);
    if (entry.kind === 'prompt') {
      if (current && current.messages.size === 0) current.promptIds.push(entry.id);
      else rounds.push({ promptIds: [entry.id], messages: new Map() });
    } else if (entry.text.trim()) {
      const round = current ?? rounds[rounds.push({ promptIds: [], messages: new Map() }) - 1];
      round.messages.set(entry.messageId, [...round.messages.get(entry.messageId) ?? [], entry.text]);
    }
  }
  return rounds;
}

/** A round's answer is its last assistant message, as OpenCode's idle report reads it. */
function roundAnswer(round: Round | undefined): string | undefined {
  const last = round ? [...round.messages.values()].at(-1) : undefined;
  return last?.join('\n');
}

export interface OpencodeSpawnSettlement {
  /** A cancelled child ends as an error. */
  readonly status: 'completed' | 'error';
  readonly result: string | undefined;
}

function roundOf(rounds: readonly Round[], promptId: string | undefined): number {
  return promptId === undefined ? -1 : rounds.findIndex(round => round.promptIds.includes(promptId));
}

/**
 * Each spawn's own answer, for spawns no report settled, as when the server stopped first; their
 * launch outcome keeps deciding their status.
 */
export function readOpencodeSpawnAnswers(promptIds: readonly (string | undefined)[], entries: readonly OpencodeChildEntry[]): Array<string | undefined> {
  const rounds = groupRounds(entries);
  return promptIds.map(promptId => roundAnswer(rounds[roundOf(rounds, promptId)]));
}

/**
 * Settles the spawns one idle report ends, given the child's entries up to that report. The report
 * body is OpenCode's answer, or failure, for the latest round, which every spawn joined into that
 * round shares; spawns an earlier round answered keep that answer. An interim report settles
 * nothing: the child's own background work continues, so its spawns keep running.
 */
export function settleOpencodeSpawns(
  promptIds: readonly (string | undefined)[],
  entries: readonly OpencodeChildEntry[],
  report: Pick<OpencodeSubagentReport, 'state' | 'body'>,
): OpencodeSpawnSettlement[] | null {
  if (report.state === 'running') return null;
  const rounds = groupRounds(entries);
  const status = report.state === 'completed' ? 'completed' : 'error';
  return promptIds.map(promptId => {
    const index = roundOf(rounds, promptId);
    const own = roundAnswer(rounds[index]);
    const described = index < 0 || index === rounds.length - 1;
    return { status, result: described ? report.body || own : own ?? (report.body || undefined) };
  });
}
