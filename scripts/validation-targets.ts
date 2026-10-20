import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED_SCRIPTS = ['build', 'lint', 'typecheck', 'test:unit'] as const;
const WORKSPACE_ROOTS = ['apps', 'packages'] as const;

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

function isTypeScript(path: string): boolean {
  return /\.[cm]?tsx?$/.test(path) && !path.endsWith('.d.ts');
}

function isTest(path: string): boolean {
  return /\.(test|spec)\.[cm]?tsx?$/.test(path);
}

export function inspectValidationTargets(root: string): {
  activePackages: string[];
  errors: string[];
} {
  const activePackages: string[] = [];
  const errors: string[] = [];

  for (const workspaceRoot of WORKSPACE_ROOTS) {
    const directory = join(root, workspaceRoot);
    if (!existsSync(directory)) continue;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const packageDirectory = join(directory, entry.name);
      const manifestPath = join(packageDirectory, 'package.json');
      const sourceFiles = filesUnder(join(packageDirectory, 'src')).filter(
        (path) => isTypeScript(path) && !isTest(path),
      );
      const name = `${workspaceRoot}/${entry.name}`;

      if (!existsSync(manifestPath)) {
        errors.push(`${name}: missing package.json`);
        continue;
      }
      if (sourceFiles.length === 0) continue;

      activePackages.push(name);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };

      for (const script of REQUIRED_SCRIPTS) {
        if (!manifest.scripts?.[script]?.trim()) {
          errors.push(`${name}: missing ${script} script`);
        }
      }

      const tests = [
        ...filesUnder(join(packageDirectory, 'src')),
        ...filesUnder(join(packageDirectory, 'tests')),
      ].filter(isTest);
      if (tests.length === 0) {
        errors.push(`${name}: source exists but no unit or integration test`);
      }
    }
  }

  if (activePackages.length === 0) {
    errors.push('No workspace source files are under validation');
  }

  return { activePackages, errors };
}
