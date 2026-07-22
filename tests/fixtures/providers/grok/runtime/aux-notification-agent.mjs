#!/usr/bin/env node
import * as fs from 'node:fs';
import * as readline from 'node:readline';

const logPath = process.env.GROK_AUX_FIXTURE_LOG;
const sessionId = 'fixture-aux-session';

function appendLog(event) {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(message, result) {
  write({ id: message.id, jsonrpc: '2.0', result });
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

function messageChunk(text, targetSessionId = sessionId) {
  return {
    sessionId: targetSessionId,
    update: {
      content: { text, type: 'text' },
      messageId: `assistant-${process.pid}`,
      sessionUpdate: 'agent_message_chunk',
    },
  };
}

appendLog({ event: 'start', pid: process.pid, profile: process.env.GROK_PROFILE });
process.once('SIGTERM', () => {
  appendLog({ event: 'shutdown', pid: process.pid });
  process.exit(0);
});

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (!message.method) return;
  appendLog({
    event: 'request',
    method: message.method,
    modelId: message.params?.modelId,
    pid: process.pid,
    sessionId: message.params?.sessionId,
  });

  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    respond(message, {
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
      agentInfo: { name: 'fixture-grok-aux', version: '1.0.0' },
      protocolVersion: 1,
    });
    return;
  }
  if (message.method === 'session/new' || message.method === 'session/load') {
    respond(message, {
      models: {
        availableModels: [{ modelId: 'native-current', name: 'Native current' }],
        currentModelId: 'native-current',
      },
      sessionId,
    });
    return;
  }
  if (message.method === 'session/set_model') {
    respond(message, {});
    return;
  }
  if (message.method === 'session/prompt') {
    const prompt = message.params.prompt[0].text;
    if (prompt.startsWith('standard-')) {
      const workflow = prompt.slice('standard-'.length);
      notify('session/update', messageChunk('wrong', 'other-session'));
      notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'turn_completed' },
      });
      notify('session/update', {
        sessionId,
        update: { sessionUpdate: 'future_standard_extension' },
      });
      const firstChunk = messageChunk(`${workflow}-one`);
      notify('session/update', firstChunk);
      notify('_x.ai/session/update', firstChunk);
      notify('session/update', messageChunk(` ${workflow}-two`));
      respond(message, { stopReason: 'end_turn' });
      return;
    }
    if (prompt === 'aliases') {
      notify('_x.ai/session/update', messageChunk('wrong', 'other-session'));
      notify('x.ai/session/update', messageChunk('alias-one'));
      notify('_x.ai/session/update', {
        sessionId,
        update: {
          sessionUpdate: 'turn_completed',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      });
      notify('_x.ai/session/update', {
        sessionId,
        update: { sessionUpdate: 'future_grok_extension' },
      });
      notify('_x.ai/session/update', messageChunk(' alias-two'));
      notify('_x.ai/session_notification', {
        method: 'x.ai/session_notification',
        params: messageChunk(' wrapped'),
      });
      notify('_x.ai/session_notification', {
        method: '_x.ai/session_notification',
        params: messageChunk(' malformed'),
      });
      respond(message, { stopReason: 'end_turn' });
      return;
    }
    if (prompt === 'cancel') {
      notify('_x.ai/session/update', messageChunk('old'));
      return;
    }
    if (prompt === 'follow-up') {
      notify('_x.ai/session/update', messageChunk('new'));
      respond(message, { stopReason: 'end_turn' });
      return;
    }
    if (prompt === 'explicit-context') {
      notify('_x.ai/session/update', messageChunk('seeded'));
      respond(message, { stopReason: 'end_turn' });
      return;
    }
    if (prompt === 'native-continuation') {
      notify('_x.ai/session/update', messageChunk('continued'));
      respond(message, { stopReason: 'end_turn' });
      return;
    }
    respond(message, { stopReason: 'end_turn' });
    return;
  }
  respond(message, {});
});
