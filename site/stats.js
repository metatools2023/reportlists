"use strict";

/* reportlists 数据洞察页：拉取 data/stats/*.json 预聚合分片，ECharts 渲染。 */

(() => {

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const fmtInt = (n) => n == null ? "—" : Number(n).toLocaleString("zh-CN");

const C = {
  text: "#e7eaf2", muted: "#8b93a7", line: "#232e47", card: "#182136", bg2: "#131a2b",
  accent: "#5b8cff", accent2: "#3d6ae0",
  green: "#3ecf8e", orange: "#f5a623", blue: "#6ea1ff", red: "#ff6b6b",
};
// A 股习惯：红涨绿跌
const BUCKETS = {
  buy: { name: "买入", color: C.red },
  add: { name: "增持", color: C.orange },
  neutral: { name: "中性", color: C.muted },
  reduce: { name: "减持", color: C.blue },
  sell: { name: "卖出", color: C.green },
};
const QTYPES = [
  { key: "q0", name: "个股", color: C.blue },
  { key: "q1", name: "行业", color: C.green },
  { key: "q2", name: "策略", color: C.orange },
];
const KW_COLORS = [C.accent, C.blue, C.green, C.orange, C.red, "#a8c6ff", "#7ee0b8", "#e8b3ff"];

async function fetchJSON(url) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
      if (i === 0) await new Promise((res) => setTimeout(res, 600));
    }
  }
  throw lastErr;
}

// ---------- ECharts 公共 ----------
const charts = [];
function mkChart(id, opt) {
  const el = $(id);
  if (!el) return null;
  const ch = echarts.init(el, null, { renderer: "canvas" });
  ch.setOption(opt);
  charts.push(ch);
  return ch;
}
window.addEventListener("resize", debounce(() => charts.forEach((c) => c.resize()), 150));

const axisBase = () => ({
  axisLine: { lineStyle: { color: C.line } },
  axisLabel: { color: C.muted, fontSize: 11 },
  axisTick: { show: false },
});
const yBase = () => ({
  ...axisBase(),
  axisLine: { show: false },
  splitLine: { lineStyle: { color: C.line, opacity: .45 } },
});
const tipBase = () => ({
  backgroundColor: C.card, borderColor: C.line, borderWidth: 1,
  textStyle: { color: C.text, fontSize: 12.5 },
  axisPointer: { lineStyle: { color: C.muted } },
});
const legendBase = () => ({
  textStyle: { color: C.muted, fontSize: 11.5 }, inactiveColor: "#4a5165",
  itemWidth: 14, itemHeight: 9, top: 2,
});
const GRID = { left: 8, right: 14, top: 36, bottom: 46, containLabel: true };
const dataZoomDark = () => [
  { type: "inside" },
  {
    type: "slider", height: 18, bottom: 8, borderColor: C.line,
    backgroundColor: "rgba(24,33,54,.6)", fillerColor: "rgba(91,140,255,.22)",
    handleStyle: { color: C.accent2 }, moveHandleStyle: { color: C.accent2 },
    textStyle: { color: C.muted, fontSize: 10 },
    dataBackground: { lineStyle: { color: C.line }, areaStyle: { color: C.line, opacity: .4 } },
    selectedDataBackground: { lineStyle: { color: C.accent }, areaStyle: { color: C.accent2, opacity: .3 } },
  },
];
const monthTick = (v) => v.endsWith("-01") ? v.slice(0, 4) : "";
const xMonths = (months) => ({
  ...axisBase(), type: "category", data: months, boundaryGap: true,
  axisLabel: { ...axisBase().axisLabel, formatter: monthTick },
});

// 移动平均（跳过 null）
function ma(arr, w) {
  return arr.map((v, i) => {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - w + 1); j <= i; j++) {
      if (arr[j] != null) { s += arr[j]; n++; }
    }
    return n ? +(s / n).toFixed(3) : null;
  });
}

// ---------- 各板块渲染 ----------

