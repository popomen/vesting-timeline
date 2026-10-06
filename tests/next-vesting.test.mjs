import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Load the browser script without booting the chart; exercise its date/quantity
// calculation with synthetic records rather than any private award data.
const context = { document: { getElementById: () => null } };
vm.runInNewContext(await readFile(new URL('../app.js', import.meta.url), 'utf8'), context);
function summarize(rows, today) {
  assert.equal(typeof context.summarizeNextVesting, 'function');
  return JSON.parse(JSON.stringify(context.summarizeNextVesting(rows, today)));
}

test('finds the earliest upcoming day and sums every award by asset regardless of legacy status', () => {
  const rows = [
    ['2026-11-01', 'later', 'option', 900, 'tranche'],
    ['2026-10-01', 'a', 'dola', 120, 'tranche'],
    ['2026-09-01', 'past', 'dola', 800, 'tranche'],
    ['2026-10-01', 'b', 'dola', 30, 'tranche'],
    ['2026-10-01', 'c', 'option', 12, 'tranche'],
    ['2026-10-01', 'p', 'dola', 40, 'ptranche'],
    ['2026-10-01', 'q', 'option', 3, 'ptranche'],
    ['2026-10-01', 'a', 'dola', 5, 'tranche'],
  ];
  const before = structuredClone(rows);
  assert.deepEqual(summarize(rows, '2026-09-27'), {
    date: '2026-10-01', daysUntil: 4, awardCount: 5,
    total: { dola: 195, option: 15 },
  });
  assert.deepEqual(rows, before);
});

test('includes vesting today and does not merge neighboring days', () => {
  const result = summarize([
    ['2026-09-27', 'a', 'option', 10, 'tranche'],
    ['2026-09-28', 'a', 'option', 90, 'tranche'],
  ], '2026-09-27');
  assert.equal(result.date, '2026-09-27');
  assert.equal(result.daysUntil, 0);
  assert.equal(result.total.option, 10);
});

test('ignores cancellation and zero-quantity events when choosing the next day', () => {
  const result = summarize([
    ['2026-09-28', 'cancelled', 'option', 500, 'cancel'],
    ['2026-09-29', 'zero', 'dola', 0, 'tranche'],
    ['2026-10-01', 'a', 'option', 0.25, 'tranche'],
    ['2026-10-01', 'b', 'option', 1.5, 'tranche'],
    ['2026-10-01', 'cancelled', 'option', 200, 'cancel'],
  ], '2026-09-27');
  assert.equal(result.date, '2026-10-01');
  assert.equal(result.total.option, 1.75);
  assert.equal(result.awardCount, 2);
});

test('counts a legacy proposed-only next day as awarded', () => {
  const result = summarize([
    ['2026-09-28', 'pending', 'dola', 50, 'ptranche'],
    ['2026-10-01', 'effective', 'dola', 100, 'tranche'],
  ], '2026-09-27');
  assert.equal(result.date, '2026-09-28');
  assert.equal(result.total.dola, 50);
  assert.deepEqual(Object.keys(result).sort(), ['awardCount', 'date', 'daysUntil', 'total']);
});

test('returns no event for empty or exhausted schedules', () => {
  assert.equal(summarize([], '2026-09-27'), null);
  assert.equal(summarize([
    ['2026-09-26', 'a', 'option', 10, 'tranche'],
    ['2026-10-01', 'a', 'option', 10, 'cancel'],
  ], '2026-09-27'), null);
});

test('counts calendar days correctly across leap day and daylight-saving boundaries', () => {
  assert.equal(summarize([
    ['2028-03-01', 'a', 'option', 10, 'tranche'],
  ], '2028-02-28').daysUntil, 2);
  assert.equal(summarize([
    ['2026-03-09', 'a', 'option', 10, 'tranche'],
  ], '2026-03-07').daysUntil, 2);
});
