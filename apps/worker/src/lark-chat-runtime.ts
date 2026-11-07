import {
  claimLarkDelivery,
  claimNextLarkMessage,
  finishLarkDelivery,
  finishLarkProcessing,
  markStaleLarkDeliveriesUnknown,
  markStaleLarkMessagesUnknown,
  type PrismaClient,
} from '@deepauto/db';
import { createFeishuClient, type FeishuClient } from '@deepauto/lark';
import {
  type LarkChatConfiguration,
  runLarkChatAgent,
} from './lark-chat-agent';

export type LarkChatRuntime = { close(): Promise<void> };

export type LarkChatFailureCategory =
  | 'workspace_mismatch'
  | 'oauth'
  | 'lark_data'
  | 'model_configuration'
  | 'timeout'
  | 'unexpected';

export type LarkChatRuntimeDependencies = {
  createFeishuClient: typeof createFeishuClient;
  claimLarkDelivery: typeof claimLarkDelivery;
  claimNextLarkMessage: typeof claimNextLarkMessage;
  finishLarkDelivery: typeof finishLarkDelivery;
  finishLarkProcessing: typeof finishLarkProcessing;
  markStaleLarkDeliveriesUnknown: typeof markStaleLarkDeliveriesUnknown;
  markStaleLarkMessagesUnknown: typeof markStaleLarkMessagesUnknown;
  runLarkChatAgent: typeof runLarkChatAgent;
};

const defaultDependencies: LarkChatRuntimeDependencies = {
  createFeishuClient,
  claimLarkDelivery,
  claimNextLarkMessage,
  finishLarkDelivery,
  finishLarkProcessing,
  markStaleLarkDeliveriesUnknown,
  markStaleLarkMessagesUnknown,
  runLarkChatAgent,
};

export function larkChatFailureCategory(
  error: unknown,
): LarkChatFailureCategory {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Lark workspace mismatch') return 'workspace_mismatch';
  if (message.startsWith('Lark OAuth ')) return 'oauth';
  if (message.startsWith('Lark bot authorization')) return 'lark_data';
  if (message.startsWith('Lark data ')) return 'lark_data';
  if (message === 'Codex Responses URL is invalid') {
    return 'model_configuration';
  }
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return 'timeout';
  }
  return 'unexpected';
}

