import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as d3 from 'd3';

// Exercise the actual browser boot/render path with synthetic records. Geometry
// is intentionally approximate: these tests check vesting state, not SVG layout.
class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.clientWidth = 736;
    this.scrollLeft = 0;
    this._text = '';
    this.classList = {
      add: (...values) => this.setAttribute('class', [...new Set([...this.classes(), ...values])].join(' ')),
      remove: (...values) => this.setAttribute('class', this.classes().filter(value => !values.includes(value)).join(' ')),
      contains: value => this.classes().includes(value),
    };
  }
  classes() { return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  set className(value) { this.setAttribute('class', value); }
  get className() { return this.getAttribute('class') || ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  click() { this.listeners.get('click')?.forEach(listener => listener({ target: this, stopPropagation() {} })); }
  matches(selector) {
    const id = selector.match(/#([\w-]+)/)?.[1];
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    const tag = selector.match(/^[\w-]+/)?.[0];
    const attr = selector.match(/\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]/);
    return (!id || this.getAttribute('id') === id) &&
      classes.every(value => this.classes().includes(value)) &&
      (!tag || this.tagName === tag) &&
      (!attr || this.attributes.has(attr[1]) && (!attr[2] || this.getAttribute(attr[1]) === attr[2]));
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  getComputedTextLength() { return this.textContent.length * 6; }
  getBBox() { return { x: 0, y: 0, width: 160, height: 40 }; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 736, height: 800 }; }
}

function bootChart(tranches, { proposed = false, today = '2026-10-05', category = 'dola' } = {}) {
  const root = new Element();
  root.setAttribute('id', 'award-viz');
  const nodes = new Map([['award-viz', root]]);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    if (nodes.has(id)) continue;
    const node = new Element();
    node.setAttribute('id', id);
    root.appendChild(node);
    nodes.set(id, node);
  }
  const inlineData = new Element('script');
  inlineData.textContent = JSON.stringify({
    as_of: '2026-09-22',
    awards: {
      synthetic: { label: 'Synthetic award', cat: category, units: 100, grant: '2026-01-01', proposed },
    },
    order: ['synthetic'],
    tranches: tranches.map(([date, units, kind]) => [date, 'synthetic', category, units, kind]),
  });
  nodes.set('inline-data', inlineData);
  let parsedData, sourceData;
  const document = {
    getElementById: id => nodes.get(id) ?? null,
    createElement: tag => new Element(tag),
    createElementNS: (_namespace, tag) => new Element(tag),
  };
  vm.runInNewContext(readFileSync(new URL('../app.js', import.meta.url), 'utf8'), {
    document, d3, URLSearchParams, location: { search: `?today=${today}` },
    window: {}, setTimeout, clearTimeout,
    JSON: {
      parse(text) { parsedData = JSON.parse(text); sourceData = structuredClone(parsedData); return parsedData; },
    },
  });
  const host = nodes.get('tl-host');
  return {
    root,
    click: id => nodes.get(id).click(),
    input: (id, value) => {
      const node = nodes.get(id);
      node.value = String(value);
      node.listeners.get('input')?.forEach(listener => listener({ target: node }));
    },
    summaryCircle: (state, category = 'dola') => host.querySelector(`[data-summary="selected"]`).querySelector(`circle.${state}.cat-${category}`),
    marks: () => host.querySelectorAll('circle.hit'),
    circles: state => host.querySelectorAll(`circle.${state}`).filter(node => !node.getAttribute('data-tooltip')),
    totals: (summary = 'today') => host.querySelector(`[data-summary="${summary}"]`).querySelectorAll('text.now-value').map(node => node.textContent),
    tooltips: () => host.querySelectorAll('[data-tooltip]').map(node => node.getAttribute('data-tooltip')).join('\n'),
    next: () => ({
      date: nodes.get('next-vesting-date').dateTime,
      dola: nodes.get('next-vesting-dola').textContent,
      option: nodes.get('next-vesting-option').textContent,
      text: nodes.get('next-vesting').textContent + nodes.get('next-vesting-note').textContent +
        (nodes.get('next-vesting-proposed') && !nodes.get('next-vesting-proposed').hidden
          ? nodes.get('next-vesting-proposed').textContent : ''),
    }),
    data: parsedData,
    sourceData,
  };
}

