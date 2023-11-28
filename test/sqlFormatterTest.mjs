import { it, describe, } from 'node:test';
import { expect } from 'expect';

import { sqlFormatter } from '../src/sqlFormatter.mjs';

describe('sqlFormatter', () => {
  it('throws error when unsupported language parameter specified', () => {
    expect(() => {
      sqlFormatter.format('SELECT *', { language: 'blah' });
    }).toThrow('Unsupported SQL dialect: blah');
  });
});
