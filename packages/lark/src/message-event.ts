import type { InboundInvocation } from '@deepauto/contracts';
import { z } from 'zod';
import { normalizeLarkMessage } from './normalize-message';

const sdkMessageEventSchema = z.object({
  app_id: z.string().trim().min(1).optional(),
  tenant_key: z.string().trim().min(1),
  sender: z.object({
    sender_type: z.string(),
    sender_id: z.object({
      open_id: z.string().trim().min(1),
    }),
  }),
  message: z.object({
    message_id: z.string().trim().min(1),
    root_id: z.string().trim().min(1).optional(),
    chat_id: z.string().trim().min(1),
    chat_type: z.enum(['p2p', 'group']),
    message_type: z.literal('text'),
    content: z.string(),
    create_time: z.string().regex(/^\d+$/),
    mentions: z
      .array(z.object({ id: z.object({ open_id: z.string().trim().min(1) }) }))
      .optional(),
  }),
});

const textContentSchema = z.object({ text: z.string().trim().min(1).max(16_000) });

export type LarkMessageAnchor = {
  appId: string;
  tenantKey: string;
  chatId: string;
  messageId: string;
};

export type ParsedLarkMessage = {
  invocation: InboundInvocation;
  anchor: LarkMessageAnchor;
  chatType: 'p2p' | 'group';
  senderOpenId: string;
};

export function parseLarkSdkMessage(
  event: unknown,
  input: {
    appId: string;
    tenantKey: string;
    workspaceId: string;
    botOpenId: string;
  },
): ParsedLarkMessage | null {
  const parsed = sdkMessageEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const { app_id, tenant_key, sender, message } = parsed.data;
  if (
    tenant_key !== input.tenantKey ||
    (app_id && app_id !== input.appId) ||
    sender.sender_type !== 'user'
  ) {
    return null;
  }

  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    return null;
  }
  const text = textContentSchema.safeParse(content);
  if (!text.success) return null;
  const createdAt = Number(message.create_time);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return null;
  const receivedAt = new Date(createdAt);
  if (Number.isNaN(receivedAt.getTime())) return null;

  const invocation = normalizeLarkMessage(
    {
      eventId: `${input.appId}:${tenant_key}:${message.message_id}`,
      messageId: message.message_id,
      rootMessageId: message.root_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      senderOpenId: sender.sender_id.open_id,
      senderType: 'user',
      messageType: 'text',
      instruction: text.data.text,
      mentionedOpenIds: message.mentions?.map((mention) => mention.id.open_id) ?? [],
      receivedAt: receivedAt.toISOString(),
      tenantKey: tenant_key,
      appId: input.appId,
    },
    { workspaceId: input.workspaceId, botOpenId: input.botOpenId },
  );
  if (!invocation) return null;

  return {
    invocation,
    chatType: message.chat_type,
    senderOpenId: sender.sender_id.open_id,
    anchor: {
      appId: input.appId,
      tenantKey: tenant_key,
      chatId: message.chat_id,
      messageId: message.message_id,
    },
  };
}