test('a past legacy proposed tranche is solid, counted, and shown by the vested-only filter', () => {
  const chart = bootChart([['2026-10-01', 10, 'ptranche']], { proposed: true });
  assert.equal(chart.circles('mk-past').length, 1);
  assert.equal(chart.circles('mk-future').length, 0);
  assert.deepEqual(chart.totals(), ['10', '0']);
  assert.doesNotMatch(chart.tooltips(), /拟授予|未生效/);
  chart.click('lg-future');
  assert.equal(chart.marks().length, 1);
});

test('the pending-only filter hides past legacy proposed tranches and keeps future ones', () => {
  const chart = bootChart([
    ['2026-10-01', 10, 'ptranche'],
    ['2026-11-01', 20, 'ptranche'],
  ], { proposed: true });
  assert.deepEqual(chart.totals(), ['10', '0']);
  chart.click('lg-past');
  assert.equal(chart.marks().length, 1);
  assert.equal(chart.marks()[0].getAttribute('data-date'), '2026-11-01');
  assert.equal(chart.circles('mk-future').length, 1);
});

test('merging adjacent past legacy proposed tranches retains their vested totals and solid state', () => {
  const chart = bootChart([
    ['2026-10-01', 10, 'ptranche'],
    ['2026-10-03', 20, 'ptranche'],
  ], { proposed: true });
  assert.equal(chart.marks().length, 1);
  assert.equal(chart.circles('mk-future').length, 0);
  assert.equal(chart.circles('mk-past').length, 1);
  assert.deepEqual(chart.totals(), ['30', '0']);
  assert.match(chart.tooltips(), /合计归属 30/);
  assert.doesNotMatch(chart.tooltips(), /拟授予|未生效/);
});

test('merging cannot move a vested tranche into a future bubble across today', () => {
  const chart = bootChart([
    ['2026-10-01', 10, 'tranche'],
    ['2026-10-06', 20, 'tranche'],
  ]);
  assert.deepEqual(chart.totals(), ['10', '0']);
  assert.deepEqual(chart.marks().map(node => node.getAttribute('data-date')), ['2026-10-01', '2026-10-06']);
  assert.equal(chart.circles('mk-past').length, 1);
  assert.equal(chart.circles('mk-future').length, 1);
  chart.click('lg-future');
  assert.deepEqual(chart.marks().map(node => node.getAttribute('data-date')), ['2026-10-01']);
});

test('an effective tranche vests on its scheduled day and future periods stay pending', () => {
  const chart = bootChart([
    ['2026-10-05', 10, 'tranche'],
    ['2026-10-06', 20, 'tranche'],
  ]);
  assert.deepEqual(chart.totals(), ['10', '0']);
  assert.equal(chart.circles('mk-past').length, 1);
  assert.equal(chart.circles('mk-future').length, 1);
});

test('legacy proposed tranches also vest on their scheduled day without merging across today', () => {
  const chart = bootChart([
    ['2026-10-05', 10, 'ptranche'],
    ['2026-10-06', 20, 'ptranche'],
  ], { proposed: true });
  assert.deepEqual(chart.totals(), ['10', '0']);
  assert.deepEqual(chart.marks().map(node => node.getAttribute('data-date')), ['2026-10-05', '2026-10-06']);
  assert.equal(chart.circles('mk-past').length, 1);
  assert.equal(chart.circles('mk-future').length, 1);
});

test('next vesting combines both legacy kinds without presenting an unconfirmed portion', () => {
  const chart = bootChart([
    ['2026-10-01', 10, 'ptranche'],
    ['2026-10-06', 20, 'tranche'],
    ['2026-10-06', 30, 'ptranche'],
  ], { proposed: true });
  assert.deepEqual(chart.next(), {
    date: '2026-10-06', dola: '50', option: '0',
    text: '全部授予 · 当天共 1 笔 · 按逐期日期汇总',
  });
  assert.doesNotMatch(chart.tooltips(), /拟授予|未生效/);
});

test('cancellation events do not increase vested totals or create a vesting bubble', () => {
  const chart = bootChart([
    ['2026-10-01', 10, 'ptranche'],
    ['2026-10-02', 20, 'cancel'],
  ], { proposed: true });
  assert.deepEqual(chart.totals(), ['10', '0']);
  assert.equal(chart.marks().length, 1);
});

