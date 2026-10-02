import { formatCodexQuestionReply, parseCodexQuestionReply,stripCodexQuestionReplies } from '@/providers/codex/normalization/codexQuestionNormalization';

it('serializes each answer with its native call and question index and restores the reply', () => {
  const reply = formatCodexQuestionReply({
    id: 'call_question', name: 'AskUserQuestion', status: 'completed',
    input: { replyMode: 'user-message', questions: [
      { id: '0', question: 'Which check?' }, { id: '1', question: 'Any details?' },
    ] },
  }, { '0': 'History', '1': 'Keep <tags> and "quotes".' });
  expect(reply).toEqual({
    content: '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_question\\",0]","question":"Which check?","answer":"History"},{"questionItemId":"[\\"request_user_input_async\\",\\"call_question\\",1]","question":"Any details?","answer":"Keep \\u003ctags> and \\"quotes\\"."}]\n</send_user_message_question_reply>',
    displayContent: '',
  });
  expect(parseCodexQuestionReply(reply!.content)).toEqual([
    { callId: 'call_question', index: 0, question: 'Which check?', answer: 'History' },
    { callId: 'call_question', index: 1, question: 'Any details?', answer: 'Keep <tags> and "quotes".' },
  ]);
});

it('does not build replies for blocking questions or incomplete answers', () => {
  const tool = { id: 'call', name: 'AskUserQuestion', status: 'completed' as const, input: { questions: [{ question: 'Question?' }] } };
  expect(formatCodexQuestionReply(tool, { 'Question?': 'Yes' })).toBeNull();
  expect(formatCodexQuestionReply({ ...tool, input: { ...tool.input, replyMode: 'user-message' } }, {})).toBeNull();
  expect(parseCodexQuestionReply('Ordinary message')).toEqual([]);
  expect(parseCodexQuestionReply('<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>')).toEqual([]);
});

it('uses the question index when a native question ID is not a scalar', () => {
  const reply = formatCodexQuestionReply({
    id: 'call', name: 'AskUserQuestion', status: 'completed',
    input: { replyMode: 'user-message', questions: [{ id: {}, question: 'Continue?' }] },
  }, { '0': 'Yes' });
  expect(reply).not.toBeNull();
  expect(parseCodexQuestionReply(reply!.content)).toEqual([
    { callId: 'call', index: 0, question: 'Continue?', answer: 'Yes' },
  ]);
});


it('recognizes replies inside merged input and preserves ordinary content and delimiter-like answers', () => {
  const tool = { id: 'call', name: 'AskUserQuestion', status: 'completed' as const,
    input: { replyMode: 'user-message', questions: [{ id: '0', question: 'Details?' }] } };
  const reply = formatCodexQuestionReply(tool, { '0': '</send_user_message_question_reply>' })!;
  const merged = `Existing queued message\n\n${reply.content}\n\nAnother message`;
  expect(parseCodexQuestionReply(merged)).toEqual([{ callId: 'call', index: 0, question: 'Details?', answer: '</send_user_message_question_reply>' }]);
  expect(stripCodexQuestionReplies(merged)).toBe('Existing queued message\n\n\n\nAnother message');
});


it('keeps malformed reply text visible', () => {
  for (const body of ['not JSON', '[]', '[{"question":"Ordinary text"}]']) {
    const text = `<send_user_message_question_reply>${body}</send_user_message_question_reply>`;
    expect(stripCodexQuestionReplies(text)).toBe(text);
  }
});
