import { classifyOpencodeLaunch, OpencodeChildLedger } from '@/providers/opencode/subagents/OpencodeChildLedger';

const LAUNCH = 'The subagent is working in the background (sessionID: ses_child). You will receive a <subagent> message when it goes idle.';

describe('classifyOpencodeLaunch', () => {
  it.each([
    { name: 'a failed spawn as failed, whatever it requested', failed: true, result: '', payload: undefined, input: { background: true, run_in_background: true }, launch: 'failed' },
    { name: 'running result metadata as background', failed: false, result: 'Reworded', payload: { rawOutput: { metadata: { sessionID: 'ses_child', status: 'running' } } }, input: {}, launch: 'background' },
    { name: 'the launch text without metadata as background', failed: false, result: LAUNCH, payload: undefined, input: {}, launch: 'background' },
    { name: 'a detached foreground request as background', failed: false, result: LAUNCH, payload: undefined, input: { run_in_background: false }, launch: 'background' },
    { name: 'a background request with a plain result as background', failed: false, result: 'Task started.', payload: undefined, input: { run_in_background: true }, launch: 'background' },
    { name: 'a finished answer as foreground', failed: false, result: 'Answer', payload: { rawOutput: { metadata: { sessionID: 'ses_child', status: 'completed' } } }, input: {}, launch: 'foreground' },
  ] as const)('classifies $name', ({ failed, result, payload, input, launch }) => {
    expect(classifyOpencodeLaunch(failed, result, payload, input)).toBe(launch);
  });
});