export function startLarkChatRuntime(
  prisma: PrismaClient,
  configuration: LarkChatConfiguration & { repository: string },
  preparedClient?: FeishuClient,
  dependencies: LarkChatRuntimeDependencies = defaultDependencies,
): LarkChatRuntime {
  const client =
    preparedClient ?? dependencies.createFeishuClient(configuration);
  let stopped = false;
  let active: Promise<void> | undefined;

  function replyContext(workspaceId: string, invocationId: string): string {
    return `lark-reply:${workspaceId}:${invocationId}`;
  }

  function protectReply(
    workspaceId: string,
    invocationId: string,
    text: string,
  ): string {
    return configuration.cipher.encrypt(
      text.slice(0, 3_500),
      replyContext(workspaceId, invocationId),
    );
  }

  function openReply(
    workspaceId: string,
    invocationId: string,
    ciphertext: string,
  ): string {
    return configuration.cipher.decrypt(
      ciphertext,
      replyContext(workspaceId, invocationId),
    );
  }

  async function deliver(
    invocationId: string,
    workspaceId: string,
    text: string,
  ): Promise<void> {
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
    const anchor = await dependencies.claimLarkDelivery(prisma, {
      workspaceId,
      invocationId,
      kind: 'finalReply',
    });
    if (!anchor) return;
    let replyMessageId: string | undefined;
    try {
      replyMessageId = await client.reply(
        anchor,
        text.slice(0, 3_500),
        `lark-final:${invocationId}`,
      );
    } finally {
      await dependencies.finishLarkDelivery(prisma, {
        workspaceId,
        invocationId,
        kind: 'finalReply',
        sent: Boolean(replyMessageId),
        replyMessageId,
      });
    }
  }

  async function acknowledge(
    invocationId: string,
    workspaceId: string,
  ): Promise<void> {
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
    const anchor = await dependencies.claimLarkDelivery(prisma, {
      workspaceId,
      invocationId,
      kind: 'acknowledgement',
    });
    if (!anchor) return;
    let sent = false;
    try {
      await client.react(anchor);
      sent = true;
    } finally {
      await dependencies.finishLarkDelivery(prisma, {
        workspaceId,
        invocationId,
        kind: 'acknowledgement',
        sent,
      });
    }
  }

  async function processAcknowledgements(): Promise<void> {
    const messages = await prisma.larkMessage.findMany({
      where: {
        appId: configuration.appId,
        tenantKey: configuration.tenantKey,
        acknowledgement: 'PENDING',
        invocation: { workspaceId: configuration.workspaceId },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: {
        invocationId: true,
        invocation: { select: { workspaceId: true } },
      },
    });
    for (const message of messages) {
      await acknowledge(message.invocationId, message.invocation.workspaceId);
    }
  }

  async function processQueued(): Promise<void> {
    const message = await dependencies.claimNextLarkMessage(
      prisma,
      configuration,
    );
    if (!message) return;
    try {
      const result = await dependencies.runLarkChatAgent(
        prisma,
        configuration,
        {
          invocationId: message.invocationId,
          workspaceId: message.workspaceId,
          actorId: message.actorId,
          senderOpenId: message.senderOpenId,
          conversationKey: message.conversationKey,
          chatType: message.chatType,
          instruction: message.instruction,
        },
      );
      await dependencies.finishLarkProcessing(prisma, {
        id: message.id,
        workspaceId: message.workspaceId,
        state: result.waitingPr ? 'WAITING_PR' : 'COMPLETED',
        finalText: result.waitingPr
          ? undefined
          : protectReply(
              message.workspaceId,
              message.invocationId,
              result.text,
            ),
      });
      if (!result.waitingPr) {
        await deliver(message.invocationId, message.workspaceId, result.text);
      }
    } catch (error) {
      await prisma.auditEvent
        .create({
          data: {
            workspaceId: message.workspaceId,
            actorId: message.actorId,
            action: 'lark.chat_processing_failed',
            metadata: { category: larkChatFailureCategory(error) },
          },
        })
        .catch(() => undefined);
      const prJob = await prisma.job
        .findFirst({
          where: {
            invocationId: message.invocationId,
            invocation: {
              workspaceId: message.workspaceId,
              actorId: message.actorId,
              source: 'FEISHU',
            },
          },
          select: { id: true },
        })
        .catch(() => null);
      await dependencies
        .finishLarkProcessing(prisma, {
          id: message.id,
          workspaceId: message.workspaceId,
          state: prJob ? 'WAITING_PR' : 'UNKNOWN',
        })
        .catch(() => undefined);
      if (!prJob) {
        await deliver(
          message.invocationId,
          message.workspaceId,
          '本次处理结果不确定，请核对相关资源或任务状态。',
        ).catch(() => undefined);
      }
    }
  }

  async function processFinals(): Promise<void> {
    const select = {
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
    } as const;
    const scope = {
      appId: configuration.appId,
      tenantKey: configuration.tenantKey,
      invocation: { workspaceId: configuration.workspaceId },
      finalReply: 'PENDING' as const,
    };
    const terminals = await prisma.larkMessage.findMany({
      where: {
        ...scope,
        processingState: { in: ['COMPLETED', 'FAILED', 'UNKNOWN'] },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select,
    });
    const pendingPrs = await prisma.larkMessage.findMany({
      where: { ...scope, processingState: 'WAITING_PR' },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select,
    });
    const messages = [...terminals, ...pendingPrs];
    for (const message of messages) {
      if (message.processingState === 'COMPLETED') {
        if (message.finalText) {
          await deliver(
            message.invocationId,
            message.invocation.workspaceId,
            openReply(
              message.invocation.workspaceId,
              message.invocationId,
              message.finalText,
            ),
          );
        }
        continue;
      }
      if (message.processingState === 'WAITING_PR') {
        const job = message.invocation.job;
        if (!job || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status))
          continue;
        const artifact = job.attempts[0]?.execution?.artifacts[0]?.value;
        const prefix = `https://github.com/${configuration.repository}/pull/`;
        const prUrl =
          artifact?.startsWith(prefix) &&
          /^\d+$/.test(artifact.slice(prefix.length))
            ? artifact
            : null;
        const text =
          job.status === 'COMPLETED'
            ? prUrl
              ? `PR 已创建：${prUrl}`
              : '代码任务已完成，但没有收到可验证的 PR 链接，请查看执行记录。'
            : `代码任务${job.status === 'CANCELLED' ? '已取消' : '失败'}，未交付 PR。`;
        const updated = await prisma.larkMessage.updateMany({
          where: { id: message.id, processingState: 'WAITING_PR' },
          data: {
            processingState:
              job.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
            processingFinishedAt: new Date(),
            finalText: protectReply(
              message.invocation.workspaceId,
              message.invocationId,
              text,
            ),
          },
        });
        if (updated.count === 1)
          await deliver(
            message.invocationId,
            message.invocation.workspaceId,
            text,
          );
      } else {
        if (message.processingState === 'UNKNOWN' && message.invocation.job) {
          await prisma.larkMessage.updateMany({
            where: { id: message.id, processingState: 'UNKNOWN' },
            data: { processingState: 'WAITING_PR', processingFinishedAt: null },
          });
          continue;
        }
        await deliver(
          message.invocationId,
          message.invocation.workspaceId,
          message.processingState === 'FAILED'
            ? message.finalText
              ? openReply(
                  message.invocation.workspaceId,
                  message.invocationId,
                  message.finalText,
                )
              : '本次任务未能完成。'
            : '本次处理结果不确定，请核对相关资源或任务状态。',
        );
      }
    }
  }

  async function tick(): Promise<void> {
    if (stopped || active) return;
    active = (async () => {
      await dependencies.markStaleLarkDeliveriesUnknown(prisma, {
        appId: configuration.appId,
        tenantKey: configuration.tenantKey,
        workspaceId: configuration.workspaceId,
        before: new Date(Date.now() - 10 * 60_000),
      });
      await dependencies.markStaleLarkMessagesUnknown(prisma, {
        appId: configuration.appId,
        tenantKey: configuration.tenantKey,
        workspaceId: configuration.workspaceId,
        before: new Date(Date.now() - 10 * 60_000),
      });
      await processAcknowledgements();
      await processFinals();
      await processQueued();
    })();
    try {
      await active?.catch(() => undefined);
    } finally {
      active = undefined;
    }
  }

  const timer = setInterval(() => {
    void tick().catch(() => undefined);
  }, 1_000);
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
