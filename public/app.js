(() => {
'use strict';

/* =====================================================================
   Константы и утилиты
   ===================================================================== */
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const STORE = 'lifeline.v1';

const TRACKS = [
  { id: 'work', name: 'Работа', color: '#5aa9ea' },
  { id: 'life', name: 'Быт',    color: '#a18df3' },
  { id: 'rest', name: 'Отдых',  color: '#e8bf50' },
];
const SPANS = { day: 24 * HOUR, week: 7 * DAY, month: 31 * DAY, year: 365 * DAY };
const MIN_SPAN = 3 * HOUR, MAX_SPAN = 3 * 365 * DAY;
const ROW_H = 70, BLOCK_TOP = 8, BLOCK_H = 44, SHADOW_TOP = 56;
const GREY = [58, 70, 92], GREEN = [40, 190, 120];
const POLL_MS = 60000;           // как часто спрашиваем Steam
const SESSION_GAP = 150000;      // пауза больше 2.5 мин — начинается новая сессия

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad2 = (n) => String(n).padStart(2, '0');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDay = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtMonth = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' });
const fmtDM = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const fmtMon = new Intl.DateTimeFormat('ru-RU', { month: 'short' });

const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const mondayOf = (t) => { const d = new Date(startOfDay(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

const fmtH = (ms) => (ms / HOUR).toFixed(1).replace(/\.0$/, '') + 'ч';
const fmtDur = (ms) => {
  const m = Math.round(ms / MIN), h = Math.floor(m / 60), mm = m % 60;
  if (!h) return mm + 'м';
  return mm ? `${h}ч ${mm}м` : `${h}ч`;
};
const toLocalInput = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fromLocalInput = (s) => new Date(s).getTime();

/* =====================================================================
   Состояние и хранение (localStorage)
   ===================================================================== */
function defaults() {
  return {
    tasks: [],
    sessions: [],                       // {game, start, end}
    settings: { steamId: '', keyword: 'blender', normHours: 1 },
    view: { span: SPANS.week, viewStart: null },
    recent: null,                       // игры за 2 недели из Steam
    lastSync: null,
  };
}
function load() {
  const base = defaults();
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const s = JSON.parse(raw);
      Object.assign(base, s);
      base.settings = Object.assign(defaults().settings, s.settings || {});
      base.view = Object.assign(defaults().view, s.view || {});
    }
  } catch (e) { /* повреждённые данные игнорируем */ }
  const cutoff = Date.now() - 400 * DAY;
  base.sessions = (base.sessions || []).filter((s) => s && s.end > cutoff);
  base.tasks = (base.tasks || []).filter((t) => t && t.id);
  base.tasks.forEach((t) => { t.subtasks = t.subtasks || []; t.kw = t.kw || ''; });
  return base;
}
let state = load();

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        tasks: state.tasks, sessions: state.sessions, settings: state.settings,
        view: state.view, recent: state.recent, lastSync: state.lastSync,
      }));
    } catch (e) { /* хранилище недоступно */ }
  }, 150);
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

/* =====================================================================
   Аналитика задачи: план / факт из Steam / тени / прогресс
   ===================================================================== */
const KW = () => (state.settings.keyword || 'blender').trim().toLowerCase();
const isKw = (game, kw) => String(game).toLowerCase().includes(kw);

function analyze(t, now) {
  const plan = t.end - t.start;
  let actual = 0;
  const shadows = [];
  const kw = (t.kw || '').trim().toLowerCase();
  if (kw) {
    for (const s of state.sessions) {
      if (s.end <= t.start || s.start >= t.end) continue;
      if (isKw(s.game, kw)) {
        // Сессия, которая началась в блоке и затянулась, считается целиком
        // (так «4 часа в плане» + «4.5 часа в Steam» дают +0.5ч сверх плана).
        actual += s.end - Math.max(s.start, t.start);
      } else {
        shadows.push({ game: s.game, s: Math.max(s.start, t.start), e: Math.min(s.end, t.end) });
      }
    }
  }
  const manual = t.subtasks.length
    ? t.subtasks.filter((x) => x.done).length / t.subtasks.length
    : (t.done ? 1 : 0);
  const steamFrac = kw && plan > 0 ? Math.min(1, actual / plan) : 0;
  const eff = Math.max(manual, steamFrac);
  const overBy = actual - plan;
  const over = Boolean(kw) && overBy >= 6 * MIN;

  let urgency = '';
  if (eff < 1) {
    if (now > t.end) urgency = now - t.end < 3 * DAY ? 'urgent' : 'late';
    else if (now >= t.start && (t.end - now) <= Math.min(DAY, 0.3 * plan) && eff < 0.5) urgency = 'urgent';
  }
  return { plan, actual, shadows, manual, eff, over, overBy, urgency };
}

const mixColor = (p) => `rgb(${GREY.map((c, i) => Math.round(c + (GREEN[i] - c) * p)).join(',')})`;

/* =====================================================================
   Геометрия таймлайна
   ===================================================================== */
let areaW = 900, labelW = 132;
const px = () => areaW / state.view.span;
const xOf = (t) => (t - state.view.viewStart) * px();
const timeAt = (x) => state.view.viewStart + x / px();

function snapStep() {
  const s = state.view.span;
  if (s <= 36 * HOUR) return 15 * MIN;
  if (s <= 10 * DAY) return HOUR;
  if (s <= 60 * DAY) return 6 * HOUR;
  return DAY;
}
function snapTime(t) {
  const step = snapStep();
  const off = -new Date(t).getTimezoneOffset() * MIN;
  return Math.round((t + off) / step) * step - off;
}
function defaultDuration() {
  const s = state.view.span;
  if (s <= 36 * HOUR) return 2 * HOUR;
  if (s <= 10 * DAY) return DAY;
  if (s <= 60 * DAY) return 3 * DAY;
  return 14 * DAY;
}

/* --- деления шкалы --- */
const STEPS = [15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 7 * DAY];
const pickStep = (p) => STEPS.find((s) => s * p >= 80) || null;

function alignLocal(t, step) {
  const off = -new Date(t).getTimezoneOffset() * MIN;
  return Math.floor((t + off) / step) * step - off;
}

