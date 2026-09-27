/* 字节期权 & 豆包股归属周期可视化 —— 渲染逻辑
 *
 * 数据完全外置：默认读取 data/awards-timeline.json；读不到则回退到 demo-data.json（脱敏示例）。
 * 查询参数：
 *   ?data=<路径>        指定数据文件（默认 data/awards-timeline.json）
 *   ?today=YYYY-MM-DD   指定"今天"（默认取本机当天，用于区分已归属/待归属）
 */

// 使用原始逐期计划汇总，独立于图表筛选、气泡合并和金额显示口径。
function summarizeNextVesting(tranches, today) {
  var upcoming = tranches.filter(function (t) {
    return t[0] >= today && (t[4] === 'tranche' || t[4] === 'ptranche') &&
      (t[2] === 'dola' || t[2] === 'option') && Number.isFinite(t[3]) && t[3] > 0;
  });
  if (!upcoming.length) return null;
  var date = upcoming.reduce(function (earliest, t) {
    return t[0] < earliest ? t[0] : earliest;
  }, upcoming[0][0]);
  var effective = { dola: 0, option: 0 }, proposed = { dola: 0, option: 0 };
  var awards = new Set();
  upcoming.forEach(function (t) {
    if (t[0] !== date) return;
    var totals = t[4] === 'ptranche' ? proposed : effective;
    totals[t[2]] += t[3];
    awards.add(t[1]);
  });
  return {
    date: date,
    // 用日历日期计算天数，避免本地夏令时带来的 23/25 小时差异。
    daysUntil: Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000),
    awardCount: awards.size,
    effective: effective,
    proposed: proposed,
    total: { dola: effective.dola + proposed.dola, option: effective.option + proposed.option }
  };
}

