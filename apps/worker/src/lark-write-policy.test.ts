import { expect, test } from 'bun:test';
import {
  canUseLarkDataAction,
  hasLarkDeleteConfirmation,
  requiresLarkWriteConfirmation,
} from './lark-write-policy';

test('allows reads for members but restricts writes to operators and administrators', () => {
  expect(canUseLarkDataAction('MEMBER', 'doc.read')).toBe(true);
  expect(canUseLarkDataAction('MEMBER', 'base.list')).toBe(true);
  expect(canUseLarkDataAction('MEMBER', 'doc.append')).toBe(false);
  expect(canUseLarkDataAction('OPERATOR', 'base.update')).toBe(true);
  expect(canUseLarkDataAction('ADMIN', 'base.delete')).toBe(true);
});

test('requires a distinct deletion confirmation phrase only for Base deletes', () => {
  expect(requiresLarkWriteConfirmation('base.delete')).toBe(true);
  expect(requiresLarkWriteConfirmation('base.update')).toBe(false);
  expect(
    hasLarkDeleteConfirmation('确认删除 app123456 table123456 record123456'),
  ).toBe(true);
  expect(
    hasLarkDeleteConfirmation(
      'confirm delete app123456 table123456 record123456',
    ),
  ).toBe(true);
  expect(
    hasLarkDeleteConfirmation('删除 app123456 table123456 record123456'),
  ).toBe(false);
});