function tickList(t0, t1, p, step) {
  const out = [];
  if (step && step < DAY) {
    for (let t = alignLocal(t0, step) - step; t <= t1 + step; t += step) {
      const d = new Date(t);
      out.push({ t, major: d.getHours() === 0 && d.getMinutes() === 0, label: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` });
    }
  } else if (step) {
    const days = step / DAY;
    const d = new Date(t0); d.setHours(0, 0, 0, 0);
    if (days === 7) d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    d.setDate(d.getDate() - days);
    while (d.getTime() <= t1 + step) {
      out.push({
        t: d.getTime(),
        major: days === 7 || d.getDay() === 1 || d.getDate() === 1,
        label: days === 1 ? String(d.getDate()) : fmtDM.format(d),
      });
      d.setDate(d.getDate() + days);
    }
  } else {
    const monthPx = 30.44 * DAY * p;
    const sm = monthPx >= 44 ? 1 : monthPx * 3 >= 44 ? 3 : 12;
    const d = new Date(t0); d.setDate(1); d.setHours(0, 0, 0, 0);
    d.setMonth(d.getMonth() - (d.getMonth() % sm) - sm);
    while (d.getTime() <= t1 + 32 * DAY) {
      out.push({ t: d.getTime(), major: d.getMonth() === 0, label: sm === 12 ? String(d.getFullYear()) : cap(fmtMon.format(d).replace('.', '')) });
      d.setMonth(d.getMonth() + sm);
    }
  }
  return out;
}

function segments(unit, t0, t1) {
  const segs = [];
  const d = new Date(t0); d.setHours(0, 0, 0, 0);
  if (unit === 'month') d.setDate(1);
  if (unit === 'year') d.setMonth(0, 1);
  let guard = 0;
  while (d.getTime() < t1 && guard++ < 400) {
    const s = d.getTime();
    const e = new Date(d);
    if (unit === 'day') e.setDate(e.getDate() + 1);
    else if (unit === 'month') e.setMonth(e.getMonth() + 1);
    else e.setFullYear(e.getFullYear() + 1);
    const label = unit === 'day' ? cap(fmtDay.format(d)) : unit === 'month' ? cap(fmtMonth.format(d)) : String(d.getFullYear());
    segs.push({ s, e: e.getTime(), label });
    d.setTime(e.getTime());
  }
  return segs;
}

/* =====================================================================
   Отрисовка таймлайна
   ===================================================================== */
let rafId = 0;
function schedule() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; renderTimeline(); });
}

function renderTimeline() {
  if (!$('#view-timeline').classList.contains('active')) return;
  const wrap = $('#tracksWrap');
  const lw = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--label-w'), 10);
  labelW = lw || 132;
  areaW = Math.max(200, wrap.clientWidth - labelW);
  if (state.view.viewStart == null) state.view.viewStart = Date.now() - state.view.span * 0.3;

  const { viewStart: t0, span } = state.view;
  const t1 = t0 + span, p = px(), now = Date.now();
  const step = pickStep(p);
  const ticks = tickList(t0, t1, p, step);

  renderRuler(t0, t1, p, step, ticks);
  renderGrid(t0, t1, p, ticks, now);
  renderTracks(t0, t1, p, now);

  $$('#zoomSeg button').forEach((b) => b.classList.toggle('active', Math.abs(SPANS[b.dataset.zoom] - span) < 1));
  $('#emptyHint').hidden = state.tasks.length > 0;
}

function renderRuler(t0, t1, p, step, ticks) {
  const ruler = $('#ruler');
  const unit = step ? (step < DAY ? 'day' : 'month') : 'year';
  let html = '';
  for (const s of segments(unit, t0, t1)) {
    const l = Math.max(0, (s.s - t0) * p), r = Math.min(areaW, (s.e - t0) * p);
    if (r - l < 1) continue;
    html += `<div class="rseg" style="left:${l}px;width:${r - l}px">${esc(s.label)}</div>`;
  }
  for (const k of ticks) {
    const x = (k.t - t0) * p;
    if (x < -50 || x > areaW + 50) continue;
    html += `<div class="rtick${k.major ? ' major' : ''}" style="left:${x}px"><span>${esc(k.label)}</span></div>`;
  }
  ruler.innerHTML = html;
}

function renderGrid(t0, t1, p, ticks, now) {
  let html = '';
  if (DAY * p >= 8) {
    const d = new Date(t0); d.setHours(0, 0, 0, 0);
    let guard = 0;
    while (d.getTime() < t1 && guard++ < 400) {
      const s = d.getTime(), wd = d.getDay();
      d.setDate(d.getDate() + 1);
      if (wd === 0 || wd === 6) html += `<div class="wk" style="left:${(s - t0) * p}px;width:${(d.getTime() - s) * p}px"></div>`;
    }
  }
  for (const k of ticks) {
    const x = (k.t - t0) * p;
    if (x < -2 || x > areaW + 2) continue;
    html += `<div class="gl${k.major ? ' major' : ''}" style="left:${x}px"></div>`;
  }
  $('#gridLayer').innerHTML = html;
  $('#nowLayer').innerHTML = now >= t0 && now <= t1
    ? `<div class="nowline" style="left:${(now - t0) * p}px"><span>сейчас</span></div>` : '';
}

function renderTracks(t0, t1, p, now) {
  const host = $('#tracks');
  host.innerHTML = '';
  for (const tr of TRACKS) {
    const list = state.tasks.filter((t) => t.track === tr.id).sort((a, b) => a.start - b.start || a.end - b.end);
    const laneEnds = [], lane = new Map();
    for (const t of list) {
      let i = laneEnds.findIndex((e) => e <= t.start);
      if (i < 0) { i = laneEnds.length; laneEnds.push(0); }
      laneEnds[i] = t.end;
      lane.set(t.id, i);
    }
    const lanes = Math.max(1, laneEnds.length);

    const row = document.createElement('div');
    row.className = 'track';
    const label = document.createElement('div');
    label.className = 'track-label';
    label.innerHTML = `<i class="swatch" style="background:${tr.color}"></i><span class="tn">${tr.name}</span>` +
      `<button class="mini" type="button" data-add="${tr.id}" title="Добавить задачу: ${tr.name}" aria-label="Добавить задачу: ${tr.name}">+</button>`;
    const area = document.createElement('div');
    area.className = 'track-area';
    area.dataset.track = tr.id;
    area.style.height = (lanes * ROW_H + 6) + 'px';

    for (const t of list) {
      if (t.end < t0 || t.start > t1) continue;
      taskNodes(t, tr, lane.get(t.id), p, t0, now).forEach((n) => area.append(n));
    }
    row.append(label, area);
    host.append(row);
  }
}

function taskNodes(t, tr, laneIdx, p, t0, now) {
  const a = analyze(t, now);
  const L = (t.start - t0) * p, R = (t.end - t0) * p;
  const clipL = L < -2, clipR = R > areaW + 2;
  const left = Math.max(L, -2), width = Math.max(6, Math.min(R, areaW + 2) - left);

  const e = document.createElement('div');
  e.className = 'task' + (a.urgency ? ' ' + a.urgency : '') + (a.over ? ' over' : '') +
    (clipL ? ' clipL' : '') + (clipR ? ' clipR' : '');
  e.dataset.id = t.id;
  e.style.cssText = `left:${left}px;width:${width}px;top:${laneIdx * ROW_H + BLOCK_TOP}px;height:${BLOCK_H}px;` +
    `--tc:${tr.color};background-color:${mixColor(a.eff)}`;

  const meta = [];
  if (t.subtasks.length) meta.push(`${t.subtasks.filter((x) => x.done).length}/${t.subtasks.length}`);
  if (t.kw) { meta.push(`план ${fmtH(a.plan)}`); meta.push(`факт ${fmtH(a.actual)}`); }
  else meta.push(fmtDur(a.plan));

  e.innerHTML = `<i class="h h-l"></i><div class="t-body"><div class="t-title">${esc(t.title || 'Без названия')}</div>` +
    (width > 95 ? `<div class="t-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>` : '') +
    `</div><i class="h h-r"></i><b class="t-bar" style="width:${Math.round(a.eff * 100)}%"></b>` +
    (a.over && width > 70 ? `<span class="badge">+${fmtH(a.overBy)}</span>` : '');

  let tip = `${t.title || 'Без названия'}\n${new Date(t.start).toLocaleString('ru-RU')} — ${new Date(t.end).toLocaleString('ru-RU')}`;
  if (t.kw) tip += `\nSteam (${t.kw}): ${fmtDur(a.actual)} из ${fmtDur(a.plan)}`;
  if (a.over) tip += `\nСверхвыполнено на ${fmtDur(a.overBy)}`;
  if (a.shadows.length) tip += `\nВ это время запущено: ${[...new Set(a.shadows.map((s) => s.game))].join(', ')}`;
  e.title = tip;

  const nodes = [e];
  for (const s of a.shadows) {
    const sl = Math.max((s.s - t0) * p, -2), sr = Math.min((s.e - t0) * p, areaW + 2);
    if (sr - sl < 1.5) continue;
    const sh = document.createElement('div');
    sh.className = 'shadow';
    sh.style.cssText = `left:${sl}px;width:${sr - sl}px;top:${laneIdx * ROW_H + SHADOW_TOP}px`;
    sh.title = `${s.game}: ${fmtDur(s.e - s.s)}`;
    if (sr - sl > 64) sh.textContent = s.game;
    nodes.push(sh);
  }
  return nodes;
}

/* =====================================================================
   Взаимодействие: панорама, зум, перетаскивание, создание
   ===================================================================== */
const wrapEl = $('#tracksWrap');
const timelineEl = $('#timeline');
let drag = null;

const taskById = (id) => state.tasks.find((t) => t.id === id);

wrapEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const taskEl = e.target.closest('.task');
  const area = e.target.closest('.track-area');
  if (!taskEl && !area) return;
  const base = { x: e.clientX, y: e.clientY, moved: false };
  if (taskEl) {
    const t = taskById(taskEl.dataset.id);
    if (!t) return;
    const mode = e.target.classList.contains('h-l') ? 'resize-l' : e.target.classList.contains('h-r') ? 'resize-r' : 'move';
    drag = { ...base, type: mode, task: t, orig: { start: t.start, end: t.end } };
  } else {
    drag = { ...base, type: 'pan', viewStart0: state.view.viewStart };
  }
  try { wrapEl.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
});

wrapEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  if (!drag.moved && Math.abs(dx) < 4 && Math.abs(e.clientY - drag.y) < 4) return;
  drag.moved = true;
  timelineEl.classList.add('panning');
  const dt = dx / px();
  const step = snapStep();
  const t = drag.task;
  if (drag.type === 'pan') {
    state.view.viewStart = drag.viewStart0 - dt;
  } else if (drag.type === 'move') {
    const dur = drag.orig.end - drag.orig.start;
    t.start = snapTime(drag.orig.start + dt);
    t.end = t.start + dur;
    for (const a of $$('.track-area')) {
      const r = a.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) { t.track = a.dataset.track; break; }
    }
  } else if (drag.type === 'resize-l') {
    t.start = Math.min(snapTime(drag.orig.start + dt), t.end - step);
  } else if (drag.type === 'resize-r') {
    t.end = Math.max(snapTime(drag.orig.end + dt), t.start + step);
  }
  schedule();
});

