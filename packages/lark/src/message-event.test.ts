import { expect, test } from 'bun:test';
import { parseLarkSdkMessage } from './message-event';

const configuration = {
  appId: 'cli_test_app',
  tenantKey: 'tenant_test',
  workspaceId: 'workspace-1',
  botOpenId: 'ou_bot',
};

const event = {
  app_id: 'cli_test_app',
  tenant_key: 'tenant_test',
  sender: {
    sender_type: 'user',
    sender_id: { open_id: 'ou_user' },
  },
  message: {
    message_id: 'om_message',
    chat_id: 'oc_chat',
    chat_type: 'p2p',
    message_type: 'text',
    content: '{"text":"Summarize this thread"}',
    create_time: '1790000000000',
  },
};

test('requires a trusted event-header tenant key that matches configuration', () => {
  expect(parseLarkSdkMessage(event, configuration)).toMatchObject({
    anchor: { tenantKey: 'tenant_test' },
    senderOpenId: 'ou_user',
  });

  expect(
    parseLarkSdkMessage(
      {
        ...event,
        tenant_key: undefined,
      },
      configuration,
    ),
  ).toBeNull();
  expect(
    parseLarkSdkMessage(
      {
        ...event,
        tenant_key: 'tenant_other',
      },
      configuration,
    ),
  ).toBeNull();
});

test('rejects a sender tenant key that conflicts with the trusted event header', () => {
  expect(
    parseLarkSdkMessage(
      {
        ...event,
        sender: { ...event.sender, tenant_key: 'tenant_other' },
      },
      configuration,
    ),
  ).toBeNull();
});

test('reports only a stable rejection category', () => {
  const rejected: string[] = [];

  expect(
    parseLarkSdkMessage(
      { ...event, tenant_key: 'tenant_other' },
      configuration,
      (reason) => rejected.push(reason),
    ),
  ).toBeNull();
  expect(rejected).toEqual(['tenant_mismatch']);
});

test('preserves Docx URLs from a rich-text post message', () => {
  const parsed = parseLarkSdkMessage(
    {
      ...event,
      message: {
        ...event.message,
        message_type: 'post',
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                { tag: 'text', text: '请读取并总结文档' },
                {
                  tag: 'a',
                  text: '测试文档',
                  href: 'https://example.feishu.cn/docx/doc123456',
                },
              ],
            ],
          },
        }),
      },
    },
    configuration,
  );

  expect(parsed?.invocation.instruction).toContain(
    'https://example.feishu.cn/docx/doc123456',
  );
});
