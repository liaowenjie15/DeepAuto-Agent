import { afterEach, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectValidationTargets } from './validation-targets';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(
  scripts: Record<string, string> = {
    build: 'tsc -p tsconfig.build.json',
    lint: 'biome check .',
    typecheck: 'tsc --noEmit',
    'test:unit': 'bun test src',
  },
): { root: string; packageDirectory: string } {
  const root = mkdtempSync(join(tmpdir(), 'deepauto-validation-'));
  directories.push(root);
  const packageDirectory = join(root, 'packages', 'contracts');
  mkdirSync(join(packageDirectory, 'src'), { recursive: true });
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ scripts }),
  );
  writeFileSync(
    join(packageDirectory, 'src', 'index.ts'),
    'export const value = 1;',
  );
  writeFileSync(
    join(packageDirectory, 'src', 'index.test.ts'),
    "import { test } from 'bun:test'; test('value', () => {});",
  );
  return { root, packageDirectory };
}

it('accepts a workspace with real source, scripts, and a test', () => {
  const { root } = fixture();
  expect(inspectValidationTargets(root)).toEqual({
    activePackages: ['packages/contracts'],
    errors: [],
  });
});

it('rejects an empty workspace collection instead of succeeding with zero tasks', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepauto-validation-'));
  directories.push(root);
  expect(inspectValidationTargets(root).errors).toContain(
    'No workspace source files are under validation',
  );
});

it('rejects a missing typecheck script', () => {
  const { root } = fixture({
    build: 'tsc -p tsconfig.build.json',
    lint: 'biome check .',
    'test:unit': 'bun test src',
  });
  expect(inspectValidationTargets(root).errors).toContain(
    'packages/contracts: missing typecheck script',
  );
});

it('rejects source code with no test', () => {
  const { root, packageDirectory } = fixture();
  rmSync(join(packageDirectory, 'src', 'index.test.ts'));
  expect(inspectValidationTargets(root).errors).toContain(
    'packages/contracts: source exists but no unit or integration test',
  );
});

it('requires validation scripts when a scaffold workspace gains source', () => {
  const { root } = fixture();
  const gatewayDirectory = join(root, 'apps', 'gateway');
  mkdirSync(join(gatewayDirectory, 'src'), { recursive: true });
  writeFileSync(join(gatewayDirectory, 'package.json'), '{}');
  writeFileSync(join(gatewayDirectory, 'src', 'index.ts'), 'export {};');

  const result = inspectValidationTargets(root);
  expect(result.activePackages).toContain('apps/gateway');
  expect(result.errors).toContain('apps/gateway: missing build script');
  expect(result.errors).toContain(
    'apps/gateway: source exists but no unit or integration test',
  );
});
