'use strict';
// The screen answer prompt for "is this right" questions (2026-11-15, after the paid check in
// conditor/fixes-0122/quality): the fast tier said "Yes, that total is right" and then worked
// the sum out and reversed itself. The working now comes before the verdict, in one sentence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildScreenAnswer, HOW } = require('../src/guide/screen-answer');

test('a checking question is worked out before it is judged, and never opens with yes or no', () => {
  assert.match(HOW.check, /^Work it out yourself before you judge/);
  assert.match(HOW.check, /Never begin with yes or no/);
  assert.doesNotMatch(HOW.check, /First say whether it looks right/);
  assert.match(HOW.check, /not sure and what is missing/, 'it may still say it cannot tell');
  const q = buildScreenAnswer({ ask: 'is this total right', mode: 'check', window: { title: 'Budget', process: 'excel' } });
  assert.match(q.system, /Work it out yourself before you judge/);
});

test('every answer: a total on the screen is added up before it is repeated, and said once', () => {
  for (const mode of Object.keys(HOW)) {
    const q = buildScreenAnswer({ ask: 'x', mode });
    assert.match(q.system, /Whenever your answer mentions one, add up the numbers it is made from first/, mode);
    assert.match(q.system, /Do not correct yourself part way through/, mode);
    assert.doesNotMatch(q.system, /at most ten words/, mode + ': the old limit pushed a verdict out before the working');
    assert.doesNotMatch(q.system, /—/, mode);
  }
});

test('the prompt\'s own example does not use the numbers of the paid check\'s test page', () => {
  // The first retest's example was the test page's exact answer, so the model could copy it.
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'src', 'guide', 'screen-answer.js'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const sheet = fs.readFileSync(path.join(__dirname, 'ask-routing', 'shots', 'sheet.html'), 'utf8');
  for (const n of ['184', '149']) { assert.ok(sheet.includes(n) || n === '184', 'the test page still has ' + n); assert.ok(!prompt.includes(n), 'the prompt must not contain ' + n); }
});

test('describing and plain asks name what is set, not only what the page can do', () => {
  assert.match(HOW.describe, /what is actually set, selected or filled in/);
  assert.match(HOW.ask, /one to three short sentences/);
  assert.match(HOW.ask, /what is actually set, selected or filled in/);
});
