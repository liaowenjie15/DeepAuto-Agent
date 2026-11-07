import { expect, test } from 'bun:test';
import {
  requestForLarkDataOperation,
  resolvedWikiDocxDocumentId,
} from './data-client';

test('builds the read-only Wiki node resolution request', () => {
  expect(
    requestForLarkDataOperation({
      action: 'wiki.resolve',
      nodeToken: 'wiki12345',
    }),
  ).toEqual({
    path: '/wiki/v2/spaces/get_node?token=wiki12345',
    method: 'GET',
  });
});

test('accepts only a Docx token from a Wiki node response', () => {
  expect(
    resolvedWikiDocxDocumentId({
      node: { obj_type: 'docx', obj_token: 'doc123456' },
    }),
  ).toBe('doc123456');
  expect(
    resolvedWikiDocxDocumentId({
      node: { obj_type: 'sheet', obj_token: 'sheet12345' },
    }),
  ).toBeUndefined();
  expect(
    resolvedWikiDocxDocumentId({ node: { obj_type: 'docx' } }),
  ).toBeUndefined();
});
