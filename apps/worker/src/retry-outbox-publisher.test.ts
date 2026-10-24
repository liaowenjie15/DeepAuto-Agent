import { expect, test } from 'bun:test';
import { startRetryOutboxPublisher } from './retry-outbox-publisher';

test('rejects an invalid Retry Outbox publisher interval', () => {
  expect(() => startRetryOutboxPublisher({} as never, {} as never, 0)).toThrow(
    'interval must be positive',
  );
});
