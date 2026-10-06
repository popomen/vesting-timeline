import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = { document: { getElementById: () => null } };
vm.runInNewContext(readFileSync(new URL('../app.js', import.meta.url), 'utf8'), context);

function interval(start, end) {
  assert.equal(typeof context.summarizeDateInterval, 'function');
  return JSON.parse(JSON.stringify(context.summarizeDateInterval(start, end)));
}

test('same-day selection has no elapsed calendar days', () => {
  assert.equal(interval('2026-10-06', '2026-10-06').calendarDays, 0);
});

test('calendar distance excludes today and includes the selected date across month and year boundaries', () => {
  assert.equal(interval('2026-10-06', '2026-10-07').calendarDays, 1);
  assert.equal(interval('2026-12-31', '2027-01-01').calendarDays, 1);
  assert.equal(interval('2026-10-06', '2027-08-26').calendarDays, 324);
});

test('calendar distance follows leap years and is independent of daylight-saving changes', () => {
  assert.equal(interval('2028-02-28', '2028-03-01').calendarDays, 2);
  assert.equal(interval('2027-02-28', '2027-03-01').calendarDays, 1);
  assert.equal(interval('2026-03-07', '2026-03-09').calendarDays, 2);
  assert.equal(interval('2026-10-31', '2026-11-02').calendarDays, 2);
});

test('weekdays exclude the start date, include a weekday end date, and skip Saturday and Sunday', () => {
  assert.deepEqual(interval('2026-10-09', '2026-10-09'), { calendarDays: 0, workdays: 0 });
  assert.deepEqual(interval('2026-10-09', '2026-10-11'), { calendarDays: 2, workdays: 0 });
  assert.deepEqual(interval('2026-10-09', '2026-10-12'), { calendarDays: 3, workdays: 1 });
  assert.deepEqual(interval('2026-10-11', '2026-10-12'), { calendarDays: 1, workdays: 1 });
  assert.deepEqual(interval('2026-10-12', '2026-10-19'), { calendarDays: 7, workdays: 5 });
  assert.deepEqual(interval('2026-10-06', '2027-08-26'), { calendarDays: 324, workdays: 232 });
});

test('weekday counts cover every starting weekday and long intervals without holiday assumptions', () => {
  const dayMs = 86400000;
  for (let weekday = 0; weekday < 7; weekday++) {
    const start = Date.UTC(2026, 9, 4 + weekday);
    for (const days of [0, 1, 2, 5, 6, 7, 8, 13, 14, 31, 366, 1461]) {
      let expected = 0;
      for (let day = 1; day <= days; day++) {
        const dow = new Date(start + day * dayMs).getUTCDay();
        if (dow !== 0 && dow !== 6) expected++;
      }
      const result = interval(new Date(start).toISOString().slice(0, 10), new Date(start + days * dayMs).toISOString().slice(0, 10));
      assert.equal(result.calendarDays, days);
      assert.equal(result.workdays, expected);
    }
  }
});