function endDrag(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  timelineEl.classList.remove('panning');
  try { wrapEl.releasePointerCapture(e.pointerId); } catch (err) { /* ok */ }
  if (d.type !== 'pan' && !d.moved) openEditor(d.task, false);
  save();
  schedule();
}
wrapEl.addEventListener('pointerup', endDrag);
wrapEl.addEventListener('pointercancel', endDrag);

wrapEl.addEventListener('dblclick', (e) => {
  if (e.target.closest('.task')) return;
  const area = e.target.closest('.track-area');
  if (!area) return;
  const x = e.clientX - area.getBoundingClientRect().left;
  createTask(area.dataset.track, snapTime(timeAt(x)));
});

wrapEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  createTask(b.dataset.add, snapTime(state.view.viewStart + state.view.span * 0.4));
});

wrapEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const v = state.view;
  if (e.ctrlKey || e.metaKey) {
    const rect = wrapEl.getBoundingClientRect();
    const cx = clamp(e.clientX - rect.left - labelW, 0, areaW);
    const anchor = timeAt(cx);
    v.span = clamp(v.span * Math.exp(e.deltaY * 0.0015), MIN_SPAN, MAX_SPAN);
    v.viewStart = anchor - (cx / areaW) * v.span;
  } else {
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    v.viewStart += (delta / areaW) * v.span;
  }
  save();
  schedule();
}, { passive: false });