function renderOverview(ov) {
  const [d0, d1] = ov.date_range;
  const items = [
    [fmtInt(ov.total), "研报总数"],
    [`${d0.slice(0, 7)} ~ ${d1.slice(0, 7)}`, "时间跨度"],
    [fmtInt(ov.orgs), "机构"],
    [fmtInt(ov.industries), "行业"],
    [fmtInt(ov.researchers), "研究员(姓名+机构)"],
    [fmtInt(ov.stocks), "覆盖个股"],
    [`${fmtInt(ov.rated)}`, `含评级报告 (${(ov.rated * 100 / ov.total).toFixed(1)}%)`],
    [ov.avg_pages ?? "—", "平均页数"],
  ];
  $("cards").innerHTML = items.map(([v, k]) =>
    `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join("");
  $("genAt").textContent = new Date(ov.generated_at).toLocaleString("zh-CN", { hour12: false });
  $("mTotal").textContent = fmtInt(ov.total);
  $("mRes").textContent = fmtInt(ov.researchers);
}

function renderTrend(mo) {
  const sentiMA = ma(mo.sentiment, 3);
  mkChart("cTrend", {
    tooltip: { trigger: "axis", ...tipBase() },
    legend: legendBase(),
    grid: GRID,
    xAxis: xMonths(mo.months),
    yAxis: [
      { ...yBase(), type: "value", name: "篇/月", nameTextStyle: { color: C.muted } },
      {
        ...yBase(), type: "value", name: "情绪指数", min: 0.3, max: 0.9, splitLine: { show: false },
        nameTextStyle: { color: C.muted },
      },
    ],
    dataZoom: dataZoomDark(),
    series: [
      ...QTYPES.map((q) => ({
        name: q.name, type: "bar", stack: "total", barMaxWidth: 14,
        itemStyle: { color: q.color }, emphasis: { focus: "series" },
        data: mo.qtype[q.key],
      })),
      {
        name: "情绪指数(3MA)", type: "line", yAxisIndex: 1, smooth: true, symbol: "none",
        lineStyle: { color: C.accent, width: 2 }, itemStyle: { color: C.accent },
        data: sentiMA, z: 5,
      },
    ],
  });
}

function renderSentiment(mo) {
  mkChart("cSenti", {
    tooltip: {
      trigger: "axis", ...tipBase(),
      valueFormatter: (v) => v == null ? "—" : v,
    },
    legend: legendBase(),
    grid: GRID,
    xAxis: xMonths(mo.months),
    yAxis: [
      { ...yBase(), type: "value", name: "情绪指数", min: 0.3, max: 0.9, nameTextStyle: { color: C.muted } },
      {
        ...yBase(), type: "value", name: "买入占比%", min: 20, max: 70, splitLine: { show: false },
        axisLabel: { color: C.muted, fontSize: 11, formatter: "{value}%" },
        nameTextStyle: { color: C.muted },
      },
    ],
    dataZoom: dataZoomDark(),
    series: [
      {
        name: "情绪指数(原始)", type: "line", symbol: "none", smooth: true, connectNulls: true,
        lineStyle: { color: C.accent, width: 1, opacity: .35 }, itemStyle: { color: C.accent },
        data: mo.sentiment,
      },
      {
        name: "情绪指数(3MA)", type: "line", symbol: "none", smooth: true, connectNulls: true,
        lineStyle: { color: C.accent, width: 2.5 }, itemStyle: { color: C.accent },
        data: ma(mo.sentiment, 3),
      },
      {
        name: "买入占比", type: "line", yAxisIndex: 1, symbol: "none", smooth: true, connectNulls: true,
        lineStyle: { color: C.red, width: 2 }, itemStyle: { color: C.red },
        data: mo.buy_pct,
      },
    ],
  });

  // 评级结构 100% 堆叠
  const keys = Object.keys(BUCKETS);
  const rated = mo.months.map((_, i) => keys.reduce((s, k) => s + (mo.rating[k][i] || 0), 0));
  mkChart("cRating", {
    tooltip: {
      trigger: "axis", ...tipBase(),
      valueFormatter: (v) => v == null ? "—" : v.toFixed(1) + "%",
    },
    legend: legendBase(),
    grid: GRID,
    xAxis: xMonths(mo.months),
    yAxis: { ...yBase(), type: "value", max: 100, axisLabel: { color: C.muted, fontSize: 11, formatter: "{value}%" } },
    dataZoom: dataZoomDark(),
    series: keys.map((k) => ({
      name: BUCKETS[k].name, type: "line", stack: "pct", symbol: "none", smooth: true,
      lineStyle: { width: .5, color: BUCKETS[k].color },
      areaStyle: { color: BUCKETS[k].color, opacity: .75 },
      emphasis: { focus: "series" },
      data: mo.rating[k].map((v, i) => rated[i] ? +(v * 100 / rated[i]).toFixed(2) : null),
    })),
  });
}

function renderHeatmap(hm) {
  const data = [];
  let vmax = 0;
  hm.matrix.forEach((row, yi) => row.forEach((v, xi) => {
    if (v > 0) data.push([xi, yi, v]);
    if (v > vmax) vmax = v;
  }));
  mkChart("cHeat", {
    tooltip: {
      ...tipBase(),
      formatter: (p) => `${esc(hm.industries[p.value[1]])} · ${hm.months[p.value[0]]}<br/><b>${p.value[2]}</b> 篇`,
    },
    grid: { left: 8, right: 16, top: 8, bottom: 78, containLabel: true },
    xAxis: { ...xMonths(hm.months), splitArea: { show: false } },
    yAxis: {
      ...axisBase(), type: "category", data: hm.industries, inverse: true,
      axisLabel: { color: C.muted, fontSize: 11 },
      splitLine: { show: false },
    },
    visualMap: {
      min: 0, max: vmax, calculable: true, orient: "horizontal", left: "center", bottom: 40,
      textStyle: { color: C.muted, fontSize: 11 },
      inRange: { color: ["#141b2e", "#1d2946", "#2a3c68", "#3d6ae0", "#5b8cff", "#9fc1ff", "#e0ecff"] },
    },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8, borderColor: C.line,
      backgroundColor: "rgba(24,33,54,.6)", fillerColor: "rgba(91,140,255,.22)",
      handleStyle: { color: C.accent2 }, moveHandleStyle: { color: C.accent2 },
      textStyle: { color: C.muted, fontSize: 10 } }],
    series: [{
      type: "heatmap", data,
      itemStyle: { borderColor: C.bg2, borderWidth: 1 },
      emphasis: { itemStyle: { shadowBlur: 8, shadowColor: "rgba(91,140,255,.6)" } },
    }],
  });
}

function barChart(id, labels, values, name, noteFmt) {
  mkChart(id, {
    tooltip: { trigger: "axis", ...tipBase(), valueFormatter: noteFmt },
    grid: { left: 8, right: 16, top: 30, bottom: 8, containLabel: true },
    xAxis: { ...axisBase(), type: "category", data: labels },
    yAxis: { ...yBase(), type: "value" },
    series: [{
      name, type: "bar", data: values, barMaxWidth: 22,
      itemStyle: { color: C.accent2, borderRadius: [3, 3, 0, 0] },
      emphasis: { itemStyle: { color: C.accent } },
    }],
  });
}

function renderRhythm(tp) {
  barChart("cWeekday", tp.weekday.labels, tp.weekday.counts, "报告数", (v) => fmtInt(v) + " 篇");
  barChart("cMoy", tp.month_of_year.labels, tp.month_of_year.counts, "报告数", (v) => fmtInt(v) + " 篇");
  barChart("cDom", tp.day_of_month.labels, tp.day_of_month.per_occurrence, "每出现1次平均", (v) => v + " 篇");
}

function renderKeywords(kw) {
  const years = kw.years;
  const btns = $("kwBtns");
  let cur = years[0];
  let ch = null;

  function draw(year) {
    const words = kw.words[year] || [];
    if (window.__wcReady) {
      const el = $("cKw");
      const opt = {
        tooltip: { ...tipBase(), formatter: (p) => `${esc(p.name)}：${p.value} 次` },
        series: [{
          type: "wordCloud", shape: "square", gridSize: 8, sizeRange: [16, 80],
          width: (el.clientWidth - 16) + "px", height: (el.clientHeight - 16) + "px",
          left: "center", top: "center", drawOutOfBound: false,
          textStyle: {
            fontFamily: "system-ui, sans-serif",
            color: () => KW_COLORS[Math.floor(Math.random() * KW_COLORS.length)],
          },
          emphasis: { textStyle: { textShadowBlur: 8, textShadowColor: "rgba(91,140,255,.8)" } },
          data: words.map(([name, value]) => ({ name, value })),
        }],
      };
      if (ch) ch.setOption(opt, { notMerge: true });
      else ch = mkChart("cKw", opt);
    } else {
      // 词云插件加载失败 → 横向条形图降级
      const top = words.slice(0, 20).reverse();
      const opt = {
        tooltip: { trigger: "axis", ...tipBase(), valueFormatter: (v) => fmtInt(v) + " 次" },
        grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
        xAxis: { ...yBase(), type: "value" },
        yAxis: { ...axisBase(), type: "category", data: top.map(([w]) => w),
                 axisLabel: { color: C.muted, fontSize: 11.5 } },
        series: [{ type: "bar", data: top.map(([, c]) => c), barMaxWidth: 14,
                   itemStyle: { color: C.accent2, borderRadius: [0, 3, 3, 0] } }],
      };
      if (ch) ch.setOption(opt, { notMerge: true });
      else ch = mkChart("cKw", opt);
    }
  }

  btns.innerHTML = years.map((y) =>
    `<button data-y="${esc(y)}"${y === cur ? ' class="on"' : ""}>${esc(y)}</button>`).join("");
  btns.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.y === cur) return;
    cur = b.dataset.y;
    btns.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    draw(cur);
  });
  // 词云尺寸为像素值，窗口变化需重绘
  window.addEventListener("resize", debounce(() => { if (ch) draw(cur); }, 250));
  draw(cur);
}

function renderTable(elId, cols, rows, defKey) {
  const box = $(elId);
  let sortKey = defKey, asc = false;

  function fmt(col, v) {
    if (v == null) return "—";
    if (col.fmt) return col.fmt(v);
    return col.num ? fmtInt(v) : esc(v);
  }

  function draw() {
    const sorted = [...rows].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const d = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb), "zh-CN");
      return asc ? d : -d;
    });
    const head = cols.map((c) =>
      `<th class="${c.num ? "num" : ""}" data-k="${c.k}">${esc(c.label)}` +
      (c.k === sortKey ? `<span class="arr">${asc ? "▲" : "▼"}</span>` : "") + "</th>").join("");
    const body = sorted.map((r, i) =>
      `<tr><td class="rank">${i + 1}</td>` + cols.map((c) => {
        let cls = c.num ? "num" : "";
        let v = r[c.k];
        if (c.k === "buy_pct" && v != null) cls += v >= 65 ? " hot" : (v <= 35 ? " cold" : "");
        return `<td class="${cls}">${fmt(c, v)}</td>`;
      }).join("") + "</tr>").join("");
    box.innerHTML = `<table class="rtable"><thead><tr><th class="rank">#</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  box.addEventListener("click", (e) => {
    const th = e.target.closest("th");
    if (!th || !th.dataset.k) return;
    if (th.dataset.k === sortKey) asc = !asc;
    else { sortKey = th.dataset.k; asc = false; }
    draw();
  });
  draw();
}

