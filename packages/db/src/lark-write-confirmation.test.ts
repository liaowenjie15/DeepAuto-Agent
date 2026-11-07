import { expect, mock, test } from 'bun:test';
import {
  consumeLarkWriteConfirmation,
  requestLarkWriteConfirmation,
} from './lark-write-confirmation';

const input = {
  invocationId: 'invocation-1',
  workspaceId: 'workspace-1',
  actorId: 'member-1',
  conversationKey: 'feishu:tenant_test:chat-1:direct',
  appId: 'cli_test_app',
  tenantKey: 'tenant_test',
  action: 'base.delete',
  target: 'app123456/table123456/record123456',
  payload: {
    action: 'base.delete',
    appToken: 'app123456',
    tableId: 'table123456',
    recordId: 'record123456',
  },
};

function createPrisma(confirmationId: string | null, authorized = true) {
  const auditEvent = { create: mock(async () => undefined) };
  const invocation = {
    findFirst: mock(async () =>
      authorized ? { id: input.invocationId } : null,
    ),
  };
  const workspaceMember = {
    findFirst: mock(async () => (authorized ? { id: input.actorId } : null)),
  };
  const larkWriteConfirmation = {
    findFirst: mock(async () =>
      confirmationId
        ? {
            id: confirmationId,
            expiresAt: new Date('2026-11-08T00:00:00.000Z'),
          }
        : null,
    ),
    create: mock(async () => ({ id: 'confirmation-1' })),
    updateMany: mock(async () => ({ count: 1 })),
  };
  const transaction = {
    invocation,
    workspaceMember,
    larkWriteConfirmation,
    auditEvent,
  };
  return {
    prisma: {
      invocation,
      workspaceMember,
      larkWriteConfirmation,
      $transaction: mock(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as never,
    auditEvent,
    invocation,
    larkWriteConfirmation,
  };
}

test('records a confirmation request without storing the delete payload', async () => {
  const { prisma, auditEvent, invocation, larkWriteConfirmation } =
    createPrisma(null);

  const confirmation = await requestLarkWriteConfirmation(prisma, input);

  expect(confirmation?.expiresAt).toBeInstanceOf(Date);
  expect(larkWriteConfirmation.create).toHaveBeenCalledTimes(1);
  expect(invocation.findFirst).toHaveBeenCalledTimes(1);
  expect(auditEvent.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: 'lark.write_confirmation_requested',
    }),
  });
});

test('rejects a confirmation request when authorization is no longer active in the transaction', async () => {
  const { prisma, larkWriteConfirmation } = createPrisma(null, false);

  await expect(requestLarkWriteConfirmation(prisma, input)).resolves.toBeNull();

  expect(larkWriteConfirmation.create).not.toHaveBeenCalled();
});

test('consumes a matching confirmation once before a destructive write', async () => {
  const { prisma, auditEvent, larkWriteConfirmation } =
    createPrisma('confirmation-1');

  await expect(consumeLarkWriteConfirmation(prisma, input)).resolves.toBe(true);

  expect(larkWriteConfirmation.updateMany).toHaveBeenCalledTimes(1);
  expect(auditEvent.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: 'lark.write_confirmation_consumed',
    }),
  });
});