test('rendering the unified timeline preserves original legacy status in source data', () => {
  const chart = bootChart([
    ['2026-10-01', 10, 'ptranche'],
    ['2026-10-06', 20, 'tranche'],
  ], { proposed: true });
  assert.deepEqual(chart.data, chart.sourceData);
  assert.equal(chart.data.awards.synthetic.proposed, true);
  assert.equal(chart.data.tranches[0][4], 'ptranche');
});

test('legacy option tranches also contribute to actual vested totals', () => {
  const chart = bootChart([
    ['2026-10-01', 10, 'ptranche'],
    ['2026-10-06', 20, 'tranche'],
  ], { proposed: true, category: 'option' });
  assert.deepEqual(chart.totals(), ['0', '10']);
  assert.equal(chart.circles('mk-past').length, 1);
  assert.doesNotMatch(chart.tooltips(), /拟授予|未生效/);
});

test('selected future totals include past and future legacy tranches under the same rules', () => {
  const chart = bootChart([
    ['2026-10-01', 10, 'ptranche'],
    ['2026-10-06', 20, 'ptranche'],
  ], { proposed: true });
  chart.marks().find(node => node.getAttribute('data-date') === '2026-10-06').click();
  assert.deepEqual(chart.totals(), ['10', '0']);
  assert.deepEqual(chart.totals('selected'), ['30', '0']);
  assert.doesNotMatch(chart.tooltips(), /拟授予|未生效/);
  assert.doesNotMatch(chart.root.querySelector('#hint').textContent, /拟授予|未生效/);
});

test('only future periods through the selected day are hatched, and clearing selection restores hollow marks', () => {
  const chart = bootChart([
    ['2026-10-05', 10, 'tranche'],
    ['2026-11-01', 20, 'ptranche'],
    ['2026-12-01', 30, 'tranche'],
    ['2027-01-01', 40, 'tranche'],
  ]);
  chart.marks().find(node => node.getAttribute('data-date') === '2026-12-01').click();
  assert.equal(chart.circles('mk-past').length, 1);
  assert.equal(chart.circles('mk-interval').length, 2);
  assert.equal(chart.circles('mk-future').length, 1);
  assert.deepEqual(chart.totals('selected'), ['60', '0']);
  chart.click('lg-future');
  assert.equal(chart.circles('mk-interval').length, 0);
  assert.equal(chart.marks().length, 1);
  assert.deepEqual(chart.totals('selected'), ['60', '0']);
  chart.click('lg-future');
  chart.marks().find(node => node.getAttribute('data-date') === '2026-12-01').click();
  assert.equal(chart.circles('mk-interval').length, 0);
  assert.equal(chart.circles('mk-future').length, 3);
});

test('merging preserves the selected-day boundary and the selected cumulative quantity', () => {
  const chart = bootChart([
    ['2026-10-05', 10, 'tranche'],
    ['2026-11-01', 20, 'tranche'],
    ['2026-11-03', 30, 'ptranche'],
    ['2026-11-06', 40, 'tranche'],
  ]);
  chart.input('mergeN', 0);
  chart.marks().find(node => node.getAttribute('data-date') === '2026-11-03').click();
  chart.input('mergeN', 7);
  assert.deepEqual(chart.marks().map(node => node.getAttribute('data-date')), ['2026-10-05', '2026-11-03', '2026-11-06']);
  assert.equal(chart.circles('mk-interval').length, 1);
  assert.equal(chart.circles('mk-future').length, 1);
  assert.deepEqual(chart.totals('selected'), ['60', '0']);
  assert.match(chart.tooltips(), /合计归属 50/);
});