describe('OpencodeChildLedger', () => {
  it('reports only the first background launch as moving the child to the background', () => {
    const ledger = new OpencodeChildLedger();
    ledger.spawn('a', 'a', 'A');
    ledger.spawn('b', 'b', 'B');
    expect(ledger.launch('a', 'background')).toBe(true);
    expect(ledger.launch('b', 'background')).toBe(false);
    expect(ledger.launch('a', 'background')).toBe(false);
  });

  it('settles only background spawns, keeping a failed follow-up failed', () => {
    const ledger = new OpencodeChildLedger();
    ledger.spawn('a', 'a', 'A');
    ledger.launch('a', 'background');
    ledger.record({ kind: 'prompt', id: 'p1', text: 'A' });
    ledger.spawn('b', 'b', 'B');
    ledger.launch('b', 'failed');
    ledger.record({ kind: 'text', messageId: 'm1', text: 'A answer' });
    expect(ledger.report({ state: 'completed', body: 'A answer' })).toEqual([{ toolCallId: 'a', settlement: { status: 'completed', result: 'A answer' } }]);
    expect(ledger.state('b')).toEqual({ phase: 'failed' });
    expect(ledger.hasBackground).toBe(false);
  });

  it('keeps spawns running through an interim report until a terminal one', () => {
    const ledger = new OpencodeChildLedger();
    ledger.spawn('a', 'a', 'A');
    ledger.launch('a', 'background');
    ledger.record({ kind: 'prompt', id: 'p1', text: 'A' });
    ledger.record({ kind: 'text', messageId: 'm1', text: 'Waiting on the shell.' });
    expect(ledger.report({ state: 'running', body: 'Waiting on the shell.' })).toEqual([]);
    expect(ledger.state('a')).toEqual({ phase: 'background', interim: true });
    ledger.record({ kind: 'text', messageId: 'm2', text: 'Shell done.' });
    expect(ledger.report({ state: 'completed', body: 'Shell done.' })).toEqual([{ toolCallId: 'a', settlement: { status: 'completed', result: 'Shell done.' } }]);
  });

  it('starts a new segment at a terminal report, so a later report or output cannot change what it settled', () => {
    const ledger = new OpencodeChildLedger();
    ledger.spawn('a', 'a', 'Check status');
    ledger.launch('a', 'background');
    ledger.record({ kind: 'prompt', id: 'p1', text: 'You are a subagent spawned by another session.\nCheck status' });
    ledger.record({ kind: 'text', messageId: 'm1', text: 'First answer.' });
    ledger.report({ state: 'completed', body: 'First answer.' });
    // OpenCode 2.2 can wake a reported child again without another report.
    ledger.record({ kind: 'text', messageId: 'm2', text: 'Late output.' });
    ledger.spawn('b', 'b', 'Check status');
    ledger.launch('b', 'background');
    ledger.record({ kind: 'prompt', id: 'p2', text: 'Check status' });
    ledger.record({ kind: 'text', messageId: 'm3', text: 'Updated status.' });
    expect(ledger.report({ state: 'completed', body: 'Updated status.' })).toEqual([{ toolCallId: 'b', settlement: { status: 'completed', result: 'Updated status.' } }]);
    expect(ledger.state('a')).toEqual({ phase: 'settled', settlement: { status: 'completed', result: 'First answer.' } });
    expect([ledger.promptId('a'), ledger.promptId('b')]).toEqual(['p1', 'p2']);
  });

  it('keeps a retry\'s prompt and answer when a failed follow-up came first', () => {
    const ledger = new OpencodeChildLedger();
    ledger.spawn('a', 'a', 'Survey');
    ledger.launch('a', 'background');
    ledger.record({ kind: 'prompt', id: 'p1', text: 'Survey' });
    ledger.record({ kind: 'text', messageId: 'm1', text: 'Survey answer' });
    ledger.spawn('b', 'b', 'Check tags');
    ledger.launch('b', 'failed');
    ledger.spawn('c', 'c', 'Check tags again');
    ledger.launch('c', 'background');
    // The retry's prompt does not match its text, so only order can pair it.
    ledger.record({ kind: 'prompt', id: 'p2', text: 'Check the tags once more' });
    ledger.record({ kind: 'text', messageId: 'm2', text: 'Tags answer' });
    expect(ledger.report({ state: 'completed', body: 'Tags answer' })).toEqual([
      { toolCallId: 'a', settlement: { status: 'completed', result: 'Survey answer' } },
      { toolCallId: 'c', settlement: { status: 'completed', result: 'Tags answer' } },
    ]);
    expect([ledger.promptId('a'), ledger.promptId('b'), ledger.promptId('c')]).toEqual(['p1', undefined, 'p2']);
  });

  it('keeps spawns apart when a model reuses a tool call ID in another message', () => {
    const ledger = new OpencodeChildLedger();
    ledger.spawn('m1:call', 'call', 'A');
    ledger.launch('m1:call', 'background');
    ledger.record({ kind: 'prompt', id: 'p1', text: 'A' });
    ledger.record({ kind: 'text', messageId: 'c1', text: 'A answer' });
    ledger.spawn('m2:call', 'call', 'B');
    ledger.launch('m2:call', 'background');
    ledger.record({ kind: 'prompt', id: 'p2', text: 'B' });
    ledger.record({ kind: 'text', messageId: 'c2', text: 'B answer' });
    expect(ledger.report({ state: 'completed', body: 'B answer' })).toEqual([
      { toolCallId: 'call', settlement: { status: 'completed', result: 'A answer' } },
      { toolCallId: 'call', settlement: { status: 'completed', result: 'B answer' } },
    ]);
  });

  it('leaves a follow-up still queued in the child to the run that takes its prompt', () => {
    const ledger = new OpencodeChildLedger();
    ledger.spawn('a', 'a', 'A');
    ledger.launch('a', 'background');
    ledger.record({ kind: 'prompt', id: 'p1', text: 'A' });
    ledger.spawn('b', 'b', 'B');
    ledger.launch('b', 'background');
    expect(ledger.report({ state: 'cancelled', body: 'Subagent cancelled' })).toEqual([{ toolCallId: 'a', settlement: { status: 'error', result: 'Subagent cancelled' } }]);
    expect(ledger.state('b')).toEqual({ phase: 'background', interim: false });
    ledger.record({ kind: 'prompt', id: 'p2', text: 'B' });
    ledger.record({ kind: 'text', messageId: 'm1', text: 'B answer' });
    expect(ledger.report({ state: 'completed', body: 'B answer' })).toEqual([{ toolCallId: 'b', settlement: { status: 'completed', result: 'B answer' } }]);
    expect([ledger.promptId('a'), ledger.promptId('b')]).toEqual(['p1', 'p2']);
  });

  it('answers an unreported background spawn from its own round', () => {
    const ledger = new OpencodeChildLedger();
    ledger.spawn('a', 'a', 'A');
    ledger.launch('a', 'background');
    ledger.record({ kind: 'prompt', id: 'p1', text: 'A' });
    ledger.record({ kind: 'text', messageId: 'm1', text: 'Partial answer.' });
    expect(ledger.answer('a')).toBe('Partial answer.');
    expect(ledger.hasBackground).toBe(true);
  });
});
