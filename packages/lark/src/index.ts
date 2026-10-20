import {
  type InboundInvocation,
  inboundInvocationSchema,
} from '@deepauto/contracts';
import { z } from 'zod';

const larkMessageSchema = z.object({
  eventId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  rootMessageId: z.string().trim().min(1).optional(),
  chatId: z.string().trim().min(1),
  chatType: z.enum(['p2p', 'group']),
  senderOpenId: z.string().trim().min(1),
  senderType: z.enum(['user', 'bot']),
  messageType: z.literal('text'),
  instruction: z.string().trim().min(1),
  mentionedOpenIds: z.array(z.string().trim().min(1)),
  receivedAt: z.iso.datetime(),
});

export function normalizeLarkMessage(
  payload: unknown,
  input: { workspaceId: string; botOpenId: string },
): InboundInvocation | null {
  const parsed = larkMessageSchema.safeParse(payload);
  if (!parsed.success) return null;

  const message = parsed.data;
  if (message.senderType === 'bot') return null;
  if (
    message.chatType === 'group' &&
    !message.mentionedOpenIds.includes(input.botOpenId)
  ) {
    return null;
  }

  return inboundInvocationSchema.parse({
    source: 'feishu',
    workspaceId: input.workspaceId,
    actorId: message.senderOpenId,
    providerActorId: message.senderOpenId,
    conversationKey: `feishu:${message.chatId}:${message.rootMessageId ?? message.messageId}`,
    anchor: 'message',
    instruction: message.instruction,
    sourceEventId: message.eventId,
    idempotencyKey: `feishu:message:${message.messageId}`,
    receivedAt: message.receivedAt,
  });
}
