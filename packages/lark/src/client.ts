import { createHash } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import type { LarkMessageAnchor } from './message-event';

const silentLogger = {
  fatal() {},
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
};

export type FeishuClient = {
  react(anchor: LarkMessageAnchor): Promise<void>;
  reply(
    anchor: LarkMessageAnchor,
    text: string,
    deliveryKey: string,
  ): Promise<string>;
  start(onMessage: (event: unknown) => Promise<void>): Promise<void>;
  close(): void;
};

function deliveryUuid(key: string): string {
  const bytes = createHash('sha256').update(key).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createFeishuClient(configuration: {
  appId: string;
  appSecret: string;
  tenantKey: string;
}): FeishuClient {
  const client = new lark.Client({
    appId: configuration.appId,
    appSecret: configuration.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
    logger: silentLogger,
  });
  const ws = new lark.WSClient({
    appId: configuration.appId,
    appSecret: configuration.appSecret,
    domain: lark.Domain.Feishu,
    logger: silentLogger,
    autoReconnect: true,
  });

  function assertTenant(anchor: LarkMessageAnchor): void {
    if (
      anchor.appId !== configuration.appId ||
      anchor.tenantKey !== configuration.tenantKey
    ) {
      throw new Error('Lark delivery tenant mismatch');
    }
  }

  return {
    async react(anchor) {
      assertTenant(anchor);
      const result = await client.im.messageReaction.create({
        path: { message_id: anchor.messageId },
        data: { reaction_type: { emoji_type: 'OK' } },
      });
      if (result.code !== 0) {
        throw new Error('Lark acknowledgement was rejected');
      }
    },
    async reply(anchor, text, key) {
      assertTenant(anchor);
      const result = await client.im.message.reply({
        path: { message_id: anchor.messageId },
        data: {
          content: JSON.stringify({ text }),
          msg_type: 'text',
          reply_in_thread: true,
          uuid: deliveryUuid(key),
        },
      });
      if (
        result.code !== 0 ||
        !result.data?.message_id ||
        (result.data.chat_id && result.data.chat_id !== anchor.chatId)
      ) {
        throw new Error('Lark reply was rejected');
      }
      return result.data.message_id;
    },
    async start(onMessage) {
      const dispatcher = new lark.EventDispatcher({ logger: silentLogger });
      dispatcher.register({
        'im.message.receive_v1': async (event) => {
          await onMessage(event);
        },
      });
      await ws.start({ eventDispatcher: dispatcher });
    },
    close() {
      ws.close();
    },
  };
}