$$('#zoomSeg button').forEach((b) => b.addEventListener('click', () => {
  const v = state.view, center = v.viewStart + v.span / 2;
  v.span = SPANS[b.dataset.zoom];
  v.viewStart = center - v.span / 2;
  save(); schedule();
}));
$('#navPrev').addEventListener('click', () => { state.view.viewStart -= state.view.span * 0.8; save(); schedule(); });
$('#navNext').addEventListener('click', () => { state.view.viewStart += state.view.span * 0.8; save(); schedule(); });
$('#navToday').addEventListener('click', () => { state.view.viewStart = Date.now() - state.view.span * 0.3; save(); schedule(); });
$('#btnAdd').addEventListener('click', () => createTask('work', snapTime(state.view.viewStart + state.view.span * 0.4)));
window.addEventListener('resize', schedule);

function createTask(trackId, start) {
  const t = { id: uid(), title: 'Новая задача', track: trackId, start, end: start + defaultDuration(), subtasks: [], done: false, kw: '' };
  openEditor(t, true);
}

/* =====================================================================
   Редактор задачи
   ===================================================================== */
const ed = {
  dlg: $('#editor'), title: $('#edTitle'), track: $('#edTrack'), kw: $('#edKw'),
  start: $('#edStart'), end: $('#edEnd'), done: $('#edDone'), subNew: $('#edSubNew'),
};
let editing = null;

TRACKS.forEach((t) => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; ed.track.append(o); });

function openEditor(task, isNew) {
  editing = { task, isNew, snap: JSON.stringify(task), saved: false, deleted: false };
  if (isNew) state.tasks.push(task);
  $('#edHead').textContent = isNew ? 'Новая задача' : 'Задача';
  ed.title.value = task.title;
  ed.track.value = task.track;
  ed.kw.value = task.kw || '';
  ed.start.value = toLocalInput(task.start);
  ed.end.value = toLocalInput(task.end);
  ed.done.checked = Boolean(task.done);
  ed.subNew.value = '';
  renderSubs();
  refreshInfo();
  ed.dlg.showModal();
  if (isNew) { ed.title.focus(); ed.title.select(); }
  schedule();
}

function changed() { refreshInfo(); updateProgress(); save(); schedule(); }

function updateProgress() {
  const t = editing && editing.task;
  if (!t) return;
  const d = t.subtasks.filter((s) => s.done).length;
  $('#edProg').textContent = t.subtasks.length ? `${d}/${t.subtasks.length}` : '';
  $('#edDoneRow').hidden = t.subtasks.length > 0;
}

function renderSubs() {
  const ul = $('#edSubs'), t = editing.task;
  ul.innerHTML = '';
  t.subtasks.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = s.done ? 'done' : '';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = s.done;
    cb.setAttribute('aria-label', 'Подзадача выполнена');
    cb.addEventListener('change', () => { s.done = cb.checked; li.classList.toggle('done', s.done); changed(); });
    const tx = document.createElement('input');
    tx.type = 'text'; tx.value = s.text; tx.maxLength = 120;
    tx.addEventListener('input', () => { s.text = tx.value; save(); });
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Удалить подзадачу');
    x.addEventListener('click', () => { t.subtasks.splice(i, 1); renderSubs(); changed(); });
    li.append(cb, tx, x);
    ul.append(li);
  });
  updateProgress();
}

function refreshInfo() {
  const box = $('#edSteamInfo'), t = editing && editing.task;
  if (!t || !t.kw) { box.hidden = true; return; }
  const a = analyze(t, Date.now());
  let html = `План <b>${fmtDur(a.plan)}</b>, в Steam («${esc(t.kw)}») <b>${fmtDur(a.actual)}</b>.`;
  if (a.over) html += ` <span class="good">Сверхвыполнено на ${fmtDur(a.overBy)}.</span>`;
  if (a.shadows.length) {
    const by = {};
    a.shadows.forEach((s) => { by[s.game] = (by[s.game] || 0) + (s.e - s.s); });
    html += ' Параллельно было запущено: ' + Object.entries(by).map(([g, ms]) => `${esc(g)} <b>${fmtDur(ms)}</b>`).join(', ') + '.';
  }
  box.innerHTML = html;
  box.hidden = false;
}

ed.title.addEventListener('input', () => { editing.task.title = ed.title.value; save(); schedule(); });
ed.track.addEventListener('change', () => { editing.task.track = ed.track.value; changed(); });
ed.kw.addEventListener('input', () => { editing.task.kw = ed.kw.value.trim(); changed(); });
ed.done.addEventListener('change', () => { editing.task.done = ed.done.checked; changed(); });
ed.start.addEventListener('input', () => {
  const v = fromLocalInput(ed.start.value), t = editing.task;
  if (Number.isNaN(v)) return;
  const dur = Math.max(15 * MIN, t.end - t.start);
  t.start = v; t.end = v + dur;
  ed.end.value = toLocalInput(t.end);
  changed();
});
ed.end.addEventListener('input', () => {
  const v = fromLocalInput(ed.end.value), t = editing.task;
  if (Number.isNaN(v) || v <= t.start) return;
  t.end = v; changed();
});
ed.subNew.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const text = ed.subNew.value.trim();
  if (!text) return;
  editing.task.subtasks.push({ id: uid(), text, done: false });
  ed.subNew.value = '';
  renderSubs(); changed();
});

