import { createHash, randomUUID } from 'node:crypto';

export type LarkIngressLeaseStore = {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMilliseconds: number,
    condition: 'NX',
  ): Promise<string | null>;
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
};

export type LarkIngressRuntime = {
  start(): Promise<void>;
  close(): void;
};

export type LarkIngressLeader = {
  refresh(): Promise<void>;
  close(): Promise<void>;
};

const renewLeaseScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const releaseLeaseScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

function leaseKey(input: {
  appId: string;
  tenantKey: string;
  workspaceId: string;
}): string {
  const scope = JSON.stringify([
    input.appId,
    input.tenantKey,
    input.workspaceId,
  ]);
  return `deepauto:lark-ingress:${createHash('sha256').update(scope).digest('hex')}`;
}

export async function startLarkIngressLeader(input: {
  store: LarkIngressLeaseStore;
  appId: string;
  tenantKey: string;
  workspaceId: string;
  createIngress(canAccept: () => boolean): LarkIngressRuntime;
  ownerId?: string;
  ttlMilliseconds?: number;
  renewIntervalMilliseconds?: number;
}): Promise<LarkIngressLeader> {
  const ttlMilliseconds = input.ttlMilliseconds ?? 30_000;
  const renewIntervalMilliseconds = input.renewIntervalMilliseconds ?? 10_000;
  if (
    ttlMilliseconds < 3_000 ||
    renewIntervalMilliseconds < 1_000 ||
    renewIntervalMilliseconds >= ttlMilliseconds
  ) {
    throw new Error('Lark ingress lease timing is invalid');
  }

  const key = leaseKey(input);
  const ownerId = input.ownerId ?? randomUUID();
  let accepting = false;
  let closed = false;
  let ingress: LarkIngressRuntime | undefined;
  let refreshInFlight: Promise<void> | undefined;
  let disabled = false;
  let holdsLease = false;

  async function releaseLease(): Promise<void> {
    await input.store.eval(releaseLeaseScript, 1, key, ownerId);
  }

  async function deactivate(release: boolean): Promise<void> {
    accepting = false;
    const activeIngress = ingress;
    ingress = undefined;
    activeIngress?.close();
    if (release && holdsLease) {
      holdsLease = false;
      try {
        await releaseLease();
      } catch {
        // The lease expires; it must not be released by an unverified owner.
      }
    }
  }

  async function refreshInternal(failOnStart: boolean): Promise<void> {
    if (closed || disabled) return;
    if (ingress) {
      try {
        const renewed = await input.store.eval(
          renewLeaseScript,
          1,
          key,
          ownerId,
          String(ttlMilliseconds),
        );
        if (renewed === 1) return;
      } catch {
        // Losing contact with Redis is equivalent to losing leadership.
      }
      await deactivate(false);
      holdsLease = false;
      return;
    }

    let acquired = false;
    try {
      acquired =
        (await input.store.set(key, ownerId, 'PX', ttlMilliseconds, 'NX')) ===
        'OK';
    } catch {
      if (failOnStart) throw new Error('Lark ingress lease is unavailable');
      return;
    }
    if (!acquired || closed) return;
    holdsLease = true;

    const candidate = input.createIngress(() => accepting && !closed);
    try {
      await candidate.start();
      if (closed) {
        candidate.close();
        await releaseLease();
        holdsLease = false;
        return;
      }
      const confirmed = await input.store.eval(
        renewLeaseScript,
        1,
        key,
        ownerId,
        String(ttlMilliseconds),
      );
      if (confirmed !== 1) {
        candidate.close();
        holdsLease = false;
        return;
      }
      ingress = candidate;
      accepting = true;
    } catch (error) {
      candidate.close();
      disabled = true;
      await releaseLease().catch(() => undefined);
      holdsLease = false;
      if (failOnStart) throw error;
    }
  }

  async function refresh(): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = refreshInternal(false).finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  }

  await refreshInternal(true);
  const timer = setInterval(() => {
    void refresh().catch(() => undefined);
  }, renewIntervalMilliseconds);

  return {
    refresh,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await refreshInFlight;
      await deactivate(true);
    },
  };
}
