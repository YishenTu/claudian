import type ClaudianPlugin from '../../../main';
import { toOctoAgentPermissionMode } from '../permissionMode';
import { getOctoAgentProviderSettings } from '../settings';
import { OctoAgentClient } from './OctoAgentClient';

export interface OctoAgentAuxQueryOptions {
  systemPrompt?: string;
  model?: string;
  permissionMode?: string;
  resumeSessionId?: string;
  abortController?: AbortController;
  source?: string;
}

export interface OctoAgentAuxQueryResult {
  text: string;
  sessionId: string;
}

const QUERY_TIMEOUT_MS = 60_000;

export async function runOctoAgentAuxQuery(
  plugin: ClaudianPlugin,
  options: OctoAgentAuxQueryOptions,
  prompt: string,
): Promise<OctoAgentAuxQueryResult> {
  const settings = getOctoAgentProviderSettings(
    plugin.settings as Record<string, unknown>,
  );
  const client = new OctoAgentClient({
    accessKey: settings.accessKey || undefined,
    baseUrl: `http://${settings.host}:${settings.port}`,
  });

  let sessionId = options.resumeSessionId ?? '';
  let text = '';
  let receivedDelta = false;
  let completed = false;

  return new Promise<OctoAgentAuxQueryResult>((resolve, reject) => {
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      options.abortController?.signal.removeEventListener('abort', onAbort);
      client.disconnect();
    };

    const onAbort = (): void => {
      cleanup();
      reject(new Error('Aborted'));
    };

    const timeout = window.setTimeout(() => {
      if (!completed) {
        cleanup();
        resolve({ text, sessionId });
      }
    }, QUERY_TIMEOUT_MS);

    const finish = (finalText: string): void => {
      if (completed) {
        return;
      }
      completed = true;
      cleanup();
      resolve({ text: finalText, sessionId });
    };

    const fail = (error: Error): void => {
      if (completed) {
        return;
      }
      completed = true;
      cleanup();
      reject(error);
    };

    options.abortController?.signal.addEventListener('abort', onAbort);

    client.connect({
      onClose: () => {
        if (!completed) {
          finish(text);
        }
      },
      onError: (error) => {
        fail(error);
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'text_delta': {
            text += event.text;
            receivedDelta = true;
            break;
          }
          case 'output': {
            text += event.content;
            break;
          }
          case 'assistant_message': {
            if (!receivedDelta) {
              text = event.content;
            }
            break;
          }
          case 'complete': {
            finish(text);
            break;
          }
          case 'error': {
            fail(new Error(event.message));
            break;
          }
          default: {
            // Ignore other events.
          }
        }
      },
      onOpen: async () => {
        try {
          if (!sessionId) {
            const session = await client.createSession({
              model: options.model ?? '',
              source: options.source ?? 'claudian-aux',
            });
            sessionId = session.id;

            if (options.model) {
              const modelId = options.model.replace(/^octo-agent\//, '');
              if (modelId && modelId !== 'octo-agent') {
                await client.setModel(sessionId, modelId);
              }
            }

            await client.setPermissionMode(
              sessionId,
              toOctoAgentPermissionMode(options.permissionMode ?? 'interactive'),
            );
          }

          client.subscribe(sessionId);
          const fullPrompt = options.systemPrompt
            ? `${options.systemPrompt}\n\n${prompt}`
            : prompt;
          client.sendMessage(sessionId, fullPrompt);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
  });
}
