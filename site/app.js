"use strict";

(() => {

const EARLIEST = "2017-01";
const INITIAL_MONTHS = 2;
const YEAR_MONTHS = 12;
const PAGE_SIZE = 60;
const RENDER_CAP = 3000;
const CLOUD_TOP = 80;

const TYPE_NAMES = { 0: "个股", 1: "行业", 2: "策略" };
const DIMS = ["industry", "org", "rating", "researcher", "stock"];
const DIM_NAMES = { industry: "行业", org: "机构", rating: "评级", researcher: "研究员", stock: "个股" };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pdfUrl = (ic) => `https://pdf.dfcfw.com/pdf/H3_${ic}_1.pdf`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const S = {
  tags: null, years: [],
  monthData: new Map(),
  records: [],
  loading: false, reachedEnd: false, yearEnsured: false,
  scope: "loaded",
  idxLoaded: false, idxYears: new Map(),
  filters: { qType: "", industry: "", org: "", rating: "", researcher: "", stock: "" },
  query: "", curDim: "industry", tagQuery: "",
  filtered: [], rendered: 0,
};

const listEl = $("list"), sentinelEl = $("sentinel"), emptyEl = $("empty"),
  resultStat = $("resultStat"), activeEl = $("activeFilters"), cloudEl = $("cloud"),
  qInput = $("q"), tagQInput = $("tagq"), toastEl = $("toast"),
  progressEl = $("progress"), progressBar = $("progressBar"), progressText = $("progressText");

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 4000);
}

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

