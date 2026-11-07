import type { PrismaClient } from '@deepauto/db';
import {
  authorizeInboundInvocation,
  createOrGetLarkMessage,
} from '@deepauto/db';
import { type FeishuClient, parseLarkSdkMessage } from '@deepauto/lark';

export type LarkIngressConfiguration = {
  appId: string;
  tenantKey: string;
  workspaceId: string;
  botOpenId: string;
  allowedGroupChatIds: readonly string[];
  client: FeishuClient;
};

export type LarkIngressDependencies = {
  authorizeInboundInvocation: typeof authorizeInboundInvocation;
  createOrGetLarkMessage: typeof createOrGetLarkMessage;
  parseLarkSdkMessage: typeof parseLarkSdkMessage;
};

const defaultDependencies: LarkIngressDependencies = {
  authorizeInboundInvocation,
  createOrGetLarkMessage,
  parseLarkSdkMessage,
};

export function createLarkIngress(
  prisma: PrismaClient,
  configuration: LarkIngressConfiguration,
  dependencies: LarkIngressDependencies = defaultDependencies,
  canAccept: () => boolean = () => true,
) {
  const allowedGroups = new Set(configuration.allowedGroupChatIds);
  const lastReportedAt = new Map<string, number>();

  function reportRejected(reason: string): void {
    const now = Date.now();
    const lastReported = lastReportedAt.get(reason);
    if (lastReported !== undefined && now - lastReported < 60_000) return;
    lastReportedAt.set(reason, now);
    console.warn(`Lark ingress rejected: ${reason}`);
  }

  async function handle(event: unknown): Promise<void> {
    if (!canAccept()) return;
    const message = dependencies.parseLarkSdkMessage(
      event,
      configuration,
      reportRejected,
    );
    if (!message) return;
    if (
      message.chatType === 'group' &&
      !allowedGroups.has(message.anchor.chatId)
    ) {
      reportRejected('group_not_allowed');
      return;
    }

    const authorized = await dependencies.authorizeInboundInvocation(
      prisma,
      message.invocation,
    );
    if (!authorized) {
      reportRejected('unauthorized_member');
      return;
    }

    await dependencies.createOrGetLarkMessage(prisma, {
      authorized,
      anchor: message.anchor,
      senderOpenId: message.senderOpenId,
      chatType: message.chatType,
    });
  }

  return {
    handle,
    start: () => configuration.client.start(handle),
    close: () => configuration.client.close(),
  };
}