$('#edSave').addEventListener('click', () => {
  const t = editing.task;
  t.title = (ed.title.value || '').trim() || 'Без названия';
  if (t.end <= t.start) t.end = t.start + 30 * MIN;
  editing.saved = true;
  ed.dlg.close();
});
$('#edCancel').addEventListener('click', () => ed.dlg.close());
$('#edClose').addEventListener('click', () => ed.dlg.close());
$('#edDelete').addEventListener('click', () => {
  if (!editing.isNew && !confirm('Удалить задачу?')) return;
  state.tasks = state.tasks.filter((t) => t.id !== editing.task.id);
  editing.deleted = true;
  ed.dlg.close();
});
ed.dlg.addEventListener('click', (e) => { if (e.target === ed.dlg) ed.dlg.close(); });
ed.dlg.addEventListener('close', () => {
  if (!editing) return;
  const e = editing;
  editing = null;
  if (!e.deleted && !e.saved) {
    if (e.isNew) state.tasks = state.tasks.filter((t) => t.id !== e.task.id);
    else {
      const i = state.tasks.findIndex((t) => t.id === e.task.id);
      if (i >= 0) state.tasks[i] = JSON.parse(e.snap);
    }
  }
  save();
  renderAll();
});

/* =====================================================================
   Steam: статус, опрос, учёт сессий
   ===================================================================== */
const steam = { configured: null, hasDefaultId: false, persona: null, game: null, visible: true, error: null };
let pollTimer = 0;

async function api(path) {
  const r = await fetch(path);
  let j = {};
  try { j = await r.json(); } catch (e) { /* пусто */ }
  if (!r.ok) { const err = new Error(j.error || 'HTTP ' + r.status); err.code = j.error || 'http_' + r.status; throw err; }
  return j;
}
const steamQuery = () => (state.settings.steamId ? `?steamid=${encodeURIComponent(state.settings.steamId.trim())}` : '');
const needsId = () => steam.configured && !state.settings.steamId.trim() && !steam.hasDefaultId;

const ERRORS = {
  not_configured: 'На сервере не задан STEAM_API_KEY.',
  no_steam_id: 'Укажи свой Steam ID в настройках.',
  player_not_found: 'Профиль Steam не найден. Проверь ID или ссылку.',
  bad_key: 'Steam отклонил ключ API. Проверь STEAM_API_KEY.',
  steam_error: 'Steam сейчас не отвечает. Попробуй позже.',
};
const explain = (e) => ERRORS[e && e.code] || 'Не удалось связаться с сервером.';

function updatePill() {
  const pill = $('#steamPill'), txt = $('#steamText');
  let kind = 'off', text = 'Steam: проверяю…';
  if (steam.configured === false) { kind = 'off'; text = 'Steam: демо-режим'; }
  else if (steam.configured) {
    if (needsId()) { kind = 'warn'; text = 'Steam: укажи свой ID'; }
    else if (steam.error) { kind = 'warn'; text = 'Steam: ' + (ERRORS[steam.error] ? ERRORS[steam.error].replace(/\.$/, '') : 'ошибка'); }
    else if (steam.game) { kind = 'play'; text = `Сейчас запущено: ${steam.game}`; }
    else if (steam.persona) { kind = 'ok'; text = `Steam: ${steam.persona}`; }
    else { kind = 'off'; text = 'Steam: подключаюсь…'; }
  }
  pill.dataset.kind = kind;
  txt.textContent = text;
  pill.title = steam.configured === false
    ? 'На сервере нет STEAM_API_KEY. Данные можно смотреть на примере.'
    : (steam.visible === false ? 'Профиль Steam скрыт: игровая информация недоступна.' : 'Нажми, чтобы синхронизировать');
}

function logTick(game, now) {
  for (let i = state.sessions.length - 1; i >= 0 && i > state.sessions.length - 12; i--) {
    const s = state.sessions[i];
    if (s.game === game && now - s.end <= SESSION_GAP) { s.end = now; return; }
  }
  state.sessions.push({ game, start: now, end: now });
}

async function pollNow(manual) {
  if (!steam.configured) {
    if (manual) toast('Steam API пока не подключён: добавь STEAM_API_KEY в переменные окружения на Render. Пока можно смотреть пример данных.');
    return false;
  }
  if (needsId()) { if (manual) toast(ERRORS.no_steam_id); updatePill(); return false; }
  try {
    const j = await api('/api/steam/now' + steamQuery());
    steam.persona = j.persona;
    steam.visible = j.visible;
    steam.error = null;
    const game = j.game || (j.gameId ? `Игра #${j.gameId}` : null);
    steam.game = game;
    if (game) { logTick(game, Date.now()); save(); }
    updatePill();
    renderAll();
    return true;
  } catch (e) {
    steam.error = e.code || 'steam_error';
    steam.game = null;
    updatePill();
    if (manual) toast(explain(e));
    return false;
  }
}

async function syncSteam() {
  const ok = await pollNow(true);
  if (!ok) return;
  try {
    const r = await api('/api/steam/recent' + steamQuery());
    state.recent = r.games.map((g) => ({ name: g.name, m2: g.playtime_2weeks, mt: g.playtime_forever }));
    state.lastSync = Date.now();
    save();
    renderAll();
    if (!state.recent.length) toast('Steam не вернул игр за 2 недели. Проверь, что в профиле открыта игровая информация.');
    else toast('Steam синхронизирован.');
  } catch (e) { toast(explain(e)); }
}

async function steamInit() {
  try {
    const c = await api('/api/steam/config');
    steam.configured = c.configured;
    steam.hasDefaultId = c.hasDefaultId;
  } catch (e) { steam.configured = false; }
  updatePill();
  if (steam.configured) {
    pollNow(false);
    pollTimer = setInterval(() => pollNow(false), POLL_MS);
  }
}

$('#steamPill').addEventListener('click', () => {
  if (steam.configured === false || needsId()) openSettings();
  else syncSteam();
});
$('#btnSync').addEventListener('click', syncSteam);

/* =====================================================================
   Статистика
   ===================================================================== */
let statsWeek = 0; // смещение недели, 0 — текущая