function ymNow() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function ymShift(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

function normFull(r) {
  return {
    infoCode: r.infoCode, date: r.publishDate || "", title: r.title || "",
    org: r.orgSName || r.orgName || "", industry: r.industryName || "",
    rating: r.emRatingName || r.sRatingName || "",
    researcher: r.researcher || "", stock: r.stockName || "",
    qType: r.qType, pages: r.attachPages || 0,
  };
}

function normIdxInPlace(r) {
  r.infoCode = r.i; r.date = r.d; r.title = r.t; r.org = r.o; r.industry = r.n;
  r.rating = r.r; r.researcher = r.a; r.stock = r.s; r.qType = r.q; r.pages = 0;
  delete r.i; delete r.d; delete r.t; delete r.o; delete r.n; delete r.r; delete r.a;
  delete r.s; delete r.q;
  return r;
}

function rebuildRecords() {
  S.records = [];
  for (const ym of [...S.monthData.keys()].sort().reverse()) S.records.push(...S.monthData.get(ym));
}

async function loadMonth(ym) {
  if (S.monthData.has(ym)) return true;
  const data = await fetchJSON(`data/reports-${ym}.json`);
  if (!data || !data.length) return false;
  S.monthData.set(ym, data.map(normFull).reverse());
  return true;
}

async function initialLoad() {
  let ym = ymNow(), n = 0, guard = 0;
  while (n < INITIAL_MONTHS && ym >= EARLIEST && guard++ < 24) {
    if (await loadMonth(ym)) n++;
    ym = ymShift(ym, -1);
  }
  rebuildRecords();
}

async function ensureYear() {
  if (S.yearEnsured) return;
  S.loading = true; setSentinel("加载近 12 个月数据…");
  try {
    const missing = [];
    for (let i = 0; i < YEAR_MONTHS; i++) {
      const ym = ymShift(ymNow(), -i);
      if (!S.monthData.has(ym) && ym >= EARLIEST) missing.push(ym);
    }
    await Promise.all(missing.map((ym) => loadMonth(ym)));
    rebuildRecords();
    S.yearEnsured = true;
  } catch (e) {
    toast(`加载失败：${e.message}`);
  } finally { S.loading = false; }
}

async function loadYearIndexes() {
  if (S.idxLoaded) return;
  const total = S.years.length;
  showProgress(0, `0/${total} 年（约需下载 30MB+）`);
  let done = 0;
  await Promise.all(S.years.map(async (y) => {
    try {
      const data = await fetchJSON(`data/index-${y.year}.json`);
      if (data && data.reports) {
        for (const r of data.reports) normIdxInPlace(r);
        S.idxYears.set(y.year, data.reports);
      }
    } catch (e) {
      toast(`${y.year} 年索引加载失败：${e.message}`);
    }
    done++; showProgress(done / total, `${done}/${total} 年`);
  }));
  S.idxLoaded = true;
  hideProgress();
}

function showProgress(frac, text) {
  progressEl.classList.remove("hidden");
  progressBar.style.width = `${Math.round(frac * 100)}%`;
  progressText.textContent = `加载全库索引 ${text}`;
}
function hideProgress() { progressEl.classList.add("hidden"); }

function sourceList() {
  if (S.scope === "deep") {
    const out = [];
    for (const y of S.years) {
      const arr = S.idxYears.get(y.year);
      if (arr) for (let i = arr.length - 1; i >= 0; i--) out.push(arr[i]);
    }
    return out;
  }
  return S.records;
}

function matchRecord(r) {
  const f = S.filters;
  if (f.qType !== "" && String(r.qType) !== f.qType) return false;
  if (f.industry && r.industry !== f.industry) return false;
  if (f.org && r.org !== f.org) return false;
  if (f.rating && r.rating !== f.rating) return false;
  if (f.researcher && r.researcher !== f.researcher) return false;
  if (f.stock && r.stock !== f.stock) return false;
  if (S.query) {
    const q = S.query;
    if (!(r.title.toLowerCase().includes(q) || r.org.toLowerCase().includes(q) ||
          r.researcher.toLowerCase().includes(q) || r.stock.toLowerCase().includes(q) ||
          r.industry.toLowerCase().includes(q))) return false;
  }
  return true;
}

function refreshList(reset) {
  const before = S.rendered;
  const src = sourceList();
  const out = [];
  for (let i = 0; i < src.length; i++) if (matchRecord(src[i])) out.push(src[i]);
  S.filtered = out;
  if (reset) { S.rendered = 0; listEl.textContent = ""; }
  if (S.rendered < Math.min(out.length, RENDER_CAP)) renderMore();
  updateStat(); updateEmpty(); updateSentinel();
  if (reset) maybeAutoLoad();
  return S.rendered - before;
}

function maybeAutoLoad() {
  if (S.scope === "loaded" && !S.loading && !S.reachedEnd &&
      S.rendered >= S.filtered.length && S.filtered.length <= RENDER_CAP &&
      sentinelVisible()) loadOlder(true);
}

function renderMore() {
  const end = Math.min(S.filtered.length, S.rendered + PAGE_SIZE, RENDER_CAP);
  const frag = document.createDocumentFragment();
  for (; S.rendered < end; S.rendered++) frag.appendChild(cardEl(S.filtered[S.rendered]));
  listEl.appendChild(frag);
}

function cardEl(r) {
  const a = document.createElement("a");
  a.className = `card t${r.qType}`;
  a.href = pdfUrl(r.infoCode);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = "在新标签打开原文 PDF";
  a.innerHTML = `
    <div class="meta">
      <time>${esc(r.date)}</time>
      <span class="tbadge">${TYPE_NAMES[r.qType] || "研报"}</span>
      ${r.rating ? `<span class="rbadge">${esc(r.rating)}</span>` : ""}
    </div>
    <h3>${esc(r.title)}</h3>
    <div class="info">
      <span class="org">${esc(r.org)}</span>
      ${r.researcher ? `<span class="dot">·</span><span>${esc(r.researcher)}</span>` : ""}
      ${r.stock ? `<span class="dot">·</span><span class="stock">${esc(r.stock)}</span>` : ""}
    </div>
    <div class="sub">
      ${r.industry ? `<span>${esc(r.industry)}</span>` : ""}
      ${r.pages ? `<span>${r.pages} 页</span>` : ""}
    </div>`;
  return a;
}

function updateStat() {
  const parts = [];
  if (S.scope === "deep") parts.push(`全库 ${S.tags.total.toLocaleString()} 条`);
  else {
    const yms = [...S.monthData.keys()].sort();
    if (yms.length) parts.push(`已加载 ${yms.length} 个月（${yms[0]} ~ ${yms[yms.length - 1]}）· ${S.records.length.toLocaleString()} 条`);
  }
  parts.push(`结果 <b>${S.filtered.length.toLocaleString()}</b> 条`);
  if (S.filtered.length > RENDER_CAP) parts.push(`仅渲染前 ${RENDER_CAP} 条，请细化条件`);
  resultStat.innerHTML = parts.join(" · ") +
    (S.scope === "loaded" && S.query ? ` · <span class="hint">仅搜索已加载范围，可切换「近1年 / 全库」</span>` : "");
}

function setSentinel(text) { sentinelEl.textContent = text; }

function updateSentinel() {
  if (S.scope === "deep") { setSentinel("全库模式 · 全部数据已载入内存"); return; }
  if (S.scope === "year") { setSentinel("近1年模式 · 滚动加载更多结果"); return; }
  if (S.loading) { setSentinel("加载中…"); return; }
  if (S.reachedEnd) { setSentinel(`已到最早数据（${EARLIEST}）`); return; }
  if (S.filtered.length > RENDER_CAP && S.rendered >= RENDER_CAP) {
    setSentinel(`已渲染 ${RENDER_CAP} 条上限 · 建议使用左侧筛选或搜索缩小范围`);
    return;
  }
  if (S.rendered >= S.filtered.length) setSentinel("点击或滚动到底部加载更早月份…");
  else setSentinel("继续下滑加载更多结果…");
}

function updateEmpty() {
  const empty = S.filtered.length === 0;
  emptyEl.classList.toggle("hidden", !empty);
  if (empty) {
    const hasCond = S.query || Object.values(S.filters).some(Boolean);
    emptyEl.innerHTML = hasCond
      ? `<p>没有匹配的结果</p><p class="sub">试试清除筛选条件${S.scope !== "deep" ? "，或切换到「全库」搜索更早的历史数据" : ""}</p>`
      : `<p>暂无数据</p>`;
  }
}

function sentinelVisible() {
  const r = sentinelEl.getBoundingClientRect();
  return r.top < innerHeight + 300;
}

async function loadOlder(auto = false) {
  if (S.loading || S.reachedEnd) return;
  S.loading = true;
  setSentinel("加载更早数据…");
  try {
    const loaded = [...S.monthData.keys()].sort();
    let ym = loaded.length ? ymShift(loaded[0], -1) : ymNow();
    let guard = 0;
    while (ym >= EARLIEST && guard++ < 130) {
      if (await loadMonth(ym)) { rebuildRecords(); break; }
      ym = ymShift(ym, -1);
    }
    if (ym < EARLIEST) S.reachedEnd = true;
  } catch (e) {
    toast(`加载失败：${e.message}`);
  } finally {
    S.loading = false;
    const added = refreshList(false);
    if (auto && added > 0 && sentinelVisible() && !S.reachedEnd) loadOlder(true);
  }
}

const onScroll = debounce(() => {
  if (!sentinelVisible()) return;
  if (S.scope === "loaded" && S.rendered >= S.filtered.length &&
      S.filtered.length <= RENDER_CAP) loadOlder(true);
  else if (S.rendered < Math.min(S.filtered.length, RENDER_CAP)) {
    renderMore(); updateStat(); updateSentinel();
  }
}, 120);

function updateTypeTabs() {
  for (const b of $("typeTabs").querySelectorAll("button"))
    b.classList.toggle("on", b.dataset.t === S.filters.qType);
}
function updateDimTabs() {
  for (const b of $("dimTabs").querySelectorAll("button"))
    b.classList.toggle("on", b.dataset.dim === S.curDim);
}
function updateScopeUI() {
  for (const b of $("scopeSwitch").querySelectorAll("button"))
    b.classList.toggle("on", b.dataset.scope === S.scope);
}

function renderCloud() {
  cloudEl.textContent = "";
  const dim = S.curDim;
  const tags = (S.tags && S.tags.tags && S.tags.tags[dim]) || [];
  const q = S.tagQuery;
  let shown = 0;
  for (const t of tags) {
    if (q && !t.name.toLowerCase().includes(q)) continue;
    if (shown++ >= CLOUD_TOP) break;
    const b = document.createElement("button");
    b.className = "chip" + (S.filters[dim] === t.name ? " on" : "");
    b.innerHTML = `${esc(t.name)}<span class="cnt">${t.count.toLocaleString()}</span>`;
    b.onclick = () => toggleFilter(dim, t.name);
    cloudEl.appendChild(b);
  }
  if (!shown) cloudEl.innerHTML = `<span class="cloud-note">无匹配标签</span>`;
}

function renderActive() {
  activeEl.textContent = "";
  const f = S.filters;
  const add = (label, val, dim) => {
    const b = document.createElement("button");
    b.className = "chip on";
    b.innerHTML = `${esc(label)}: ${esc(val)}<span class="x">×</span>`;
    b.onclick = () => { S.filters[dim] = ""; afterFilterChange(); };
    activeEl.appendChild(b);
  };
  if (f.qType !== "") add("类型", TYPE_NAMES[+f.qType], "qType");
  for (const d of DIMS) if (f[d]) add(DIM_NAMES[d], f[d], d);
  if (activeEl.children.length) {
    const clear = document.createElement("button");
    clear.className = "chip clear";
    clear.textContent = "清除全部";
    clear.onclick = () => {
      S.filters = { qType: "", industry: "", org: "", rating: "", researcher: "", stock: "" };
      afterFilterChange();
    };
    activeEl.appendChild(clear);
  }
}

function afterFilterChange() {
  renderActive(); renderCloud(); updateTypeTabs();
  refreshList(true); updateHash();
}

function toggleFilter(dim, name) {
  S.filters[dim] = S.filters[dim] === name ? "" : name;
  afterFilterChange();
}

function setType(t) {
  S.filters.qType = t;
  updateTypeTabs(); renderActive();
  refreshList(true); updateHash();
}

async function setScope(scope, fromAuto) {
  if (S.scope === scope) return;
  S.scope = scope;
  updateScopeUI();
  if (scope === "year") await ensureYear();
  if (scope === "deep" && !S.idxLoaded) await loadYearIndexes();
  refreshList(true);
  updateHash();
  if (!fromAuto) window.scrollTo({ top: 0 });
}

function onQueryChange() {
  S.query = qInput.value.trim().toLowerCase();
  if (S.query && S.scope === "loaded") setScope("year", true);
  else refreshList(true);
  updateHash();
}

function updateHash() {
  const p = new URLSearchParams();
  if (S.query) p.set("q", qInput.value.trim());
  if (S.scope !== "loaded") p.set("scope", S.scope);
  if (S.filters.qType !== "") p.set("t", S.filters.qType);
  for (const d of DIMS) if (S.filters[d]) p.set(d, S.filters[d]);
  const h = p.toString();
  history.replaceState(null, "", h ? `#${h}` : location.pathname);
}

async function applyHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const q = p.get("q") || "";
  qInput.value = q;
  S.query = q.toLowerCase();
  const t = p.get("t");
  S.filters.qType = ["0", "1", "2"].includes(t) ? t : "";
  for (const d of DIMS) S.filters[d] = p.get(d) || "";
  const scope = p.get("scope");
  if (scope === "year" || scope === "deep") S.scope = scope;
  else if (q) S.scope = "year";
  updateTypeTabs(); updateDimTabs(); updateScopeUI(); renderActive();
  if (S.scope === "year") await ensureYear();
  if (S.scope === "deep") await loadYearIndexes();
}

