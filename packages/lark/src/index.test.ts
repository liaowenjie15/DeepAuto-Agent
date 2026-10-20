import { expect, test } from 'bun:test';
import { normalizeLarkMessage } from './index';

const message = {
  eventId: 'event-1',
  messageId: 'message-1',
  chatId: 'chat-1',
  chatType: 'group' as const,
  senderOpenId: 'ou-user',
  senderType: 'user' as const,
  messageType: 'text' as const,
  instruction: 'Summarize this thread',
  mentionedOpenIds: ['ou-bot'],
  receivedAt: '2026-10-20T00:00:00.000Z',
};

test('admits user text messages that mention the bot in groups', () => {
  expect(
    normalizeLarkMessage(message, {
      workspaceId: 'workspace-1',
      botOpenId: 'ou-bot',
    }),
  ).toMatchObject({
    source: 'feishu',
    conversationKey: 'feishu:chat-1:message-1',
    providerActorId: 'ou-user',
  });
});

test('rejects bot messages and group messages without a mention', () => {
  expect(
    normalizeLarkMessage(
      { ...message, senderType: 'bot' },
      { workspaceId: 'workspace-1', botOpenId: 'ou-bot' },
    ),
  ).toBeNull();
  expect(
    normalizeLarkMessage(
      { ...message, mentionedOpenIds: [] },
      { workspaceId: 'workspace-1', botOpenId: 'ou-bot' },
    ),
  ).toBeNull();
});
