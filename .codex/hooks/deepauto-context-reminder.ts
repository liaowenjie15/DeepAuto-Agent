#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type HookInput = {
  cwd?: string;
  hook_event_name?: string;
  session_id?: string;
  tool_input?: unknown;
};

type ContextRule = {
  id: string;
  prefixes: string[];
  message: string;
};

const rules: ContextRule[] = [
  {
    id: 'gateway',
    prefixes: ['apps/gateway/'],
    message:
      'Gateway change: read `docs/03-unified-agent-architecture.md` and `docs/05-cli-runtime-github-actions-harness-architecture.md`. Preserve webhook signature verification, member/repository authorization, OIDC, callback, and credential boundaries.',
  },
  {
    id: 'worker-runtime',
    prefixes: ['apps/worker/', 'packages/runner-manager/'],
    message:
      'Worker or runner change: read `docs/05-cli-runtime-github-actions-harness-architecture.md` and `docs/07-testing-validation-implementation-plan.md`. Preserve Job/Attempt/Execution transitions, conversation locks, cancellation, timeout, and PR-only delivery.',
  },
  {
    id: 'github',
    prefixes: ['packages/github/', '.github/'],
    message:
      'GitHub integration change: read `docs/03-unified-agent-architecture.md` and `docs/05-cli-runtime-github-actions-harness-architecture.md`. Do not expose app credentials, OIDC tokens, callback claims, or proxy tokens in logs, workflow inputs, or repository variables.',
  },
  {
    id: 'persistence',
    prefixes: ['packages/db/', 'tests/integration/'],
    message:
      'Persistence or integration change: read `docs/03-unified-agent-architecture.md` and `docs/07-testing-validation-implementation-plan.md`. PostgreSQL is the source of truth; preserve idempotency, transactions, outbox delivery, and cross-workspace isolation.',
  },
  {
    id: 'documentation',
    prefixes: ['docs/'],
    message:
      'Documentation change: keep decisions, invariants, and troubleshooting entry points current. Do not duplicate volatile file inventories, command lists, credentials, or implementation details that the code already establishes.',
  },
];

const input = readInput();
const root = findRepoRoot(input.cwd ?? process.cwd());
if (!root) process.exit(0);

if (input.hook_event_name === 'SessionStart') {
  printContext(
    'SessionStart',
    [
      'DeepAuto project context is active.',
      'This repository uses `.codex` only for local context and delivery-safety reminders. Hooks do not run tests, read environment files, access credentials, or perform remote operations.',
      'Testing and validation are currently paused. Report validation not run; never represent it as passed.',
      'Read only the architecture documents relevant to the files you change.',
    ].join('\n'),
  );
  process.exit(0);
}

if (input.hook_event_name !== 'PostToolUse') process.exit(0);

const touchedPaths = collectPaths(input.tool_input, root);
const matchingRules = rules.filter((rule) =>
  rule.prefixes.some((prefix) =>
    touchedPaths.some((touchedPath) => touchedPath.startsWith(prefix)),
  ),
);
if (matchingRules.length === 0) process.exit(0);

const seen = readSeen(root, input);
const newRules = matchingRules.filter((rule) => !seen.has(rule.id));
if (newRules.length === 0) process.exit(0);
for (const rule of newRules) seen.add(rule.id);
writeSeen(root, input, seen);

printContext(
  'PostToolUse',
  ['# DeepAuto context reminder', ...newRules.map((rule) => rule.message)].join(
    '\n\n',
  ),
);

function readInput(): HookInput {
  try {
    const raw = readFileSync(0, 'utf8').trim();
    return raw ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    return {};
  }
}

function findRepoRoot(startDirectory: string): string | null {
  let current = path.resolve(startDirectory);
  while (true) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function collectPaths(value: unknown, rootDirectory: string): string[] {
  const paths = new Set<string>();
  const visit = (current: unknown) => {
    if (typeof current === 'string') {
      const normalized = normalizePath(current, rootDirectory);
      if (normalized) paths.add(normalized);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (current && typeof current === 'object') {
      Object.values(current).forEach(visit);
    }
  };
  visit(value);
  return [...paths];
}

function normalizePath(value: string, rootDirectory: string): string | null {
  const candidate = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const absolute = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(rootDirectory, candidate);
  const relative = path.relative(rootDirectory, absolute).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../')) return null;
  return relative;
}

function cachePath(rootDirectory: string, hookInput: HookInput): string {
  const session = hookInput.session_id ?? hookInput.cwd ?? 'unknown-session';
  const hash = createHash('sha256').update(session).digest('hex').slice(0, 16);
  return path.join(rootDirectory, '.codex', 'tmp', 'context', `${hash}.json`);
}

function readSeen(rootDirectory: string, hookInput: HookInput): Set<string> {
  try {
    const parsed = JSON.parse(
      readFileSync(cachePath(rootDirectory, hookInput), 'utf8'),
    ) as { seen?: string[] };
    return new Set(parsed.seen ?? []);
  } catch {
    return new Set();
  }
}

function writeSeen(
  rootDirectory: string,
  hookInput: HookInput,
  seen: Set<string>,
): void {
  const file = cachePath(rootDirectory, hookInput);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ seen: [...seen].sort() })}\n`, {
    mode: 0o600,
  });
}

function printContext(
  eventName: 'SessionStart' | 'PostToolUse',
  additionalContext: string,
): void {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } })}\n`,
  );
}