function bindUI() {
  qInput.addEventListener("input", debounce(onQueryChange, 250));
  tagQInput.addEventListener("input", debounce(() => {
    S.tagQuery = tagQInput.value.trim().toLowerCase();
    renderCloud();
  }, 150));
  $("dimTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-dim]");
    if (b) { S.curDim = b.dataset.dim; updateDimTabs(); renderCloud(); }
  });
  $("typeTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-t]");
    if (b) setType(b.dataset.t);
  });
  $("scopeSwitch").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-scope]");
    if (b) setScope(b.dataset.scope);
  });
  sentinelEl.addEventListener("click", () => {
    if (S.scope === "loaded" && S.filtered.length <= RENDER_CAP) loadOlder(false);
  });
  window.addEventListener("scroll", onScroll, { passive: true });
}

async function init() {
  bindUI();
  try {
    S.tags = await fetchJSON("data/tags.json");
  } catch (e) {
    toast(`tags.json 加载失败：${e.message}`);
  }
  if (!S.tags) S.tags = { total: 0, years: [], tags: {} };
  S.years = S.tags.years && S.tags.years.length ? S.tags.years : (() => {
    const out = [];
    for (let y = new Date().getFullYear(); y >= 2017; y--) out.push({ year: String(y), count: 0 });
    return out;
  })();
  const latest = S.years[0] && S.years[0].year;
  const earliest = S.years[S.years.length - 1] && S.years[S.years.length - 1].year;
  $("brandSub").textContent = S.tags.total
    ? `券商研报索引 · ${S.tags.total.toLocaleString()} 篇 · ${earliest}–${latest}`
    : "券商研报索引";
  $("footTotal").textContent = S.tags.total.toLocaleString();
  renderCloud();
  await applyHash();
  await initialLoad();
  refreshList(true);
}

init();

})();