const ORG_COLS = [
  { k: "name", label: "机构" },
  { k: "total", label: "研报数", num: true },
  { k: "rated", label: "含评级", num: true },
  { k: "buy_pct", label: "买入占比", num: true, fmt: (v) => v + "%" },
  { k: "inds", label: "覆盖行业", num: true },
  { k: "stocks", label: "覆盖个股", num: true },
  { k: "researchers", label: "研究员", num: true },
  { k: "avg_pages", label: "均页数", num: true },
];
const RES_COLS = [
  { k: "name", label: "姓名" },
  { k: "org", label: "机构" },
  { k: "total", label: "研报数", num: true },
  { k: "inds", label: "覆盖行业", num: true },
  { k: "stocks", label: "覆盖个股", num: true },
  { k: "collabs", label: "合作者", num: true },
];

// ---------- 主流程 ----------

async function main() {
  if (typeof echarts === "undefined") throw new Error("ECharts CDN 加载失败");
  const [overview, monthly, heatmap, timepatterns, orgs, researchers, keywords] =
    await Promise.all([
      "overview", "monthly", "heatmap", "timepatterns", "orgs", "researchers", "keywords",
    ].map((f) => fetchJSON(`data/stats/${f}.json`)));
  if (!overview || !monthly) throw new Error("统计数据缺失");

  renderOverview(overview);
  renderTrend(monthly);
  renderSentiment(monthly);
  renderHeatmap(heatmap);
  renderRhythm(timepatterns);
  renderKeywords(keywords);
  renderTable("orgsTable", ORG_COLS, orgs, "total");
  renderTable("researchersTable", RES_COLS, researchers, "total");
}

main().catch((e) => {
  console.error(e);
  $("err").classList.remove("hidden");
  $("errDetail").textContent = String(e && e.message || e);
});

})();
