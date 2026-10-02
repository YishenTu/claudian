import { type ChatMessage, type Conversation, isCanonicalUserMessage } from '@/core/types';
import { extractUserDisplayContent } from '@/utils/context';

import { getFinalResponseText } from '../rendering/ResponseLayout';

export function formatSessionSnapshot(
  metadata: Pick<Conversation, 'id' | 'title' | 'providerId' | 'createdAt' | 'lastActivityAt'>,
  messages: readonly ChatMessage[],
  running: boolean,
): string {
  const turns: { user: ChatMessage; responses: ChatMessage[] }[] = [];
  for (const message of messages) {
    if (message.isRebuiltContext) continue;
    if (isCanonicalUserMessage(message)) turns.push({ user: message, responses: [] });
    else turns.at(-1)?.responses.push(message);
  }
  const tail = turns.at(-1)?.responses.at(-1);
  if (running && tail?.completedAt === undefined && !tail?.isInterrupt) turns.pop();
  const header = `# ${metadata.title}\n\nID: ${metadata.id}\nProvider: ${metadata.providerId}\nCreated: ${new Date(metadata.createdAt).toISOString()}\nUpdated: ${new Date(metadata.lastActivityAt).toISOString()}`;
  const body = turns.map(({ user, responses }, index) => {
    const prompt = user.displayContent ?? extractUserDisplayContent(user.content) ?? user.content;
    const final = responses.filter(message => message.role === 'assistant')
      .map(getFinalResponseText).filter(text => text.trim()).join('\n\n');
    const placeholder = responses.some(message => message.isInterrupt) ? '(interrupted)'
      : responses.some(message => message.toolCalls?.some(tool => tool.status === 'error')) ? '(error)' : '(no reply)';
    return `## T${index + 1} user\n${prompt}\n\n## T${index + 1} assistant\n${final || placeholder}`;
  });
  return [header, ...body].join('\n\n') + '\n';
}
