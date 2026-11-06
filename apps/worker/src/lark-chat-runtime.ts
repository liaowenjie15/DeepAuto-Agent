import {
  claimLarkDelivery,
  claimNextLarkMessage,
  finishLarkDelivery,
  finishLarkProcessing,
  markStaleLarkDeliveriesUnknown,
  markStaleLarkMessagesUnknown,
  type PrismaClient,
} from '@deepauto/db';
import { createFeishuClient } from '@deepauto/lark';
import { runLarkChatAgent, type LarkChatConfiguration } from './lark-chat-agent';

export type LarkChatRuntime = { close(): Promise<void> };

export function startLarkChatRuntime(
  prisma: PrismaClient,
  configuration: LarkChatConfiguration & { repository: string },
): LarkChatRuntime {
  const client = createFeishuClient(configuration);
  let stopped = false;
  let active: Promise<void> | undefined;

  async function deliver(invocationId: string, workspaceId: string, text: string): Promise<void> {
    const message = await prisma.larkMessage.findFirst({
      where: {
        invocationId,
        appId: configuration.appId,
        tenantKey: configuration.tenantKey,
        invocation: { workspaceId },
      },
      select: {
        senderOpenId: true,
        invocation: { select: { actorId: true } },
      },
    });
    if (!message) return;
    const member = await prisma.workspaceMember.findFirst({
      where: {
        id: message.invocation.actorId,
        workspaceId,
        larkOpenId: message.senderOpenId,
        active: true,
      },
      select: { id: true },
    });
    if (!member) return;
    const anchor = await claimLarkDelivery(prisma, {
      workspaceId,
      invocationId,
      kind: 'finalReply',
    });
    if (!anchor) return;
    let replyMessageId: string | undefined;
    try {
      replyMessageId = await client.reply(anchor, text.slice(0, 3_500), `lark-final:${invocationId}`);
    } finally {
      await finishLarkDelivery(prisma, {
        workspaceId,
        invocationId,
        kind: 'finalReply',
        sent: Boolean(replyMessageId),
        replyMessageId,
      });
    }
  }

  async function processQueued(): Promise<void> {
    const message = await claimNextLarkMessage(prisma, configuration);
    if (!message) return;
    try {
      const result = await runLarkChatAgent(prisma, configuration, {
        invocationId: message.invocationId,
        workspaceId: message.workspaceId,
        actorId: message.actorId,
        senderOpenId: message.senderOpenId,
        conversationKey: message.conversationKey,
        chatType: message.chatType,
        instruction: message.instruction,
      });
      await finishLarkProcessing(prisma, {
        id: message.id,
        workspaceId: message.workspaceId,
        state: result.waitingPr ? 'WAITING_PR' : 'COMPLETED',
        finalText: result.waitingPr ? undefined : result.text,
      });
      if (!result.waitingPr) {
        await deliver(message.invocationId, message.workspaceId, result.text);
      }
    } catch {
      await finishLarkProcessing(prisma, {
        id: message.id,
        workspaceId: message.workspaceId,
        state: 'UNKNOWN',
      }).catch(() => undefined);
      await deliver(
        message.invocationId,
        message.workspaceId,
        '本次处理结果不确定，请核对相关资源或任务状态。',
      ).catch(() => undefined);
    }
  }

  async function processFinals(): Promise<void> {
    const messages = await prisma.larkMessage.findMany({
      where: {
        appId: configuration.appId,
        tenantKey: configuration.tenantKey,
        invocation: { workspaceId: configuration.workspaceId },
        finalReply: 'PENDING',
        processingState: { in: ['WAITING_PR', 'COMPLETED', 'FAILED', 'UNKNOWN'] },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: {
        id: true,
        invocationId: true,
        processingState: true,
        finalText: true,
        invocation: {
          select: {
            workspaceId: true,
            job: {
              select: {
                status: true,
                attempts: {
                  orderBy: { number: 'desc' },
                  take: 1,
                  select: {
                    execution: {
                      select: {
                        reason: true,
                        artifacts: {
                          where: { name: 'PULL_REQUEST' },
                          select: { value: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    for (const message of messages) {
      if (message.processingState === 'COMPLETED') {
        if (message.finalText) {
          await deliver(message.invocationId, message.invocation.workspaceId, message.finalText);
        }
        continue;
      }
      if (message.processingState === 'WAITING_PR') {
        const job = message.invocation.job;
        if (!job || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) continue;
        const artifact = job.attempts[0]?.execution?.artifacts[0]?.value;
        const prefix = `https://github.com/${configuration.repository}/pull/`;
        const prUrl = artifact?.startsWith(prefix) && /^\d+$/.test(artifact.slice(prefix.length))
          ? artifact
          : null;
        const text = job.status === 'COMPLETED'
          ? (prUrl ? `PR 已创建：${prUrl}` : '代码任务已完成，但没有收到可验证的 PR 链接，请查看执行记录。')
          : `代码任务${job.status === 'CANCELLED' ? '已取消' : '失败'}，未交付 PR。`;
        const updated = await prisma.larkMessage.updateMany({
          where: { id: message.id, processingState: 'WAITING_PR' },
          data: {
            processingState: job.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
            processingFinishedAt: new Date(),
            finalText: text,
          },
        });
        if (updated.count === 1) await deliver(message.invocationId, message.invocation.workspaceId, text);
      } else {
        await deliver(
          message.invocationId,
          message.invocation.workspaceId,
          message.processingState === 'FAILED'
            ? (message.finalText ?? '本次任务未能完成。')
            : '本次处理结果不确定，请核对相关资源或任务状态。',
        );
      }
    }
  }

  async function tick(): Promise<void> {
    if (stopped || active) return;
    active = (async () => {
      await markStaleLarkDeliveriesUnknown(prisma, {
        appId: configuration.appId,
        tenantKey: configuration.tenantKey,
        workspaceId: configuration.workspaceId,
        before: new Date(Date.now() - 10 * 60_000),
      });
      await markStaleLarkMessagesUnknown(prisma, {
        appId: configuration.appId,
        tenantKey: configuration.tenantKey,
        workspaceId: configuration.workspaceId,
        before: new Date(Date.now() - 10 * 60_000),
      });
      await processFinals();
      await processQueued();
    })();
    try {
      await active;
    } finally {
      active = undefined;
    }
  }

  const timer = setInterval(() => { void tick().catch(() => undefined); }, 1_000);
  void tick().catch(() => undefined);
  return {
    async close() {
      stopped = true;
      clearInterval(timer);
      await active;
      client.close();
    },
  };
}
