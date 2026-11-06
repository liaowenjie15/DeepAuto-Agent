import type { PrismaClient } from '@deepauto/db';
import {
  authorizeInboundInvocation,
  claimLarkDelivery,
  createOrGetLarkMessage,
  finishLarkDelivery,
} from '@deepauto/db';
import {
  type FeishuClient,
  parseLarkSdkMessage,
} from '@deepauto/lark';

export type LarkIngressConfiguration = {
  appId: string;
  tenantKey: string;
  workspaceId: string;
  botOpenId: string;
  allowedGroupChatIds: readonly string[];
  client: FeishuClient;
};

export function createLarkIngress(
  prisma: PrismaClient,
  configuration: LarkIngressConfiguration,
) {
  const allowedGroups = new Set(configuration.allowedGroupChatIds);

  async function handle(event: unknown): Promise<void> {
    const message = parseLarkSdkMessage(event, configuration);
    if (!message) return;
    if (
      message.chatType === 'group' &&
      !allowedGroups.has(message.anchor.chatId)
    ) {
      return;
    }

    const authorized = await authorizeInboundInvocation(
      prisma,
      message.invocation,
    );
    if (!authorized) return;

    const stored = await createOrGetLarkMessage(prisma, {
      authorized,
      anchor: message.anchor,
      senderOpenId: message.senderOpenId,
      chatType: message.chatType,
    });
    const anchor = await claimLarkDelivery(prisma, {
      workspaceId: authorized.workspaceId,
      invocationId: stored.invocationId,
      kind: 'acknowledgement',
    });
    if (!anchor) return;
    let sent = false;
    try {
      await configuration.client.react(anchor);
      sent = true;
    } catch {
      // The database claim prevents a second reaction after an unknown result.
    } finally {
      await finishLarkDelivery(prisma, {
        workspaceId: authorized.workspaceId,
        invocationId: stored.invocationId,
        kind: 'acknowledgement',
        sent,
      });
    }
  }

  return {
    handle,
    start: () => configuration.client.start(handle),
    close: () => configuration.client.close(),
  };
}
