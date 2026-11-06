import type { AuthorizedInvocation } from './authorization';
import type { PrismaClient } from './generated/prisma/client';

type LarkAnchor = {
  appId: string;
  tenantKey: string;
  chatId: string;
  messageId: string;
};

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

export async function createOrGetLarkMessage(
  prisma: PrismaClient,
  input: {
    authorized: AuthorizedInvocation;
    anchor: LarkAnchor;
    senderOpenId: string;
    chatType: 'p2p' | 'group';
  },
): Promise<{ invocationId: string; created: boolean }> {
  if (input.authorized.source !== 'feishu') {
    throw new Error('Lark message requires a Feishu invocation');
  }

  try {
    const invocation = await prisma.invocation.create({
      data: {
        source: 'FEISHU',
        workspaceId: input.authorized.workspaceId,
        actorId: input.authorized.actorId,
        conversationKey: input.authorized.conversationKey,
        anchor: 'MESSAGE',
        instruction: input.authorized.instruction,
        sourceEventId: input.authorized.sourceEventId,
        receivedAt: new Date(input.authorized.receivedAt),
        larkMessage: {
          create: {
            ...input.anchor,
            senderOpenId: input.senderOpenId,
            chatType: input.chatType === 'p2p' ? 'P2P' : 'GROUP',
          },
        },
      },
      select: { id: true },
    });
    return { invocationId: invocation.id, created: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    const existing = await prisma.larkMessage.findUnique({
      where: {
        appId_tenantKey_messageId: {
          appId: input.anchor.appId,
          tenantKey: input.anchor.tenantKey,
          messageId: input.anchor.messageId,
        },
      },
      select: {
        chatId: true,
        senderOpenId: true,
        chatType: true,
        invocationId: true,
        invocation: {
          select: {
            workspaceId: true,
            actorId: true,
            sourceEventId: true,
            conversationKey: true,
          },
        },
      },
    });
    if (
      !existing ||
      existing.chatId !== input.anchor.chatId ||
      existing.senderOpenId !== input.senderOpenId ||
      existing.chatType !== (input.chatType === 'p2p' ? 'P2P' : 'GROUP') ||
      existing.invocation.workspaceId !== input.authorized.workspaceId ||
      existing.invocation.actorId !== input.authorized.actorId ||
      existing.invocation.sourceEventId !== input.authorized.sourceEventId ||
      existing.invocation.conversationKey !==
        input.authorized.conversationKey
    ) {
      throw new Error('Lark message identity conflict');
    }
    return { invocationId: existing.invocationId, created: false };
  }
}

export async function claimLarkDelivery(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    invocationId: string;
    kind: 'acknowledgement' | 'finalReply';
  },
): Promise<LarkAnchor | null> {
  const claimed = await prisma.larkMessage.updateMany({
    where: {
      invocationId: input.invocationId,
      invocation: { workspaceId: input.workspaceId },
      [input.kind]: 'PENDING',
    },
    data: {
      [input.kind]: 'CLAIMED',
      [input.kind === 'acknowledgement' ? 'acknowledgementAt' : 'finalReplyAt']: new Date(),
    },
  });
  if (claimed.count !== 1) return null;

  const anchor = await prisma.larkMessage.findUnique({
    where: { invocationId: input.invocationId },
    select: {
      appId: true,
      tenantKey: true,
      chatId: true,
      messageId: true,
    },
  });
  if (!anchor) throw new Error('Claimed Lark delivery has no anchor');
  return anchor;
}

export async function finishLarkDelivery(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    invocationId: string;
    kind: 'acknowledgement' | 'finalReply';
    sent: boolean;
    replyMessageId?: string;
  },
): Promise<void> {
  const updated = await prisma.larkMessage.updateMany({
    where: {
      invocationId: input.invocationId,
      invocation: { workspaceId: input.workspaceId },
      [input.kind]: 'CLAIMED',
    },
    data: {
      [input.kind]: input.sent ? 'SENT' : 'UNKNOWN',
      ...(input.kind === 'acknowledgement'
        ? { acknowledgementAt: new Date() }
        : {
            finalReplyAt: new Date(),
            finalReplyMessageId: input.sent ? input.replyMessageId : undefined,
          }),
    },
  });
  if (updated.count !== 1) throw new Error('Lark delivery claim was lost');
}

export type ClaimedLarkMessage = {
  id: string;
  invocationId: string;
  workspaceId: string;
  actorId: string;
  senderOpenId: string;
  instruction: string;
  conversationKey: string;
  chatType: 'p2p' | 'group';
  anchor: LarkAnchor;
};