(function () {
  'use strict';
  var root = document.getElementById('award-viz');
  if (!root) return;
  var NS = 'http://www.w3.org/2000/svg';

  var params = new URLSearchParams(location.search);
  var DATA_URL = params.get('data') || 'data/awards-timeline.json';
  var DEMO_URL = 'demo-data.json';
  var TODAY_PARAM = params.get('today');

  function showNote(text) {
    var note = document.getElementById('data-note');
    if (note) note.textContent = text;
  }
  function fail(msg) {
    var host = document.getElementById('tl-host');
    if (host) host.textContent = '';
    var nextCard = document.getElementById('next-vesting');
    if (nextCard) nextCard.hidden = true;
    showNote(msg);
  }

  // 单文件构建（build_standalone.py）会把数据内嵌到 <script id="inline-data"> 里，优先使用它
  var inlineEl = document.getElementById('inline-data');
  if (inlineEl) {
    try {
      boot(JSON.parse(inlineEl.textContent), '页面内嵌数据', false);
      return;
    } catch (e) {
      showNote('内嵌数据解析失败：' + e.message);
    }
  }

  fetch(DATA_URL, { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) { boot(d, DATA_URL, false); })
    .catch(function () {
      return fetch(DEMO_URL, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (d) { boot(d, DEMO_URL, true); })
        .catch(function (e) { fail('无法加载数据（' + DATA_URL + ' / ' + DEMO_URL + '）：' + e.message); });
    });

  function boot(DATA, sourceName, isDemo) {
    var parseDate = d3.timeParse('%Y-%m-%d');

    /* ---------- 数据派生 ---------- */
    var AWARDS = DATA.awards || {};
    var ORDER = (DATA.order && DATA.order.length) ? DATA.order : Object.keys(AWARDS);
    var ORIG_PLAN = DATA.orig_plan || {};
    var ALL = (DATA.tranches || []).slice();
    /* ---------- 时间轴范围：覆盖全部授予日与归属日 ---------- */
    var edgeDates = [];
    ALL.forEach(function (t) { edgeDates.push(t[0]); });
    Object.keys(AWARDS).forEach(function (id) { if (AWARDS[id].grant) edgeDates.push(AWARDS[id].grant); });
    edgeDates.sort();
    var X0 = new Date(+edgeDates[0].slice(0, 4), 0, 1);
    var X1 = new Date(+edgeDates[edgeDates.length - 1].slice(0, 4) + 1, 0, 1);
    var TODAY = TODAY_PARAM ? parseDate(TODAY_PARAM)
                            : (function () {
                                var n = new Date();
                                return new Date(n.getFullYear(), n.getMonth(), n.getDate());
                              })();
    showNote(isDemo ? '脱敏示例 · 非真实数据'
                    : (DATA.as_of ? '数据截至 ' + DATA.as_of : '授予记录已载入'));
    document.getElementById('data-note').title = '数据源：' + sourceName;

    /* ---------- 悬浮提示：独立页面自己实现（不依赖 Codex 宿主） ---------- */
    var tipEl = document.getElementById('viz-tip');
    var tipTarget = null;
    var tipTimer = null;
    function hideTipSoon() {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(function () { tipEl.hidden = true; tipTarget = null; }, 180);
    }
    function moveTip(ev) {
      if (!tipEl) return;
      var pad = 14, w = tipEl.offsetWidth, h = tipEl.offsetHeight;
      var x = ev.clientX + pad, y = ev.clientY + pad;
      if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
      if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
      tipEl.style.left = Math.max(8, x) + 'px';
      tipEl.style.top = Math.max(8, y) + 'px';
    }
    if (tipEl) {
      root.addEventListener('mouseover', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-tooltip]') : null;
        if (!t) { hideTipSoon(); return; }
        clearTimeout(tipTimer);
        if (t === tipTarget) return;
        tipTarget = t;
        tipEl.textContent = '';
        t.getAttribute('data-tooltip').split(' · ').forEach(function (part, i) {
          var line = document.createElement('div');
          line.className = i === 0 ? 'tip-heading' :
            (/^(归属数量|合计归属)/.test(part) ? 'tip-line tip-amount' : 'tip-line');
          line.textContent = part;
          tipEl.appendChild(line);
        });
        tipEl.hidden = false;
        moveTip(ev);
      });
      root.addEventListener('mousemove', function (ev) {
        if (!tipEl.hidden && tipTarget && tipTarget.contains(ev.target)) moveTip(ev);
      });
      root.addEventListener('mouseleave', hideTipSoon);
      tipEl.addEventListener('mouseenter', function () { clearTimeout(tipTimer); });
      tipEl.addEventListener('mouseleave', hideTipSoon);
    }

    /* ---------- 回购价口径（体积可切换为"股数 × 回购价"） ---------- */
    var DEFAULT_PRICES = Object.assign({ option: 241.35, dola: 17 }, DATA.prices || {});
    var prices = { option: DEFAULT_PRICES.option, dola: DEFAULT_PRICES.dola };   // 页面可改，初值即默认值
    function priceOf(cat) { return prices[cat] || 0; }
    function markValue(cat, units) { return state.valueMode ? units * priceOf(cat) : units; }
    function usd(v) {
      if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
      if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
      return '$' + Math.round(v);
    }
    // 面积标度用"固定参考系"，不随页面上的单价改动而移动：
    //   股数口径 → 参考 = 单期最大股数；回购价口径 → 参考 = 默认单价下单期最大金额。
    // 这样改一个单价只会放大/缩小该类别的气泡，不会把另一个类别整体缩小。
    var REF_UNITS = 1, REF_VALUE = 1;
    (function computeRefs() {
      ALL.forEach(function (t) {
        if (t[4] === 'cancel') return;
        var orig = ORIG_PLAN[t[1] + '|' + t[0]];
        var units = (orig && orig > t[3]) ? orig : t[3];
        if (units > REF_UNITS) REF_UNITS = units;
        var v = units * (DEFAULT_PRICES[t[2]] || 0);
        if (v > REF_VALUE) REF_VALUE = v;
      });
    })();
    // 某类型在指定日期之前的累计归属：effective = 已生效，proposed = 拟授予（未生效），total = 两者之和
    function cumAt(cat, upto) {
      var eff = 0, prop = 0;
      ALL.forEach(function (t) {
        if (t[2] !== cat || t[4] === 'cancel') return;
        if (parse(t[0]) > upto) return;
        if (t[4] === 'tranche') eff += t[3]; else prop += t[3];
      });
      return { effective: eff, proposed: prop, total: eff + prop };
    }
    function toggleSelect(d) {
      state.selected = (state.selected === d) ? null : d;
      render();
    }

var state = { dola: true, option: true, past: true, future: true, mergeDays: 7,
              valueMode: false, selected: null };
  var fmt = d3.format(",");
  var parse = d3.timeParse("%Y-%m-%d");

  function unit(cat) { return cat === "dola" ? "份" : "股"; }
  function money(n) { return fmt(n); }
  function catName(cat) { return cat === "dola" ? "豆包股" : "期权"; }
  function renderNextVesting() {
    var card = document.getElementById('next-vesting');
    if (!card) return;
    var today = d3.timeFormat('%Y-%m-%d')(TODAY);
    var next = summarizeNextVesting(ALL, today);
    var dateEl = document.getElementById('next-vesting-date');
    var countdown = document.getElementById('next-vesting-countdown');
    var proposedEl = document.getElementById('next-vesting-proposed');
    document.getElementById('next-vesting-title').textContent = next && next.daysUntil === 0 ? '今天归属' : '下次归属';
    document.getElementById('next-vesting-when').hidden = !next;
    dateEl.hidden = !next;
    countdown.hidden = !next;
    document.getElementById('next-vesting-amounts').hidden = !next;
    document.getElementById('next-vesting-empty').hidden = !!next;
    proposedEl.hidden = true;
    if (next) {
      dateEl.dateTime = next.date;
      dateEl.textContent = d3.timeFormat('%Y 年 %-m 月 %-d 日')(parse(next.date));
      countdown.textContent = next.daysUntil === 0 ? '就是今天' : '还有 ' + next.daysUntil + ' 天';
      ['dola', 'option'].forEach(function (cat) {
        document.getElementById('next-vesting-' + cat).textContent = money(next.total[cat]);
      });
      document.getElementById('next-vesting-note').textContent = '全部授予 · 当天共 ' + next.awardCount + ' 笔 · 按逐期日期汇总';
      var pending = ['dola', 'option'].filter(function (cat) { return next.proposed[cat] > 0; });
      if (pending.length) {
        proposedEl.textContent = '以上合计含拟授予：' + pending.map(function (cat) {
          return catName(cat) + ' ' + money(next.proposed[cat]) + ' ' + unit(cat);
        }).join('、') + '；尚未生效，生效后才计入归属。';
        proposedEl.hidden = false;
      }
    } else {
      document.getElementById('next-vesting-note').textContent = '全部授予 · 截至 ' + today;
    }
    card.hidden = false;
  }
  function el(tag, attrs, text) {
    var node = document.createElementNS(NS, tag);
    for (var k in attrs) { if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]); }
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  // 半径由"体积"决定（面积 ∝ 体积），标度锚点是固定参考系：
  //   股数口径体积 = 股数，锚点 = REF_UNITS；回购价口径体积 = 股数 × 当前单价，锚点 = REF_VALUE（按默认单价计算）
  function radius(units, cat) {
    var v = markValue(cat, units);
    var ref = state.valueMode ? REF_VALUE : REF_UNITS;
    return Math.max(0.6, 10 * Math.sqrt(v / ref));
  }
  // 圆内 y ≥ h（数学坐标，h ∈ [-r, r]）的面积占比
  function segFrac(h, r) {
    var t = Math.max(-1, Math.min(1, h / r));
    return 0.5 - (t * Math.sqrt(Math.max(0, 1 - t * t)) + Math.asin(t)) / Math.PI;
  }
  // 反解分割线位置，使上方（灰色）恰好占面积比例 f
  function solveSplit(r, f) {
    var lo = -r, hi = r;
    for (var i = 0; i < 26; i++) {
      var mid = (lo + hi) / 2;
      if (segFrac(mid, r) > f) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  function textFit(parent, attrs, s, maxW) {
    var node = el("text", attrs, s);
    parent.appendChild(node);
    if (!maxW || maxW <= 0 || !node.getComputedTextLength) return node;
    if (node.getComputedTextLength() <= maxW) return node;
    var t = s;
    while (t.length > 1) {
      t = t.slice(0, -1);
      node.textContent = t + "…";
      if (node.getComputedTextLength() <= maxW) break;
    }
    return node;
  }

  // 每笔累计（含拟授予的完整计划）；同类型累计只统计已生效记录，因此今天之前与"已归属"一致
  var awardCum = {}, catCum = {}, vested = {};
  (function () {
    var byAward = {}, byCat = {}, dates = [];
    ALL.forEach(function (t) { if (dates.indexOf(t[0]) < 0) dates.push(t[0]); });
    dates.sort();
    dates.forEach(function (dt) {
      var same = ALL.filter(function (t) { return t[0] === dt; });
      same.forEach(function (t) { if (t[4] !== "cancel") byAward[t[1]] = (byAward[t[1]] || 0) + t[3]; });
      same.forEach(function (t) { if (t[4] === "tranche") byCat[t[2]] = (byCat[t[2]] || 0) + t[3]; });
      same.forEach(function (t) {
        awardCum[t[1] + "|" + dt] = byAward[t[1]];
        if (t[4] === "tranche") catCum[t[2] + "|" + dt] = byCat[t[2]];
      });
    });
    ALL.forEach(function (t) {
      if (t[4] === "tranche" && parse(t[0]) <= TODAY) vested[t[1]] = (vested[t[1]] || 0) + t[3];
    });
  })();
  var nowByCat = { dola: 0, option: 0 };
  Object.keys(vested).forEach(function (id) { nowByCat[AWARDS[id].cat] += vested[id]; });

  // 年份刻度：区间直接由数据范围 (X0/X1) 推导，不写死年份
  function yearTicks() {
    var out = [];
    for (var y = X0.getFullYear(); y <= X1.getFullYear(); y++) out.push(new Date(y, 0, 1));
    return out;
  }

  // 线性时间轴：密度取理论下限 —— 同排任意相邻两球，水平距离 ≥ 两球半径之和（刚好相切，不加余量）。
  // 时间刻度与日期严格等比，代价是整段跨度需要横向滚动。

  function laneMarks(id) {
    var rows = ALL.filter(function (t) { return t[1] === id; }).map(function (t) {
      return { d: t[0], u: t[3], k: t[4], merged: null };
    });
    var n = state.mergeDays;
    if (!(n > 0)) return rows;
    // 同一笔授予内，距该组首期不超过 N 天的归属合并为一个气泡（面积相加，位置取最后一期）
    var events = rows.filter(function (m) { return m.k !== "cancel"; })
                     .sort(function (a, b) { return parse(a.d) - parse(b.d); });
    var groups = [], cur = null;
    events.forEach(function (m) {
      if (cur && (parse(m.d) - parse(cur[0].d)) / 86400000 <= n) cur.push(m);
      else { cur = [m]; groups.push(cur); }
    });
    var out = rows.filter(function (m) { return m.k === "cancel"; });
    groups.forEach(function (g) {
      if (g.length < 2) { out.push(g[0]); return; }
      var last = g[g.length - 1];
      var sum = g.reduce(function (s, m) { return s + m.u; }, 0);
      out.push({
        d: last.d, u: sum, k: "merged",
        firstDate: g[0].d,
        merged: g.map(function (m) { return m.d + " 归属 " + money(m.u) + ' ' + unit(AWARDS[id].cat); }).join("；")
      });
    });
    return out;
  }

  function markRadius(id, t) {
    var orig = ORIG_PLAN[id + "|" + t.d];
    var split = !!(orig && orig > t.u);
    var units = split ? orig : t.u;
    return Math.max(split ? 4.5 : 0.6, radius(units, AWARDS[id].cat));
  }
  function minPxPerDay() {
    var need = 0;
    ORDER.forEach(function (id) {
      var marks = laneMarks(id).filter(function (t) { return t.k !== "cancel"; })
                     .map(function (t) { return { ms: parse(t.d).getTime(), r: markRadius(id, t) }; })
                     .sort(function (a, b) { return a.ms - b.ms; });
      for (var i = 0; i < marks.length; i++) {
        for (var j = i + 1; j < marks.length; j++) {
          var days = (marks[j].ms - marks[i].ms) / 86400000;
          if (days <= 0) continue;
          var req = (marks[i].r + marks[j].r) / days;
          if (req > need) need = req;
        }
      }
    });
    return need;
  }

      function renderTimeline(narrow) {
        var host = root.querySelector("#tl-host");
    var prevScroll = host.querySelector(".tl-scroll");
    var keepScroll = prevScroll ? prevScroll.scrollLeft : null;
    host.textContent = "";
    var labelW = narrow ? 148 : 246;
    // 行高与表头高度随最大半径自适应：单价调大后气泡变大，也不会跨行/压到表头
    var maxMarkR = 0;
    ORDER.forEach(function (id2) {
      laneMarks(id2).forEach(function (t2) { maxMarkR = Math.max(maxMarkR, markRadius(id2, t2)); });
    });
    var todayMaxR = Math.max(radius(nowByCat.dola, 'dola'), radius(nowByCat.option, 'option'));
    var selectedMaxR = 0;
    if (state.selected) {
      var selD = parse(state.selected);
      selectedMaxR = Math.max(radius(cumAt('dola', selD).total, 'dola'), radius(cumAt('option', selD).total, 'option'));
    }
    var laneH = Math.max(narrow ? 48 : 44, Math.ceil(2 * maxMarkR + 10));
    // 两组累计始终共用圆心高度、数值基线和日期标签高度；冲突在水平方向解决。
    var maxCumR = Math.max(todayMaxR, selectedMaxR);
    var cumCy = Math.ceil(maxCumR + 30);
    var lineLabelY = Math.ceil(cumCy + maxCumR + 24);
    var m = { top: Math.max(116, lineLabelY + 46), right: 20, bottom: 46 };
    var H = m.top + ORDER.length * laneH + m.bottom;
    var totalDays = (X1 - X0) / 86400000;
    var availW = Math.max(260, (host.clientWidth || 736) - labelW) - m.right;
    var pxPerDay = Math.max(minPxPerDay(), availW / totalDays);
    var plotW = Math.round(totalDays * pxPerDay) + m.right;
    var W = plotW;
    var x = d3.scaleTime().domain([X0, X1]).range([0, plotW - m.right]);

    var wrap = document.createElement("div");
    wrap.className = "tl-wrap";
    var labelSvg = el("svg", { viewBox: "0 0 " + labelW + " " + H, width: labelW, height: H,
                               role: "img", "aria-label": "授予记录列表" });
    labelSvg.appendChild(el("title", {}, "授予记录列表"));
    var lg = el("g");
    labelSvg.appendChild(lg);
    var scroll = document.createElement("div");
    scroll.className = "tl-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', '归属时间线，可使用左右方向键横向滚动');
    var plotSvg = el("svg", { viewBox: "0 0 " + plotW + " " + H, width: plotW, height: H,
                              role: "img", "aria-label": "每笔授予的归属时间线" });
    plotSvg.appendChild(el("title", {}, "每笔授予的归属时间线"));
    var defs = el("defs");
    plotSvg.appendChild(defs);
    var clipSeq = 0;
    var g = el("g");
    plotSvg.appendChild(g);
    scroll.appendChild(plotSvg);
    wrap.appendChild(labelSvg);
    wrap.appendChild(scroll);
    host.appendChild(wrap);
    g.appendChild(el('rect', { class: 'past-wash', x: 0, y: m.top,
      width: Math.max(0, Math.min(W - m.right, x(TODAY))), height: ORDER.length * laneH }));
    var labelRows = [], plotRows = [], hoveredRow = -1;
    function highlightRow(ev) {
      var rect = labelSvg.getBoundingClientRect();
      var index = Math.floor((ev.clientY - rect.top - m.top) / laneH);
      if (index < 0 || index >= ORDER.length) index = -1;
      if (index === hoveredRow) return;
      if (hoveredRow >= 0) {
        labelRows[hoveredRow].classList.remove('is-hovered');
        plotRows[hoveredRow].classList.remove('is-hovered');
      }
      hoveredRow = index;
      if (index >= 0) {
        labelRows[index].classList.add('is-hovered');
        plotRows[index].classList.add('is-hovered');
      }
    }
    wrap.addEventListener('mousemove', highlightRow);
    wrap.addEventListener('mouseleave', function () {
      if (hoveredRow >= 0) {
        labelRows[hoveredRow].classList.remove('is-hovered');
        plotRows[hoveredRow].classList.remove('is-hovered');
        hoveredRow = -1;
      }
    });
    // 点击绘图区任意位置：今天右侧 → 选中该日期（靠近圆点时吸附到该圆点）；今天左侧 → 清除选中
    var fmtDate = d3.timeFormat('%Y-%m-%d');
    plotSvg.addEventListener("click", function (ev) {
      var rect = plotSvg.getBoundingClientRect();
      if (!rect.width) return;
      var px = (ev.clientX - rect.left) * (plotSvg.viewBox.baseVal.width / rect.width);
      // 表头可能拓宽画布；额外空白不属于时间轴，不能据此产生新日期。
      if (px < 0 || px > W - m.right) return;
      var picked = null, bestDx = 6;      // 6px 内吸附到最近的圆点
      Array.prototype.forEach.call(plotSvg.querySelectorAll('circle.hit'), function (h) {
        var dx = Math.abs(parseFloat(h.getAttribute('cx')) - px);
        if (dx < bestDx) { bestDx = dx; picked = h.getAttribute('data-date'); }
      });
      var d = picked ? parse(picked) : x.invert(px);
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      if (d < TODAY) {
        if (state.selected) { state.selected = null; render(); }
        return;
      }
      state.selected = picked || fmtDate(d);
      render();
    });

    yearTicks().forEach(function (t) {
      var gx = x(t);
      g.appendChild(el("line", { class: "grid", x1: gx, x2: gx, y1: m.top - 8, y2: m.top + ORDER.length * laneH }));
      var anchor = gx < 24 ? "start" : (gx > W - m.right - 24 ? "end" : "middle");
      g.appendChild(el("text", { class: "tick", x: gx + (anchor === "start" ? 4 : anchor === "end" ? -4 : 0),
                                 y: H - 18, "text-anchor": anchor }, t.getFullYear()));
    });
    g.appendChild(el("text", { class: "axis-title", "data-axis": "x", x: (W - m.right) / 2, y: H - 4,
                               "text-anchor": "middle" }, "归属日期（线性轴）"));
    lg.appendChild(el('text', { class: 'axis-title', 'data-axis': 'y', x: narrow ? 14 : 24, y: m.top - 14 }, '授予记录 / 按授予日'));

    ORDER.forEach(function (id, i) {
      var meta = AWARDS[id];
      var y = m.top + i * laneH + laneH / 2;
      var plotRow = el('rect', { class: 'lane-bg', x: 0, y: y - laneH / 2, width: W - m.right, height: laneH });
      g.appendChild(plotRow); plotRows.push(plotRow);
      var labelRow = el('rect', { class: 'lane-bg', x: 0, y: y - laneH / 2, width: labelW, height: laneH });
      lg.appendChild(labelRow); labelRows.push(labelRow);
      g.appendChild(el("line", { class: "lane-line", x1: 0, x2: W - m.right, y1: y + laneH / 2, y2: y + laneH / 2 }));
      lg.appendChild(el('line', { class: 'lane-line', x1: 0, x2: labelW, y1: y + laneH / 2, y2: y + laneH / 2 }));

      var headTip = id + " · " + meta.label + " · 授予日 " + meta.grant +
                    (meta.exp ? " · 到期日 " + meta.exp : "") +
                    " · 授予 " + money(meta.units) + " " + unit(meta.cat) +
                    (meta.proposed ? " · 拟授予，尚未生效" : " · 已归属 " + money(vested[id] || 0) + " " + unit(meta.cat)) +
                    (meta.amended ? " · " + meta.amended : "");
      var x0 = narrow ? 14 : 24;
      var labelGroup = el('g', { 'data-tooltip': headTip });
      lg.appendChild(labelGroup);
      labelGroup.appendChild(el('rect', { x: 0, y: y - laneH / 2, width: labelW, height: laneH, fill: 'transparent' }));
      labelGroup.appendChild(el('circle', { cx: x0 + 3, cy: y - 6, r: 2.5,
        fill: meta.cat === 'dola' ? 'var(--viz-series-1)' : 'var(--viz-series-2)' }));
      textFit(labelGroup, { class: 'lane-name', x: x0 + 14, y: y - 2 }, meta.label, labelW - x0 - 24);
      labelGroup.appendChild(el('text', { class: 'lane-date', x: x0 + 14, y: y + 14 }, meta.grant));
      if (meta.proposed && !narrow) labelGroup.appendChild(el('text', { class: 'lane-badge', x: labelW - 22, y: y + 14, 'text-anchor': 'end' }, '拟授予'));

      if (!state[meta.cat]) return;

      laneMarks(id).forEach(function (t) {
        var d = parse(t.d), u = t.u, kind = t.k;
        var cy = y;
        var isProp = kind === "ptranche";
        var past = d <= TODAY;
        if (kind === "cancel") {
          return;   // 取消额已由受修订各期的灰色分片表达，不再单独画叉
        }
        // 已归属/待归属筛选对所有期次一视同仁（拟授予都在未来，因此关掉"待归属"时会一起隐藏）
        if (past && !state.past) return;
        if (!past && !state.future) return;
        var orig = ORIG_PLAN[id + "|" + t.d];
        var split = orig && orig > u;
        var tail = " · 该笔累计 " + money(awardCum[id + "|" + t.d]) + " " + unit(meta.cat) +
                   (isProp || !catCum[meta.cat + "|" + t.d] ? "" :
                     " · " + catName(meta.cat) + "累计 " + money(catCum[meta.cat + "|" + t.d]) + " " + unit(meta.cat));
        var tip = (kind === 'merged'
                    ? '合并归属 · 合计归属 ' + money(u) + ' ' + unit(meta.cat) +
                      ' · 覆盖日期 ' + t.firstDate + ' 至 ' + t.d +
                      ' · 逐期明细：' + t.merged.replace(/；/g, ' · ') + ' · 气泡位置取最后一期'
                    : '本次归属 · 归属日期 ' + t.d + ' · 归属数量 ' + money(u) + ' ' + unit(meta.cat)) +
                  ' · ' + (meta.proposed ? '拟授予，未生效' : (past ? '已归属' : '待归属')) +
                  (split ? " · 原计划 " + money(orig) + " → 修订后 " + money(u) + " " + unit(meta.cat) +
                           "（灰 " + (Math.round((orig - u) * 100) / 100) + " 被取消）" : '') +
                  (state.valueMode ? " · 体积口径：≈" + usd(markValue(meta.cat, u)) + "（" + usd(priceOf(meta.cat)) + "/" + unit(meta.cat) + "）" : "") +
                  tail + ' · ' + meta.label + ' · 授予编号 ' + id;
        var cxp = x(d);
        // 受修订影响的这几期严格按面积只有 ~1.6px，分片不可辨，故设最小可辨半径（全图唯一偏离面积标度处）
        var r = markRadius(id, t);
        var hitNode = el("circle", { class: "hit", cx: cxp, cy: cy, r: Math.max(r, 3),
                                     "data-tooltip": tip, "data-date": t.d });
        if (d >= TODAY) {
          hitNode.setAttribute("cursor", "pointer");
          hitNode.addEventListener("click", function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            toggleSelect(t.d);
          });
        }
        g.appendChild(hitNode);
        var mkClass = (past && !isProp ? "mk-past" : "mk-future") + " cat-" + meta.cat;
        if (split) {
          // 上下分片：上=被取消（灰），下=存续（原色），面积按数值比例
          var frac = (orig - u) / orig;
          var h = solveSplit(r, frac);
          var ys = cy - h;
          var ct = "ct" + (clipSeq++), cb = "cb" + (clipSeq++);
          var cpT = el("clipPath", { id: ct });
          cpT.appendChild(el("rect", { x: cxp - r - 1, y: cy - r - 1, width: 2 * r + 2, height: Math.max(0, ys - (cy - r)) + 1 }));
          defs.appendChild(cpT);
          var cpB = el("clipPath", { id: cb });
          cpB.appendChild(el("rect", { x: cxp - r - 1, y: ys, width: 2 * r + 2, height: Math.max(0, cy + r - ys) + 1 }));
          defs.appendChild(cpB);
          g.appendChild(el("circle", { class: mkClass, cx: cxp, cy: cy, r: r, "clip-path": "url(#" + cb + ")" }));
          g.appendChild(el("circle", { class: (past ? "mk-cancel-part-past" : "mk-cancel-part-future"),
                                       cx: cxp, cy: cy, r: r, "clip-path": "url(#" + ct + ")" }));
        } else {
          g.appendChild(el("circle", { class: mkClass, cx: cxp, cy: cy, r: r }));
        }
      });
    });

    var tgx = x(TODAY);
    var summaries = [];
    var tg = el("g", { class: "today" });
    tg.appendChild(el("line", { x1: tgx, x2: tgx, y1: m.top - 8, y2: m.top + ORDER.length * laneH }));
    g.appendChild(tg);
    var todaySummary = el('g', { class: 'summary-block', 'data-summary': 'today' });
    todaySummary.appendChild(el('rect', { class: 'date-pill', x: tgx - 61, y: lineLabelY - 13, width: 122, height: 23, rx: 6 }));
    todaySummary.appendChild(el('text', { class: 'summary-date', x: tgx, y: lineLabelY + 2, 'text-anchor': 'middle' }, '今天 ' + fmtDate(TODAY)));
    g.appendChild(todaySummary);
    summaries.push({ node: todaySummary, anchor: tgx, guide: tg });

    // 顶部累计读数：股数口径显示份额，回购价口径显示金额（股数 × 单价）
    textFit(lg, { class: "lane-sub", x: narrow ? 14 : 24, y: 36 },
            state.valueMode ? "累计归属金额（USD）" : "累计已归属（份/股）", labelW - (narrow ? 8 : 26) - 12);
    textFit(lg, { class: 'lane-sub', x: narrow ? 14 : 24, y: 54 }, '今天 · 仅计已生效授予', labelW - 26);
    if (state.selected) textFit(lg, { class: 'lane-sub', x: narrow ? 14 : 24, y: 72 }, '选中 · 含拟授予计划', labelW - 26);
    [["dola", tgx - 8, -1], ["option", tgx + 8, 1]].forEach(function (spec) {
      var cat = spec[0];
      if (!state[cat]) return;
      var r = radius(nowByCat[cat], cat);
      var cx = spec[1] + spec[2] * r, cy = cumCy;
      var pendingUnits = ALL.reduce(function (s, t) { return s + (t[2] === cat && t[4] === "ptranche" ? t[3] : 0); }, 0);
      todaySummary.appendChild(el("circle", { class: "mk-past cat-" + cat, cx: cx, cy: cy, r: r,
                                   "data-tooltip": catName(cat) + " · 截至今天" +
                                                   (state.valueMode
                                                     ? "累计归属金额 ≈" + usd(markValue(cat, nowByCat[cat])) +
                                                       "（" + money(nowByCat[cat]) + " " + unit(cat) + " × " + usd(priceOf(cat)) + "）"
                                                     : "累计已归属 " + money(nowByCat[cat]) + " " + unit(cat)) +
                                                   "，仅已生效授予；拟授予另有 " + money(pendingUnits) + " " + unit(cat) + "，未生效" +
                                                   (state.valueMode && pendingUnits ? "（≈" + usd(markValue(cat, pendingUnits)) + "）" : "") }));
      todaySummary.appendChild(el("text", { class: "now-value", x: spec[1], y: cy - maxCumR - 8, "text-anchor": spec[2] < 0 ? 'end' : 'start' },
                       state.valueMode ? usd(markValue(cat, nowByCat[cat])) : money(nowByCat[cat])));
    });

    // 日期线保留真实时间坐标，表头累计组可通过引导线水平避让。
    var selDate = state.selected ? parse(state.selected) : null;
    if (selDate && selDate >= TODAY) {
      var sx = x(selDate);
      var selG = el("g", { class: "today selected" });
      selG.appendChild(el("line", { x1: sx, x2: sx, y1: m.top - 8, y2: m.top + ORDER.length * laneH }));
      g.appendChild(selG);
      var selectedSummary = el('g', { class: 'summary-block', 'data-summary': 'selected' });
      selectedSummary.appendChild(el('rect', { class: 'date-pill', x: sx - 61, y: lineLabelY - 13, width: 122, height: 23, rx: 6 }));
      selectedSummary.appendChild(el('text', { class: 'summary-date', x: sx, y: lineLabelY + 2, 'text-anchor': 'middle' }, '选中 ' + state.selected));
      g.appendChild(selectedSummary);
      summaries.push({ node: selectedSummary, anchor: sx, guide: selG });
      [["dola", sx - 8, -1], ["option", sx + 8, 1]].forEach(function (spec) {
        var cat = spec[0];
        if (!state[cat]) return;
        var cum = cumAt(cat, selDate);
        var r2 = radius(cum.total, cat);
        var cx2 = spec[1] + spec[2] * r2, cy2 = cumCy;
        selectedSummary.appendChild(el("circle", { class: "mk-past cat-" + cat, cx: cx2, cy: cy2, r: r2,
                                     "data-tooltip": catName(cat) + " · 截至 " + state.selected +
                                                     (state.valueMode
                                                       ? " 累计归属金额 ≈" + usd(markValue(cat, cum.total)) +
                                                         "（" + money(cum.total) + " " + unit(cat) + " × " + usd(priceOf(cat)) + "）"
                                                       : " 累计归属 " + money(cum.total) + " " + unit(cat)) +
                                                     "＝已生效 " + money(cum.effective) + " " + unit(cat) +
                                                     (cum.proposed ? " ＋ 拟授予 " + money(cum.proposed) + " " + unit(cat) +
                                                                     "（未生效，若生效则计入" +
                                                                     (state.valueMode ? "，≈" + usd(markValue(cat, cum.proposed)) : "") + "）" : "") }));
        selectedSummary.appendChild(el("text", { class: "now-value", x: spec[1], y: cy2 - maxCumR - 8, "text-anchor": spec[2] < 0 ? 'end' : 'start' },
                         state.valueMode ? usd(markValue(cat, cum.total)) : money(cum.total)));
      });
    }

    // 测量整组实际边界（包括文字与日期标签），保持内部排版不变后整体平移。
    var summaryGap = 24, summaryPad = 8;
    var bounds = summaries.map(function (summary) {
      var box = summary.node.getBBox();
      return { left: box.x - 1, width: box.width + 2 };
    });
    var requiredWidth = bounds.reduce(function (sum, box) { return sum + box.width; }, 2 * summaryPad) +
      (bounds.length - 1) * summaryGap;
    var canvasW = Math.max(W, Math.ceil(requiredWidth));
    // 只扩大滚动画布，x 的定义域和值域、期次位置和日期线均保持不变。
    plotSvg.setAttribute('width', canvasW);
    plotSvg.setAttribute('viewBox', '0 0 ' + canvasW + ' ' + H);
    var lefts = bounds.map(function (box) {
      return Math.max(summaryPad, Math.min(canvasW - summaryPad - box.width, box.left));
    });
    if (bounds.length === 2 && lefts[0] + bounds[0].width + summaryGap > lefts[1]) {
      var packedWidth = bounds[0].width + summaryGap + bounds[1].width;
      var balancedLeft = (lefts[0] + lefts[1] - bounds[0].width - summaryGap) / 2;
      lefts[0] = Math.max(summaryPad, Math.min(canvasW - summaryPad - packedWidth, balancedLeft));
      lefts[1] = lefts[0] + bounds[0].width + summaryGap;
    }
    summaries.forEach(function (summary, i) {
      var dx = lefts[i] - bounds[i].left;
      summary.node.setAttribute('transform', 'translate(' + dx + ' 0)');
      summary.node.addEventListener('click', function (ev) { ev.stopPropagation(); });
      summary.guide.appendChild(el('path', { class: 'summary-connector',
        d: 'M ' + (summary.anchor + dx) + ' ' + (lineLabelY + 11) +
           ' V ' + (lineLabelY + 17) + ' L ' + summary.anchor + ' ' + (m.top - 8) }));
    });
    // 画布拓宽后再恢复滚动，避免浏览器按旧宽度提前截断原来的位置。
    scroll.scrollLeft = keepScroll === null ? Math.max(0, x(TODAY) - Math.min(240, scroll.clientWidth * 0.6)) : keepScroll;
  }

  function bind(id, key) {
    var btn = root.querySelector(id);
    if (!btn) return;
    btn.addEventListener("click", function () {
      state[key] = !state[key];
      btn.setAttribute("aria-pressed", state[key] ? "true" : "false");
      render();
    });
  }

  function render() {
    clearTimeout(tipTimer);
    if (tipEl) { tipEl.hidden = true; tipTarget = null; }
    var hint = document.getElementById('hint');
    if (hint) {
      if (state.selected) {
        var sd = parse(state.selected);
        var pd = cumAt('dola', sd).proposed, po = cumAt('option', sd).proposed;
        hint.textContent = '已选中 ' + state.selected +
          ((pd || po) ? '（累计已含拟授予：豆包股 +' + money(pd) + '、期权 +' + money(po) + '，若生效则计入）' : '') +
          '：点击其他位置切换，点击今天左侧取消';
      } else {
        hint.textContent = '点击今天右侧，查看未来累计 · 点击左侧取消';
      }
    }
    renderTimeline(Math.max(320, Math.round(root.clientWidth || 736)) < 520);
  }

  bind("#lg-dola", "dola");
  bind("#lg-option", "option");
  bind("#lg-past", "past");
  bind("#lg-future", "future");

  var vmUnits = root.querySelector("#vm-units"), vmValue = root.querySelector("#vm-value");
  var priceCtl = root.querySelector("#price-ctl");
  var priceInputs = { option: root.querySelector("#price-option"), dola: root.querySelector("#price-dola") };
  function syncPriceInputs() {
    ["option", "dola"].forEach(function (cat) {
      var el2 = priceInputs[cat];
      if (el2) el2.value = prices[cat];
    });
  }
  ["option", "dola"].forEach(function (cat) {
    var el2 = priceInputs[cat];
    if (!el2) return;
    el2.addEventListener("input", function () {
      var v = parseFloat(el2.value);
      if (!isNaN(v) && v >= 0) { prices[cat] = v; render(); }
    });
  });
  syncPriceInputs();
  function setMode(v) {
    state.valueMode = v;
    if (vmUnits) vmUnits.setAttribute("aria-pressed", v ? "false" : "true");
    if (vmValue) vmValue.setAttribute("aria-pressed", v ? "true" : "false");
    if (priceCtl) priceCtl.hidden = !v;
    if (v) syncPriceInputs();
    render();
  }
  if (vmUnits) vmUnits.addEventListener("click", function () { setMode(false); });
  if (vmValue) vmValue.addEventListener("click", function () { setMode(true); });

  var mergeN = root.querySelector("#mergeN");
  if (mergeN) {
    mergeN.addEventListener("input", function () {
      var v = parseInt(mergeN.value, 10);
      state.mergeDays = isNaN(v) ? 0 : Math.max(0, Math.min(365, v));
      render();
    });
  }

  renderNextVesting();
  render();
  if (window.ResizeObserver) {
    var raf = null;
    new ResizeObserver(function () {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    }).observe(root);
  }
  }
})();