const nextDay = (d0) => addDays(d0, 1);
function dayChunks(s, cb) {
  let a = s.start, guard = 0;
  while (a < s.end && guard++ < 400) {
    const d0 = startOfDay(a), b = Math.min(s.end, nextDay(d0));
    cb(d0, a, b);
    a = b;
  }
}
function hourChunks(s, cb) {
  let a = s.start, guard = 0;
  while (a < s.end && guard++ < 5000) {
    const d = new Date(a); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1);
    const b = Math.min(s.end, d.getTime());
    cb(new Date(a).getHours(), a, b);
    a = b;
  }
}

function donutSvg(segs) {
  const total = segs.reduce((a, s) => a + s.v, 0), R = 70, C = 2 * Math.PI * R;
  let off = 0, arcs = '';
  if (total > 0) {
    for (const s of segs) {
      if (s.v <= 0) continue;
      const len = (s.v / total) * C;
      arcs += `<circle cx="95" cy="95" r="${R}" fill="none" stroke="${s.color}" stroke-width="22" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 95 95)"/>`;
      off += len;
    }
  }
  return `<svg viewBox="0 0 190 190" role="img" aria-label="Баланс недели"><circle cx="95" cy="95" r="${R}" fill="none" stroke="#0f1620" stroke-width="22"/>${arcs}</svg>`;
}

function renderBalance() {
  const kw = KW(), kwLabel = cap(state.settings.keyword.trim() || 'Blender');
  const w0 = addDays(mondayOf(Date.now()), statsWeek * 7), w1 = addDays(w0, 7), now = Date.now();
  $('#swLabel').textContent = `${fmtDM.format(w0)} – ${fmtDM.format(w1 - 1)}`;
  $('#swNext').disabled = statsWeek >= 0;

  let planned = 0, real = 0, other = 0, shadowIn = 0, overTotal = 0, overCount = 0;
  const main = state.tasks.filter((t) => t.kw && t.kw.toLowerCase().includes(kw));
  for (const t of main) {
    planned += overlap(t.start, t.end, w0, w1);
    if (t.start < w1 && t.end > w0) {
      const a = analyze(t, now);
      a.shadows.forEach((s) => { shadowIn += overlap(s.s, s.e, w0, w1); });
      if (a.over) { overTotal += a.overBy; overCount++; }
    }
  }
  for (const s of state.sessions) {
    const o = overlap(s.start, s.end, w0, w1);
    if (!o) continue;
    if (isKw(s.game, kw)) real += o; else other += o;
  }
  const gap = Math.max(0, planned - real);

  $('#donut').innerHTML = donutSvg([
    { v: real, color: '#3dd68c' }, { v: other, color: '#ff5260' }, { v: gap, color: '#4a5f82' },
  ]) + `<div class="mid">${planned > 0
    ? `<b>${Math.round((real / planned) * 100)}%</b><small>от плана</small>`
    : `<b>${fmtH(real)}</b><small>в ${esc(kwLabel)}</small>`}</div>`;

  $('#balLegend').innerHTML = [
    ['transparent', `Запланировано на ${esc(kwLabel)}`, '', fmtH(planned), 'border:2px solid #5a6e8f'],
    ['#3dd68c', `Реально в ${esc(kwLabel)}`, '', fmtH(real), ''],
    ['#ff5260', 'Потеряно на другие игры', shadowIn > 0 ? `из них ${fmtH(shadowIn)} прямо в блоках ${esc(kwLabel)}` : '', fmtH(other), ''],
    ['#4a5f82', 'Не добрано до плана', '', fmtH(gap), ''],
  ].map(([c, name, sub, v, extra]) =>
    `<li><i style="background:${c};${extra}"></i><div><strong>${name}</strong>${sub ? `<em>${sub}</em>` : ''}</div><span class="v">${v}</span></li>`).join('');

  let note;
  if (!planned && !real && !other) note = 'За эту неделю данных нет. Поставь на таймлайн блок со Steam-слежением и оставь LifeLine открытым, пока работаешь.';
  else if (overCount) note = `Сверх плана ты отработал <b>+${fmtH(overTotal)}</b> в ${overCount} ${overCount === 1 ? 'блоке' : 'блоках'}. Эти часы идут в зачёт продуктивности.`;
  else if (other > real && other > 0) note = `Других игр было больше, чем ${esc(kwLabel)}: <b>${fmtH(other)}</b> против <b>${fmtH(real)}</b>.`;
  else note = `Из запланированных <b>${fmtH(planned)}</b> выполнено <b>${fmtH(Math.min(real, planned))}</b>.`;
  $('#balNote').innerHTML = note;
}

function dailyMap() {
  const kw = KW(), m = new Map();
  for (const s of state.sessions) {
    if (!isKw(s.game, kw)) continue;
    dayChunks(s, (d0, a, b) => m.set(d0, (m.get(d0) || 0) + b - a));
  }
  return m;
}

function renderStreak() {
  const m = dailyMap(), norm = Math.max(0.1, Number(state.settings.normHours) || 1) * HOUR;
  const ok = (d) => (m.get(d) || 0) >= norm;
  const today = startOfDay(Date.now());
  let cur = 0, d = today;
  if (!ok(d)) d = addDays(d, -1);
  while (ok(d) && cur < 4000) { cur++; d = addDays(d, -1); }

  let best = 0, run = 0;
  const keys = [...m.keys()].sort((a, b) => a - b);
  if (keys.length) {
    for (let x = keys[0], g = 0; x <= today && g < 800; x = addDays(x, 1), g++) {
      if (ok(x)) { run++; best = Math.max(best, run); } else run = 0;
    }
  }
  $('#stCur').textContent = cur;
  $('#stCurLbl').textContent = cur % 10 === 1 && cur % 100 !== 11 ? 'день подряд' : 'дней подряд';
  $('#stSub').innerHTML = `Рекорд <b>${best}</b>, норма <b>${fmtH(norm)}</b> в день.`;

  const mon = mondayOf(Date.now()), start = addDays(mon, -28);
  let html = '';
  for (let i = 0; i < 35; i++) {
    const day = addDays(start, i), ms = m.get(day) || 0, r = ms / norm;
    let cls = 'cell';
    if (day > today) cls += ' fut';
    else if (r >= 2) cls += ' l4';
    else if (r >= 1) cls += ' l3';
    else if (r >= 0.5) cls += ' l2';
    else if (r > 0) cls += ' l1';
    if (day === today) cls += ' today';
    html += `<div class="${cls}" title="${esc(fmtDM.format(day))}: ${fmtH(ms)}"></div>`;
  }
  $('#heat').innerHTML = html;

  const todayMs = m.get(today) || 0;
  $('#stNote').textContent = ok(today)
    ? 'Норма на сегодня выполнена. Серия продолжается.'
    : (cur > 0 ? `Чтобы не потерять серию, сегодня осталось отработать ещё ${fmtDur(norm - todayMs)}.` : 'Выполни дневную норму, и серия начнётся.');
}

