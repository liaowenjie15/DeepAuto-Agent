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

const input = readInput();
if (
  input.hook_event_name !== 'PostToolUse' ||
  !containsDeliveryCommand(input.tool_input)
) {
  process.exit(0);
}
const root = findRepoRoot(input.cwd ?? process.cwd());
if (!root) process.exit(0);
const marker = markerPath(root, input);
if (existsSync(marker)) process.exit(0);
mkdirSync(path.dirname(marker), { recursive: true });
writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
const additionalContext = [
  '# DeepAuto delivery-safety reminder',
  '',
  'Before treating this change as deliverable, confirm the fix addresses a demonstrated root cause and does not weaken webhook verification, authorization, OIDC, credential, queue, callback, or state-machine boundaries.',
  'Do not expose tokens, claims, private keys, connection strings, or upstream API keys. Code changes remain PR-only: no default-branch writes, automatic merges, or deployment.',
  'Testing and validation are currently paused. State exactly what was not run; do not report an unrun check as passed.',
].join('\n');
process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
  })}\n`,
);

function readInput(): HookInput {
  try {
    const raw = readFileSync(0, 'utf8').trim();
    return raw ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    return {};
  }
}

function findRepoRoot(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function containsDeliveryCommand(value: unknown): boolean {
  if (typeof value === 'string') {
    return /(?:^|[;&|]\s*)(?:git\s+(?:-[^\s]+\s+)*push\b|gh\s+(?:--[^\s]+\s+)*(?:pr\s+create)\b)/.test(
      value,
    );
  }
  if (Array.isArray(value)) return value.some(containsDeliveryCommand);
  return Boolean(
    value &&
      typeof value === 'object' &&
      Object.values(value).some(containsDeliveryCommand),
  );
}

function markerPath(root: string, hookInput: HookInput): string {
  const session = hookInput.session_id ?? hookInput.cwd ?? 'unknown-session';
  const hash = createHash('sha256').update(session).digest('hex').slice(0, 16);
  return path.join(root, '.codex', 'tmp', 'delivery-safety', `${hash}.marker`);
}
