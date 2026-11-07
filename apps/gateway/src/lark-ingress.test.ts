import { expect, mock, test } from 'bun:test';
import {
  createLarkIngress,
  type LarkIngressDependencies,
} from './lark-ingress';

const authorizeInboundInvocation = mock(async () => ({
  source: 'feishu' as const,
  workspaceId: 'workspace-1',
  actorId: 'member-1',
  memberRole: 'MEMBER',
  conversationKey: 'feishu:tenant_test:chat-1:direct',
  anchor: 'message' as const,
  instruction: '请帮我总结。',
  sourceEventId: 'cli_test_app:tenant_test:om_message',
  receivedAt: '2026-11-07T00:00:00.000Z',
}));
const createOrGetLarkMessage = mock(async () => ({
  invocationId: 'invocation-1',
  created: true,
}));
const parseLarkSdkMessage = mock(() => ({
  invocation: {
    source: 'feishu',
    workspaceId: 'workspace-1',
    actorId: 'ou_user',
    providerActorId: 'ou_user',
    conversationKey: 'feishu:tenant_test:chat-1:direct',
    anchor: 'message',
    instruction: '请帮我总结。',
    sourceEventId: 'cli_test_app:tenant_test:om_message',
    idempotencyKey: 'feishu:message:cli_test_app:tenant_test:om_message',
    receivedAt: '2026-11-07T00:00:00.000Z',
  },
  anchor: {
    appId: 'cli_test_app',
    tenantKey: 'tenant_test',
    chatId: 'chat-1',
    messageId: 'om_message',
  },
  chatType: 'p2p' as const,
  senderOpenId: 'ou_user',
}));

const dependencies: LarkIngressDependencies = {
  authorizeInboundInvocation: authorizeInboundInvocation as never,
  createOrGetLarkMessage: createOrGetLarkMessage as never,
  parseLarkSdkMessage: parseLarkSdkMessage as never,
};

test('persists an authorized message without waiting for a Feishu reaction', async () => {
  const client = {
    react: mock(),
    reply: mock(),
    start: mock(),
    close: mock(),
  };
  const ingress = createLarkIngress(
    {} as never,
    {
      appId: 'cli_test_app',
      tenantKey: 'tenant_test',
      workspaceId: 'workspace-1',
      botOpenId: 'ou_bot',
      allowedGroupChatIds: [],
      client: client as never,
    },
    dependencies,
  );

  await ingress.handle({});

  expect(authorizeInboundInvocation).toHaveBeenCalledTimes(1);
  expect(createOrGetLarkMessage).toHaveBeenCalledTimes(1);
  expect(client.react).not.toHaveBeenCalled();
});
