import { expect, mock, test } from 'bun:test';
import type { LarkChatConfiguration } from './lark-chat-agent';
import {
  type LarkChatRuntimeDependencies,
  larkChatFailureCategory,
  startLarkChatRuntime,
} from './lark-chat-runtime';

const anchor = {
  appId: 'cli_test_app',
  tenantKey: 'tenant_test',
  chatId: 'chat-1',
  messageId: 'om_message',
};
const claimLarkDelivery = mock(async () => anchor);
const finishLarkDelivery = mock(async () => undefined);

const dependencies: LarkChatRuntimeDependencies = {
  createFeishuClient: mock(),
  claimLarkDelivery,
  claimNextLarkMessage: mock(async () => null),
  finishLarkDelivery,
  finishLarkProcessing: mock(),
  markStaleLarkDeliveriesUnknown: mock(),
  markStaleLarkMessagesUnknown: mock(),
  runLarkChatAgent: mock(),
};

const configuration: LarkChatConfiguration & { repository: string } = {
  appId: 'cli_test_app',
  appSecret: 'test-secret',
  tenantKey: 'tenant_test',
  workspaceId: 'workspace-1',
  repositoryId: 'repository-1',
  repository: 'owner/repository',
  redirectUri: 'https://example.test/callback',
  cipher: {} as LarkChatConfiguration['cipher'],
  responsesUrl: 'https://model.example.test/v1/responses',
  apiKey: 'test-api-key',
  model: 'test-model',
  botResourceTokens: [],
};

test('classifies chat failures without preserving their raw details', () => {
  expect(larkChatFailureCategory(new Error('Lark workspace mismatch'))).toBe(
    'workspace_mismatch',
  );
  expect(
    larkChatFailureCategory(new Error('Lark OAuth token request failed')),
  ).toBe('oauth');
  expect(larkChatFailureCategory(new Error('Lark data request failed'))).toBe(
    'lark_data',
  );
  expect(
    larkChatFailureCategory(new Error('Codex Responses URL is invalid')),
  ).toBe('model_configuration');
  expect(larkChatFailureCategory(new Error('unclassified failure'))).toBe(
    'unexpected',
  );
});

test('delivers a persisted acknowledgement from the Worker', async () => {
  const client = {
    react: mock(async () => undefined),
    reply: mock(),
    start: mock(),
    close: mock(),
  };
  const prisma = {
    larkMessage: {
      findMany: mock(async (query: { where?: { acknowledgement?: string } }) =>
        query.where?.acknowledgement === 'PENDING'
          ? [
              {
                invocationId: 'invocation-1',
                invocation: { workspaceId: 'workspace-1' },
              },
            ]
          : [],
      ),
      findFirst: mock(async () => ({
        senderOpenId: 'ou_user',
        invocation: { actorId: 'member-1' },
      })),
    },
    workspaceMember: { findFirst: mock(async () => ({ id: 'member-1' })) },
  } as never;
  const runtime = startLarkChatRuntime(
    prisma,
    configuration,
    client as never,
    dependencies,
  );

  await runtime.close();

  expect(claimLarkDelivery).toHaveBeenCalledWith(prisma, {
    workspaceId: 'workspace-1',
    invocationId: 'invocation-1',
    kind: 'acknowledgement',
  });
  expect(client.react).toHaveBeenCalledWith(anchor);
  expect(finishLarkDelivery).toHaveBeenCalledWith(prisma, {
    workspaceId: 'workspace-1',
    invocationId: 'invocation-1',
    kind: 'acknowledgement',
    sent: true,
  });
});
