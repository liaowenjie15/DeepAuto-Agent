import type { InboundInvocation } from '@deepauto/contracts';
import { z } from 'zod';
import { normalizeLarkMessage } from './normalize-message';

const sdkMessageEventSchema = z.object({
  app_id: z.string().trim().min(1).optional(),
  tenant_key: z.string().trim().min(1),
  sender: z.object({
    sender_type: z.string(),
    tenant_key: z.string().trim().min(1).optional(),
    sender_id: z.object({
      open_id: z.string().trim().min(1),
    }),
  }),
  message: z.object({
    message_id: z.string().trim().min(1),
    root_id: z.string().trim().min(1).optional(),
    chat_id: z.string().trim().min(1),
    chat_type: z.enum(['p2p', 'group']),
    message_type: z.enum(['text', 'post']),
    content: z.string(),
    create_time: z.string().regex(/^\d+$/),
    mentions: z
      .array(z.object({ id: z.object({ open_id: z.string().trim().min(1) }) }))
      .optional(),
  }),
});

const textContentSchema = z.object({
  text: z.string().trim().min(1).max(16_000),
});

const postElementSchema = z.object({
  tag: z.string().trim().min(1),
  text: z.string().trim().min(1).max(16_000).optional(),
  href: z.url().max(4_096).optional(),
});

const postContentSchema = z.record(
  z.string().trim().min(1),
  z.object({
    content: z.array(z.array(postElementSchema)).min(1),
  }),
);

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

export type LarkMessageRejectReason =
  | 'invalid_event'
  | 'tenant_mismatch'
  | 'app_mismatch'
  | 'unsupported_sender'
  | 'invalid_content'
  | 'invalid_timestamp'
  | 'normalization_rejected';

type LarkMessageRejectionObserver = (reason: LarkMessageRejectReason) => void;

function reject(
  observer: LarkMessageRejectionObserver | undefined,
  reason: LarkMessageRejectReason,
): null {
  observer?.(reason);
  return null;
}

function instructionFromContent(
  messageType: 'text' | 'post',
  content: unknown,
): string | null {
  if (messageType === 'text') {
    const text = textContentSchema.safeParse(content);
    return text.success ? text.data.text : null;
  }
  const post = postContentSchema.safeParse(content);
  if (!post.success) return null;
  const parts = Object.values(post.data).flatMap((locale) =>
    locale.content.flatMap((line) =>
      line.flatMap((element) => [element.text, element.href].filter(Boolean)),
    ),
  );
  const text = textContentSchema.safeParse({ text: parts.join(' ') });
  return text.success ? text.data.text : null;
}

export function parseLarkSdkMessage(
  event: unknown,
  input: {
    appId: string;
    tenantKey: string;
    workspaceId: string;
    botOpenId: string;
  },
  onRejected?: LarkMessageRejectionObserver,
): ParsedLarkMessage | null {
  const parsed = sdkMessageEventSchema.safeParse(event);
  if (!parsed.success) return reject(onRejected, 'invalid_event');
  const { app_id, sender, message } = parsed.data;
  const tenantKey = parsed.data.tenant_key;
  if (tenantKey !== input.tenantKey)
    return reject(onRejected, 'tenant_mismatch');
  if (sender.tenant_key !== undefined && sender.tenant_key !== tenantKey)
    return reject(onRejected, 'tenant_mismatch');
  if (app_id && app_id !== input.appId)
    return reject(onRejected, 'app_mismatch');
  if (sender.sender_type !== 'user')
    return reject(onRejected, 'unsupported_sender');

  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    return reject(onRejected, 'invalid_content');
  }
  const instruction = instructionFromContent(message.message_type, content);
  if (!instruction) return reject(onRejected, 'invalid_content');
  const createdAt = Number(message.create_time);
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0)
    return reject(onRejected, 'invalid_timestamp');
  const receivedAt = new Date(createdAt);
  if (Number.isNaN(receivedAt.getTime()))
    return reject(onRejected, 'invalid_timestamp');

  const invocation = normalizeLarkMessage(
    {
      eventId: `${input.appId}:${tenantKey}:${message.message_id}`,
      messageId: message.message_id,
      rootMessageId: message.root_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      senderOpenId: sender.sender_id.open_id,
      senderType: 'user',
      messageType: 'text',
      instruction,
      mentionedOpenIds:
        message.mentions?.map((mention) => mention.id.open_id) ?? [],
      receivedAt: receivedAt.toISOString(),
      tenantKey,
      appId: input.appId,
    },
    { workspaceId: input.workspaceId, botOpenId: input.botOpenId },
  );
  if (!invocation) return reject(onRejected, 'normalization_rejected');

  return {
    invocation,
    chatType: message.chat_type,
    senderOpenId: sender.sender_id.open_id,
    anchor: {
      appId: input.appId,
      tenantKey,
      chatId: message.chat_id,
      messageId: message.message_id,
    },
  };
}