for (const category of ['dola', 'option']) {
  test(`selected ${category} circle preserves areas with a left-tangent solid core in both size modes`, () => {
    const chart = bootChart([
      ['2026-10-01', 25, 'tranche'],
      ['2026-11-01', 75, 'ptranche'],
      ['2026-11-01', 50, 'cancel'],
    ], { category });
    chart.marks().find(node => node.getAttribute('data-date') === '2026-11-01').click();
    function checkAreas() {
      const total = chart.summaryCircle('summary-total', category);
      const core = chart.summaryCircle('summary-vested', category);
      assert.ok(total && core, 'selected totals must contain a hatched circle and a solid core');
      assert.equal(total.classList.contains('mk-interval'), true);
      assert.equal(core.classList.contains('mk-past'), true);
      assert.equal(total.getAttribute('cy'), core.getAttribute('cy'));
      const outerR = Number(total.getAttribute('r'));
      const innerR = Number(core.getAttribute('r'));
      const outerX = Number(total.getAttribute('cx'));
      const innerX = Number(core.getAttribute('cx'));
      assert.ok(innerX < outerX, 'the solid core must sit toward the past, on the left');
      assert.ok(Math.abs((innerX - innerR) - (outerX - outerR)) < 1e-10,
        'inner and outer circles must share the leftmost point');
      assert.ok(Math.abs((outerX - innerX) + innerR - outerR) < 1e-10,
        'the inner circle must be internally tangent, without crossing the outer circle');
      const ratio = (innerR / outerR) ** 2;
      assert.ok(Math.abs(ratio - 0.25) < 1e-10, 'solid area must equal the vested fraction, not its squared fraction');
      assert.match(total.getAttribute('data-tooltip'), /截至今天已归属 25/);
      assert.match(total.getAttribute('data-tooltip'), /选中日前新增 75/);
      return Number(total.getAttribute('r'));
    }
    checkAreas();
    chart.click('vm-value');
    const radiusBeforePriceChange = checkAreas();
    chart.input(`price-${category}`, category === 'dola' ? 68 : 965.4);
    assert.ok(Math.abs(checkAreas() / radiusBeforePriceChange - 2) < 1e-10);
  });
}

test('an entirely future total has no solid core, and an empty asset has no nonzero circle', () => {
  const chart = bootChart([['2026-11-01', 100, 'tranche']]);
  chart.marks()[0].click();
  const total = chart.summaryCircle('summary-total');
  assert.ok(total?.classList.contains('mk-interval'));
  assert.equal(chart.summaryCircle('summary-vested'), null);
  assert.equal(Number(chart.summaryCircle('summary-total', 'option')?.getAttribute('r') || 0), 0);
});

test('selecting today keeps every already vested unit solid with no incremental ring', () => {
  const chart = bootChart([
    ['2026-10-05', 100, 'tranche'],
    ['2026-11-01', 50, 'tranche'],
  ]);
  chart.marks()[0].click();
  assert.ok(chart.summaryCircle('summary-total')?.classList.contains('mk-past'));
  assert.equal(chart.summaryCircle('summary-vested'), null);
  assert.equal(chart.circles('mk-interval').length, 0);
  assert.deepEqual(chart.totals('selected'), ['100', '0']);
});

test('the date interval follows selection, remains independent of filters and size, and clears with selection', () => {
  const chart = bootChart([
    ['2026-10-06', 10, 'tranche'],
    ['2027-08-26', 20, 'tranche'],
    ['2027-09-06', 30, 'tranche'],
  ], { today: '2026-10-06' });
  const interval = () => chart.root.querySelector('.date-interval');
  assert.equal(interval(), null);
  chart.marks().find(node => node.getAttribute('data-date') === '2027-08-26').click();
  assert.match(interval()?.textContent || '', /相隔 324 个自然天/);
  assert.match(interval()?.textContent || '', /232 工作日 · 周一至周五/);
  assert.match(interval().getAttribute('data-tooltip'), /不含今天，含选中日/);
  assert.match(interval().getAttribute('data-tooltip'), /未扣除节假日、不含调休/);
  chart.click('lg-future');
  chart.click('vm-value');
  assert.match(interval().textContent, /相隔 324 个自然天/);
  chart.click('lg-future');
  chart.marks().find(node => node.getAttribute('data-date') === '2027-09-06').click();
  assert.match(interval().textContent, /相隔 335 个自然天/);
  chart.marks().find(node => node.getAttribute('data-date') === '2027-09-06').click();
  assert.equal(interval(), null);
  chart.marks().find(node => node.getAttribute('data-date') === '2026-10-06').click();
  assert.match(interval().textContent, /相隔 0 个自然天/);
  assert.match(interval().textContent, /0 工作日/);
});
