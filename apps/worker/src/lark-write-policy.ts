import type { LarkDataOperation } from '@deepauto/lark';

type LarkMemberRole = 'MEMBER' | 'OPERATOR' | 'ADMIN';

const writeActions = new Set<LarkDataOperation['action']>([
  'doc.append',
  'base.create',
  'base.update',
  'base.delete',
]);

export function canUseLarkDataAction(
  role: LarkMemberRole,
  action: LarkDataOperation['action'],
): boolean {
  return !writeActions.has(action) || role === 'OPERATOR' || role === 'ADMIN';
}

export function requiresLarkWriteConfirmation(
  action: LarkDataOperation['action'],
): boolean {
  return action === 'base.delete';
}

export function hasLarkDeleteConfirmation(instruction: string): boolean {
  return /(?:确认删除|confirm delete)/i.test(instruction);
}
