import { expect, test } from 'bun:test';
import { getTestEnvironment } from './test-environment';

const testEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL:
    'postgresql://deepauto_test:deepauto_test@127.0.0.1:5433/deepauto_test?schema=public',
  REDIS_URL: 'redis://127.0.0.1:6380',
};

test('accepts the isolated local PostgreSQL and Redis URLs', () => {
  expect(getTestEnvironment(testEnvironment)).toEqual({
    databaseUrl: testEnvironment.DATABASE_URL,
    redisUrl: testEnvironment.REDIS_URL,
  });
});

test('rejects a non-test process and a non-test database', () => {
  expect(() =>
    getTestEnvironment({ ...testEnvironment, NODE_ENV: 'development' }),
  ).toThrow('NODE_ENV=test');
  expect(() =>
    getTestEnvironment({
      ...testEnvironment,
      DATABASE_URL: 'postgresql://deepauto:deepauto@127.0.0.1:5432/deepauto',
    }),
  ).toThrow('deepauto_test');
});

test('rejects remote services', () => {
  expect(() =>
    getTestEnvironment({
      ...testEnvironment,
      REDIS_URL: 'redis://redis.production.example:6379',
    }),
  ).toThrow('isolated local test service');
});

test('rejects the development service ports', () => {
  expect(() =>
    getTestEnvironment({
      ...testEnvironment,
      DATABASE_URL:
        'postgresql://deepauto_test:deepauto_test@127.0.0.1:5432/deepauto_test?schema=public',
    }),
  ).toThrow('5433');
  expect(() =>
    getTestEnvironment({
      ...testEnvironment,
      REDIS_URL: 'redis://127.0.0.1:6379',
    }),
  ).toThrow('6380');
});
