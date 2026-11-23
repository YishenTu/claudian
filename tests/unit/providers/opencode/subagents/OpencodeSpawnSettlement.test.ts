import {
  type OpencodeChildEntry,
  pairOpencodeSpawns,
  readOpencodeSpawnAnswers,
  settleOpencodeSpawns,
} from '@/providers/opencode/subagents/OpencodeSpawnSettlement';

const prompt = (id: string, text: string): OpencodeChildEntry => ({ kind: 'prompt', id, text });
const text = (messageId: string, value: string): OpencodeChildEntry => ({ kind: 'text', messageId, text: value });

describe('pairOpencodeSpawns', () => {
  it.each([
    {
      name: 'in order',
      spawns: [{ prompt: 'Survey' }, { prompt: 'Check' }],
      entries: [prompt('p1', 'Survey'), prompt('p2', 'Check')],
      paired: ['p1', 'p2'],
    },
    {
      name: 'a repeated prompt behind the first prompt preamble',
      spawns: [{ prompt: 'Check status' }, { prompt: 'Check status' }],
      entries: [prompt('p1', 'You are a subagent spawned by another session.\nCheck status'), text('m1', 'First.'), prompt('p2', 'Check status')],
      paired: ['p1', 'p2'],
    },
    {
      name: 'past a prompt no spawn sent',
      spawns: [{ prompt: 'Check' }],
      entries: [prompt('p0', 'Foreground task'), prompt('p1', 'Check')],
      paired: ['p1'],
    },
    {
      name: 'by order when no prompt text matches, and to nothing once prompts run out',
      spawns: [{ prompt: 'Reworded' }, { prompt: 'Missing' }],
      entries: [prompt('p1', 'Original')],
      paired: ['p1', undefined],
    },
    {
      name: 'leaving a failed spawn its own prompt only, never a later spawn\'s',
      spawns: [{ prompt: 'Survey' }, { prompt: 'Check tags', failed: true }, { prompt: 'Check tags again' }],
      entries: [prompt('p1', 'Survey'), prompt('p2', 'Check tags again')],
      paired: ['p1', undefined, 'p2'],
    },
    {
      name: 'by text before order, so an earlier reworded spawn cannot take a later spawn\'s prompt',
      spawns: [{ prompt: 'Reworded' }, { prompt: 'Check' }],
      entries: [prompt('p1', 'Check')],
      paired: [undefined, 'p1'],
    },
    {
      name: 'giving an identical prompt to the launch that delivered it, not a failed one before it',
      spawns: [{ prompt: 'Check tags', failed: true }, { prompt: 'Check tags' }],
      entries: [prompt('p1', 'Check tags')],
      paired: [undefined, 'p1'],
    },
  ] as const)('pairs spawns with child prompts $name', ({ spawns, entries, paired }) => {
    expect(pairOpencodeSpawns(spawns, entries)).toEqual(paired);
  });
});

describe('settleOpencodeSpawns', () => {
  it.each([
    {
      name: 'a single spawn with the report body',
      promptIds: ['p1'],
      entries: [prompt('p1', 'Survey'), text('m1', 'Vault surveyed.')],
      report: { state: 'completed', body: 'Vault surveyed.' },
      settled: [{ status: 'completed', result: 'Vault surveyed.' }],
    },
    {
      name: 'a child whose last step wrote no text with the report, not its progress',
      promptIds: ['p1'],
      entries: [prompt('p1', 'Survey'), text('m1', 'Still reading.')],
      report: { state: 'completed', body: 'Subagent completed without a text response.' },
      settled: [{ status: 'completed', result: 'Subagent completed without a text response.' }],
    },
    {
      name: 'a child that ended without any text with the report body',
      promptIds: ['p1'],
      entries: [prompt('p1', 'Survey')],
      report: { state: 'completed', body: 'Subagent completed without a text response.' },
      settled: [{ status: 'completed', result: 'Subagent completed without a text response.' }],
    },
    {
      name: 'joined follow-ups with the answer that covered them, and a later one with its own',
      promptIds: ['p1', 'p2', 'p3'],
      entries: [prompt('p1', 'A'), prompt('p2', 'B'), text('m1', 'A and B answer'), prompt('p3', 'C'), text('m2', 'C answer')],
      report: { state: 'completed', body: 'C answer' },
      settled: [{ status: 'completed', result: 'A and B answer' }, { status: 'completed', result: 'A and B answer' }, { status: 'completed', result: 'C answer' }],
    },
    {
      name: 'an earlier round that answered over several steps with its last message',
      promptIds: ['p1', 'p2'],
      entries: [prompt('p1', 'A'), text('m1', 'I will inspect the folder.'), text('m2', 'The folder holds the database.'), prompt('p2', 'B'), text('m3', 'B answer')],
      report: { state: 'completed', body: 'B answer' },
      settled: [{ status: 'completed', result: 'The folder holds the database.' }, { status: 'completed', result: 'B answer' }],
    },
    {
      name: 'every part of the last message',
      promptIds: ['p1', 'p2'],
      entries: [prompt('p1', 'A'), text('m1', 'Part one'), text('m1', 'Part two'), prompt('p2', 'B'), text('m2', 'B answer')],
      report: { state: 'completed', body: 'B answer' },
      settled: [{ status: 'completed', result: 'Part one\nPart two' }, { status: 'completed', result: 'B answer' }],
    },
    {
      name: 'a joined round that ended without any text with the report body for all',
      promptIds: ['p1', 'p2'],
      entries: [prompt('p1', 'A'), text('m1', '  '), prompt('p2', 'B')],
      report: { state: 'completed', body: 'Subagent completed without a text response.' },
      settled: [{ status: 'completed', result: 'Subagent completed without a text response.' }, { status: 'completed', result: 'Subagent completed without a text response.' }],
    },
    {
      name: 'a failed follow-up while the answered first prompt keeps its answer',
      promptIds: ['p1', 'p2'],
      entries: [prompt('p1', 'A'), text('m1', 'First answer.'), prompt('p2', 'B')],
      report: { state: 'error', body: 'Follow-up failed' },
      settled: [{ status: 'error', result: 'First answer.' }, { status: 'error', result: 'Follow-up failed' }],
    },
    {
      name: 'a cancelled child as an error with its cause',
      promptIds: ['p1'],
      entries: [prompt('p1', 'A'), text('m1', 'Still indexing')],
      report: { state: 'cancelled', body: 'Subagent cancelled' },
      settled: [{ status: 'error', result: 'Subagent cancelled' }],
    },
    {
      name: 'a spawn whose prompt was never found with the report body',
      promptIds: [undefined],
      entries: [text('m1', 'Orphan text')],
      report: { state: 'completed', body: 'Done' },
      settled: [{ status: 'completed', result: 'Done' }],
    },
  ] as const)('settles $name', ({ promptIds, entries, report, settled }) => {
    expect(settleOpencodeSpawns(promptIds, entries, report)).toEqual(settled);
  });

  it('reads unreported spawns\' own answers without deciding their status', () => {
    expect(readOpencodeSpawnAnswers(['p1', 'p2'], [prompt('p1', 'A'), text('m1', 'A answer'), prompt('p2', 'B')])).toEqual(['A answer', undefined]);
  });

  it('settles nothing on an interim report, while the child keeps working', () => {
    expect(settleOpencodeSpawns(['p1'], [prompt('p1', 'A'), text('m1', 'Waiting on the shell.')], { state: 'running', body: 'Waiting on the shell.' })).toBeNull();
  });
});
