import { expect, mock, test } from 'bun:test';
import {
  createOrGetLarkMessage,
  markStaleLarkDeliveriesUnknown,
} from './lark-message';

test('returns the existing invocation for a repeated Lark event', async () => {
  const invocation = {
    create: mock(async () => {
      throw { code: 'P2002' };
    }),
  };
  const larkMessage = {
    findUnique: mock(async () => ({
      chatId: 'chat-1',
      senderOpenId: 'ou-user',
      chatType: 'P2P',
      invocationId: 'invocation-1',
      invocation: {
        workspaceId: 'workspace-1',
        actorId: 'member-1',
        sourceEventId: 'cli_test_app:tenant_test:om_message',
        conversationKey: 'feishu:cli_test_app:tenant_test:chat-1:direct',
      },
    })),
  };
  const prisma = { invocation, larkMessage } as never;

  await expect(
    createOrGetLarkMessage(prisma, {
      authorized: {
        source: 'feishu',
        workspaceId: 'workspace-1',
        actorId: 'member-1',
        memberRole: 'MEMBER',
        conversationKey: 'feishu:cli_test_app:tenant_test:chat-1:direct',
        anchor: 'message',
        instruction: 'test instruction',
        sourceEventId: 'cli_test_app:tenant_test:om_message',
        receivedAt: '2026-11-07T00:00:00.000Z',
      },
      anchor: {
        appId: 'cli_test_app',
        tenantKey: 'tenant_test',
        chatId: 'chat-1',
        messageId: 'om_message',
      },
      senderOpenId: 'ou-user',
      chatType: 'p2p',
    }),
  ).resolves.toEqual({ invocationId: 'invocation-1', created: false });
  expect(invocation.create).toHaveBeenCalledTimes(1);
  expect(larkMessage.findUnique).toHaveBeenCalledTimes(1);
});

test('audits each delivery that is transitioned to unknown', async () => {
  const auditEvent = { create: mock(async () => undefined) };
  const larkMessage = {
    findMany: mock(async (query: { where: { acknowledgement?: string } }) =>
      query.where.acknowledgement === 'CLAIMED'
        ? [
            {
              id: 'message-acknowledgement',
              invocationId: 'invocation-acknowledgement',
            },
          ]
        : [
            {
              id: 'message-final-reply',
              invocationId: 'invocation-final-reply',
            },
          ],
    ),
    updateMany: mock(async () => ({ count: 1 })),
  };
  const prisma = {
    $transaction: mock(
      async (operation: (transaction: unknown) => Promise<void>) =>
        operation({ larkMessage, auditEvent }),
    ),
  } as never;

  await markStaleLarkDeliveriesUnknown(prisma, {
    appId: 'cli_test_app',
    tenantKey: 'tenant_test',
    workspaceId: 'workspace-1',
    before: new Date('2026-11-07T00:00:00.000Z'),
  });

  expect(auditEvent.create).toHaveBeenCalledWith({
    data: {
      workspaceId: 'workspace-1',
      actorId: null,
      action: 'lark.delivery_acknowledgement_unknown',
      metadata: { invocationId: 'invocation-acknowledgement' },
    },
  });
  expect(auditEvent.create).toHaveBeenCalledWith({
    data: {
      workspaceId: 'workspace-1',
      actorId: null,
      action: 'lark.delivery_final_reply_unknown',
      metadata: { invocationId: 'invocation-final-reply' },
    },
  });
});
