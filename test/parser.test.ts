import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePipeline } from '../src/parser.js';

test('parsePipeline splits stages and args', () => {
  const p = parsePipeline("exec echo hi | where a=1 | pick id,subject");
  assert.equal(p.length, 3);
  assert.equal(p[0].name, 'exec');
  assert.deepEqual(p[0].args._, ['echo', 'hi']);
  assert.equal(p[1].name, 'where');
  assert.equal(p[1].args._[0], 'a=1');
  assert.equal(p[2].name, 'pick');
  assert.equal(p[2].args._[0], 'id,subject');
});

test('parsePipeline keeps quoted pipes', () => {
  const p = parsePipeline("exec echo 'a|b' | json");
  assert.equal(p.length, 2);
  assert.deepEqual(p[0].args._, ['echo', 'a|b']);
});