export async function claimNextLarkMessage(
  prisma: PrismaClient,
  input: { appId: string; tenantKey: string; workspaceId: string },
): Promise<ClaimedLarkMessage | null> {
  const candidate = await prisma.larkMessage.findFirst({
    where: {
      appId: input.appId,
      tenantKey: input.tenantKey,
      processingState: 'QUEUED',
      invocation: { workspaceId: input.workspaceId },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      invocation: {
        select: {
          workspaceId: true,
          actorId: true,
          instruction: true,
          conversationKey: true,
        },
      },
    },
  });
  if (!candidate) return null;

  const earlier = await prisma.larkMessage.findFirst({
    where: {
      id: { not: candidate.id },
      invocation: {
        workspaceId: input.workspaceId,
        conversationKey: candidate.invocation.conversationKey,
      },
      OR: [
        { createdAt: { lt: candidate.createdAt } },
        { createdAt: candidate.createdAt, id: { lt: candidate.id } },
      ],
      processingState: { in: ['QUEUED', 'CLAIMED', 'WAITING_PR'] },
    },
    select: { id: true },
  });
  if (earlier) return null;

  const claimed = await prisma.larkMessage.updateMany({
    where: {
      id: candidate.id,
      appId: input.appId,
      tenantKey: input.tenantKey,
      processingState: 'QUEUED',
    },
    data: { processingState: 'CLAIMED', processingStartedAt: new Date() },
  });
  if (claimed.count !== 1) return null;

  const member = await prisma.workspaceMember.findFirst({
    where: {
      id: candidate.invocation.actorId,
      workspaceId: candidate.invocation.workspaceId,
      active: true,
      larkOpenId: candidate.senderOpenId,
    },
    select: { id: true },
  });
  if (!member) {
    await prisma.larkMessage.updateMany({
      where: { id: candidate.id, processingState: 'CLAIMED' },
      data: { processingState: 'FAILED', processingFinishedAt: new Date() },
    });
    return null;
  }

  return {
    id: candidate.id,
    invocationId: candidate.invocationId,
    workspaceId: candidate.invocation.workspaceId,
    actorId: candidate.invocation.actorId,
    senderOpenId: candidate.senderOpenId,
    instruction: candidate.invocation.instruction,
    conversationKey: candidate.invocation.conversationKey,
    chatType: candidate.chatType === 'P2P' ? 'p2p' : 'group',
    anchor: {
      appId: candidate.appId,
      tenantKey: candidate.tenantKey,
      chatId: candidate.chatId,
      messageId: candidate.messageId,
    },
  };
}

export async function markStaleLarkMessagesUnknown(
  prisma: PrismaClient,
  input: { appId: string; tenantKey: string; workspaceId: string; before: Date },
): Promise<number> {
  const result = await prisma.larkMessage.updateMany({
    where: {
      appId: input.appId,
      tenantKey: input.tenantKey,
      invocation: { workspaceId: input.workspaceId },
      processingState: 'CLAIMED',
      processingStartedAt: { lt: input.before },
    },
    data: { processingState: 'UNKNOWN', processingFinishedAt: new Date() },
  });
  return result.count;
}

export async function markStaleLarkDeliveriesUnknown(
  prisma: PrismaClient,
  input: { appId: string; tenantKey: string; workspaceId: string; before: Date },
): Promise<void> {
  const scope = {
    appId: input.appId,
    tenantKey: input.tenantKey,
    invocation: { workspaceId: input.workspaceId },
  };
  await prisma.larkMessage.updateMany({
    where: { ...scope, acknowledgement: 'CLAIMED', acknowledgementAt: { lt: input.before } },
    data: { acknowledgement: 'UNKNOWN' },
  });
  await prisma.larkMessage.updateMany({
    where: { ...scope, finalReply: 'CLAIMED', finalReplyAt: { lt: input.before } },
    data: { finalReply: 'UNKNOWN' },
  });
}

export async function finishLarkProcessing(
  prisma: PrismaClient,
  input: {
    id: string;
    workspaceId: string;
    state: 'WAITING_PR' | 'COMPLETED' | 'FAILED' | 'UNKNOWN';
    finalText?: string;
  },
): Promise<void> {
  const updated = await prisma.larkMessage.updateMany({
    where: {
      id: input.id,
      processingState: 'CLAIMED',
      invocation: { workspaceId: input.workspaceId },
    },
    data: {
      processingState: input.state,
      finalText: input.finalText?.slice(0, 3_500),
      processingFinishedAt:
        input.state === 'WAITING_PR' ? null : new Date(),
    },
  });
  if (updated.count !== 1) throw new Error('Lark processing claim was lost');
}
