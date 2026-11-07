import { expect, mock, test } from 'bun:test';
import {
  type LarkIngressLeaseStore,
  startLarkIngressLeader,
} from './lark-ingress-leader';

function createStore(values: Array<string | number | null>) {
  return {
    set: mock(async () => values.shift() as string | null),
    eval: mock(async () => values.shift()),
    quit: mock(async () => undefined),
  } as LarkIngressLeaseStore;
}

const scope = {
  appId: 'cli_test_app',
  tenantKey: 'tenant_test',
  workspaceId: 'workspace-1',
  ownerId: 'gateway-1',
  ttlMilliseconds: 3_000,
  renewIntervalMilliseconds: 1_000,
};

test('starts ingress only after it owns and confirms the lease', async () => {
  const store = createStore(['OK', 1, 1]);
  let canAccept: (() => boolean) | undefined;
  let acceptedWhileStarting = true;
  const ingress = {
    start: mock(async () => {
      acceptedWhileStarting = canAccept?.() ?? true;
    }),
    close: mock(),
  };
  const leader = await startLarkIngressLeader({
    ...scope,
    store,
    createIngress: (accept) => {
      canAccept = accept;
      return ingress;
    },
  });

  expect(ingress.start).toHaveBeenCalledTimes(1);
  expect(acceptedWhileStarting).toBe(false);
  expect(canAccept?.()).toBe(true);

  await leader.refresh();
  expect(store.eval).toHaveBeenCalledTimes(2);

  await leader.close();
  expect(ingress.close).toHaveBeenCalledTimes(1);
  expect(canAccept?.()).toBe(false);
});

test('stops accepting messages immediately after losing the lease', async () => {
  const store = createStore(['OK', 1, 0, 0]);
  let canAccept: (() => boolean) | undefined;
  const ingress = { start: mock(async () => undefined), close: mock() };
  const leader = await startLarkIngressLeader({
    ...scope,
    store,
    createIngress: (accept) => {
      canAccept = accept;
      return ingress;
    },
  });

  await leader.refresh();

  expect(ingress.close).toHaveBeenCalledTimes(1);
  expect(canAccept?.()).toBe(false);
  await leader.close();
});

test('keeps a standby gateway from creating a Feishu ingress', async () => {
  const store = createStore([null]);
  const createIngress = mock();
  const leader = await startLarkIngressLeader({
    ...scope,
    store,
    createIngress,
  });

  expect(createIngress).not.toHaveBeenCalled();
  await leader.close();
  expect(store.eval).not.toHaveBeenCalled();
});

test('fails closed when the lease backend is unavailable at startup', async () => {
  const store = {
    set: mock(async () => {
      throw new Error('Redis connection failed');
    }),
    eval: mock(),
    quit: mock(),
  } as LarkIngressLeaseStore;
  const createIngress = mock();

  await expect(
    startLarkIngressLeader({ ...scope, store, createIngress }),
  ).rejects.toThrow('Lark ingress lease is unavailable');
  expect(createIngress).not.toHaveBeenCalled();
});