function renderFocus() {
  const kw = KW(), now = Date.now(), from = now - 90 * DAY;
  const dow = Array(7).fill(0), hrs = Array(24).fill(0);
  let longest = 0, total = 0;
  for (const s of state.sessions) {
    if (!isKw(s.game, kw) || s.end < from) continue;
    longest = Math.max(longest, s.end - s.start);
    total += s.end - s.start;
    dayChunks(s, (d0, a, b) => { dow[(new Date(d0).getDay() + 6) % 7] += b - a; });
    hourChunks(s, (h, a, b) => { hrs[h] += b - a; });
  }
  const names = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const maxD = Math.max(...dow), maxH = Math.max(...hrs);
  const bar = (v, max, lbl, sub) =>
    `<div class="bar${v > 0 && v === max ? ' on' : ''}" title="${esc(lbl)}: ${fmtH(v)}"><div class="col"><i style="height:${max ? Math.max(2, (v / max) * 100) : 2}%"></i></div><div class="lbl">${lbl}${sub ? `<b>${sub}</b>` : ''}</div></div>`;
  $('#barsDow').innerHTML = dow.map((v, i) => bar(v, maxD, names[i], v ? (v / HOUR).toFixed(1) : '')).join('');
  $('#barsHour').innerHTML = hrs.map((v, h) => bar(v, maxH, h % 3 === 0 ? pad2(h) : '', '')).join('');

  if (!total) { $('#focusNote').textContent = 'Пока нет сессий. Как только Steam увидит запущенный Blender, здесь появится картина дня.'; return; }
  const bestD = dow.indexOf(maxD), bestH = hrs.indexOf(maxH);
  const dayName = ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'][bestD];
  $('#focusNote').innerHTML = `Чаще всего ты работаешь в <b>${dayName}</b>, пик около <b>${pad2(bestH)}:00</b>. ` +
    `Всего за период <b>${fmtH(total)}</b>, самая длинная сессия <b>${fmtDur(longest)}</b>.`;
}

function renderSteamList() {
  const box = $('#steamList');
  $('#steamSyncAt').textContent = state.lastSync ? 'обновлено ' + new Date(state.lastSync).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  if (!state.recent || !state.recent.length) {
    box.innerHTML = `<p class="empty-s">${steam.configured === false
      ? 'Steam не подключён: на сервере нет ключа API. Когда добавишь STEAM_API_KEY, здесь появятся твои игры.'
      : 'Нажми «Синхронизировать Steam», чтобы увидеть, сколько часов Steam насчитал за две недели.'}</p>`;
    return;
  }
  const from = Date.now() - 14 * DAY;
  const rows = state.recent.slice().sort((a, b) => b.m2 - a.m2).slice(0, 6);
  const max = Math.max(...rows.map((r) => r.m2), 1);
  let missing = 0;
  box.innerHTML = rows.map((g) => {
    const steamMs = g.m2 * MIN;
    let logged = 0;
    state.sessions.forEach((s) => { if (s.game === g.name) logged += overlap(s.start, s.end, from, Date.now()); });
    missing += Math.max(0, steamMs - logged);
    return `<div class="srow"><div class="top"><span class="name">${esc(g.name)}</span><span class="nums">Steam ${fmtH(steamMs)} / записано ${fmtH(logged)}</span></div>` +
      `<div class="track-bar"><i style="width:${(g.m2 / max) * 100}%"></i><u style="width:${(Math.min(logged, steamMs) / MIN / max) * 100}%"></u></div></div>`;
  }).join('') +
    (missing > 20 * MIN ? `<p class="note">Steam насчитал на <b>${fmtH(missing)}</b> больше, чем успел записать LifeLine. Сессии пишутся, пока вкладка открыта, поэтому держи её открытой, пока работаешь.</p>` : '');
}

function renderStats() {
  renderBalance(); renderStreak(); renderFocus(); renderSteamList();
}
$('#swPrev').addEventListener('click', () => { statsWeek--; renderBalance(); });
$('#swNext').addEventListener('click', () => { if (statsWeek < 0) { statsWeek++; renderBalance(); } });

/* =====================================================================
   Вкладки, настройки, данные
   ===================================================================== */
function renderAll() {
  schedule();
  if ($('#view-stats').classList.contains('active')) renderStats();
}

$$('.tab').forEach((b) => b.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
  if (b.dataset.view === 'stats') renderStats(); else schedule();
}));

const setDlg = $('#settings');
function openSettings() {
  $('#sSteamId').value = state.settings.steamId;
  $('#sKeyword').value = state.settings.keyword;
  $('#sNorm').value = state.settings.normHours;
  let hint;
  if (steam.configured === false) hint = 'Ключ Steam API на сервере не задан. Добавь STEAM_API_KEY в Render (Environment), и учёт часов заработает. Пока доступен пример данных.';
  else if (steam.configured) hint = steam.hasDefaultId ? 'Ключ API найден. Если поле пустое, используется STEAM_ID с сервера.' : 'Ключ API найден. Осталось указать, чей профиль смотреть.';
  else hint = 'Проверяю подключение к серверу…';
  $('#sSteamHint').textContent = hint;
  setDlg.showModal();
}
function closeSettings() {
  state.settings.steamId = $('#sSteamId').value.trim();
  state.settings.keyword = $('#sKeyword').value.trim() || 'blender';
  state.settings.normHours = clamp(Number($('#sNorm').value) || 1, 0.1, 24);
  save();
  updatePill();
  if (steam.configured && !needsId()) pollNow(false);
  renderAll();
}
$('#btnSettings').addEventListener('click', openSettings);
$('#sSave').addEventListener('click', () => setDlg.close());
$('#stClose').addEventListener('click', () => setDlg.close());
setDlg.addEventListener('close', closeSettings);
setDlg.addEventListener('click', (e) => { if (e.target === setDlg) setDlg.close(); });

$('#sExport').addEventListener('click', () => {
  const data = { version: 1, tasks: state.tasks, sessions: state.sessions, settings: state.settings };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = 'lifeline-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#sImport').addEventListener('click', () => $('#sFile').click());
$('#sFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.tasks) || !Array.isArray(d.sessions)) throw new Error('format');
    state.tasks = d.tasks.map((t) => ({ subtasks: [], kw: '', ...t }));
    state.sessions = d.sessions;
    if (d.settings) state.settings = Object.assign(defaults().settings, d.settings);
    // поля настроек перечитываются при закрытии окна, поэтому обновляем и их
    $('#sSteamId').value = state.settings.steamId;
    $('#sKeyword').value = state.settings.keyword;
    $('#sNorm').value = state.settings.normHours;
    save(); setDlg.close(); renderAll(); toast('Данные загружены.');
  } catch (err) { toast('Не получилось прочитать файл: нужен JSON, который скачан из LifeLine.'); }
  e.target.value = '';
});
$('#sClear').addEventListener('click', () => {
  if (!confirm('Стереть все задачи и записанные сессии?')) return;
  state.tasks = []; state.sessions = []; state.recent = null; state.lastSync = null;
  save(); setDlg.close(); renderAll(); toast('Всё стёрто.');
});
$('#sDemo').addEventListener('click', () => { seedDemo(); setDlg.close(); });
$('#btnDemo').addEventListener('click', seedDemo);

/* =====================================================================
   Пример данных
   ===================================================================== */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedDemo() {
  const now = Date.now(), today = startOfDay(now), rnd = mulberry32(42);
  const at = (day, h, m = 0) => { const d = new Date(today); d.setDate(d.getDate() + day); d.setHours(h, m, 0, 0); return d.getTime(); };
  const sinceMon = (new Date().getDay() + 6) % 7;
  const mk = (title, track, s, e, kw, subs, done) => ({
    id: uid(), title, track, start: s, end: e, kw: kw || '', done: Boolean(done),
    subtasks: (subs || []).map(([text, d]) => ({ id: uid(), text, done: d })),
  });
  const lastSat = -sinceMon - 2;

  state.tasks = [
    mk('Проект по Blender: персонаж', 'work', at(-sinceMon, 10), at(-sinceMon + 4, 19), 'blender',
      [['Блокинг', true], ['Ретопология', true], ['UV-развёртка', false], ['Текстуры', false], ['Рендер', false]]),
    mk('Интерьер в Blender', 'work', at(lastSat, 14), at(lastSat, 18), 'blender', [], false),
    mk('Моделинг стула', 'work', at(-1, 19), at(-1, 22), 'blender', [['Базовая форма', true], ['Детали', true]]),
    mk('Сдать курсовую', 'work', at(-3, 9), new Date(now + 3 * HOUR).getTime(), '', [['Введение', true], ['Глава 1', false], ['Глава 2', false], ['Выводы', false], ['Оформление', false]]),
    mk('Уборка и продукты', 'life', at(0, 17), at(0, 19), '', [['Пылесос', false], ['Магазин', false]]),
    mk('Спортзал', 'life', at(-sinceMon + 1, 18), at(-sinceMon + 1, 19, 30), '', [], true),
    mk('Звонок родителям', 'life', at(-sinceMon + 3, 20), at(-sinceMon + 3, 21), '', [], false),
    mk('Выходные с друзьями', 'rest', at(-sinceMon + 5, 12), at(-sinceMon + 6, 22), '', [], false),
    mk('Кино', 'rest', at(-sinceMon + 2, 21), at(-sinceMon + 2, 23, 30), '', [], false),
  ];

  state.sessions = [];
  const addS = (game, start, durMin) => {
    const end = Math.min(start + durMin * MIN, now);
    if (end > start) state.sessions.push({ game, start, end });
  };
  const scripted = new Set([lastSat, -1]);
  const others = ['Dota 2', 'Cyberpunk 2077', 'Counter-Strike 2'];
  for (let d = -27; d <= 0; d++) {
    if (scripted.has(d)) continue;
    if (rnd() < 0.62) addS('Blender', at(d, 19 + Math.floor(rnd() * 3), Math.floor(rnd() * 50)), 50 + Math.floor(rnd() * 150));
    if (rnd() < 0.3) addS('Blender', at(d, 10 + Math.floor(rnd() * 2), 0), 40 + Math.floor(rnd() * 80));
    if (rnd() < 0.4) addS(others[Math.floor(rnd() * 3)], at(d, 13 + Math.floor(rnd() * 3), 0), 40 + Math.floor(rnd() * 120));
  }
  // Суббота: в плане 4 часа, в Blender просидел 4.5 → «Сверхвыполнено»
  addS('Blender', at(lastSat, 14, 2), 270);
  // Вчера: Blender прерывается Dota 2 → «теневой блок»
  addS('Blender', at(-1, 19, 5), 65);
  addS('Dota 2', at(-1, 20, 10), 70);
  addS('Blender', at(-1, 21, 25), 75);
  state.sessions.sort((a, b) => a.start - b.start);

  // Показываем окно от прошлой субботы до завтрашнего дня: в него попадают и «сверхвыполнено», и «тени»
  state.view.span = 3 - lastSat <= 7 ? SPANS.week : SPANS.month;
  state.view.viewStart = at(lastSat, 0);
  save();
  renderAll();
  toast('Загружен пример: смотри золотой блок в субботу и штрихованные «тени» вчера.');
}

/* =====================================================================
   Запуск
   ===================================================================== */
renderAll();
steamInit();
setInterval(() => { if (!document.hidden) schedule(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) renderAll(); });
})();
