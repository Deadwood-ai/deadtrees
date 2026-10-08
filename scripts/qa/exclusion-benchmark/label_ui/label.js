'use strict';
const LAYERS = ['deadwood', 'forest_cover'];
const VERDICTS = ['keep', 'exclude', 'unsure'];
const AREAS = { lt5: '<5%', '5to20': '5–20%', '20to50': '20–50%', gt50: '>50%' };
const $ = (s) => document.querySelector(s);
const state = { datasets: [], labels: {}, tags: {}, index: 0, view: 0, zoom: { s: 1, x: 0, y: 0 }, saving: Promise.resolve() };

function label(id) {
  return state.labels[id] || { dataset_id: id, revision: 0, note: '', imagery_tags: [],
    layers: { deadwood: { verdict: null, area: null, tags: [] }, forest_cover: { verdict: null, area: null, tags: [] } } };
}
const finished = (id) => LAYERS.every((l) => label(id).layers[l].verdict);
const current = () => state.datasets[state.index];

function visible() {
  const f = $('#filter').value;
  return state.datasets.filter((d) => f === 'all' || (f === 'done') === finished(d.dataset_id));
}

function move(step) {
  const list = visible();
  if (!list.length) return;
  const at = list.indexOf(current());
  const next = list[(at + step + list.length) % list.length];
  state.index = state.datasets.indexOf(next);
  state.view = 0;
  render();
}

function src(d, view, suffix) { return `/files/datasets/${d.dataset_id}/${view.name}-${suffix}`; }

function renderViewer() {
  const d = current();
  const view = d.views[state.view];
  const box = $('#layers');
  box.replaceChildren();
  const add = (url, cls) => { const img = new Image(); img.src = url; img.className = cls; img.width = view.size[0]; img.height = view.size[1]; box.append(img); return img; };
  add(src(d, view, 'raw.jpg'), 'raw');
  const mode = $('#outline').checked ? 'outline' : 'fill';
  for (const layer of LAYERS) {
    const img = add(src(d, view, `${layer}-${mode}.png`), `overlay ${layer}`);
    img.hidden = !$(`#show-${layer}`).checked;
    img.style.opacity = mode === 'fill' ? $('#opacity').value / 100 : 1;
  }
  const pf = view.predicted_fraction;
  $('#view-info').textContent = `${view.name} · ${(view.mpp * 100).toFixed(1)} cm/px · predicted deadwood ${(pf.deadwood * 100).toFixed(1)}% · forest ${(pf.forest_cover * 100).toFixed(0)}%`;
  fit();
}

function fit() {
  const view = current().views[state.view];
  const stage = $('#stage').getBoundingClientRect();
  const s = Math.min(stage.width / view.size[0], stage.height / view.size[1]);
  state.zoom = { s, x: (stage.width - view.size[0] * s) / 2, y: (stage.height - view.size[1] * s) / 2 };
  applyZoom();
}
function applyZoom() { const z = state.zoom; $('#layers').style.transform = `translate(${z.x}px,${z.y}px) scale(${z.s})`; }

function renderThumbs() {
  const d = current();
  const strip = $('#thumbs');
  strip.replaceChildren(...d.views.map((v, i) => {
    const el = document.createElement('div');
    el.className = 'thumb' + (i === state.view ? ' active' : '');
    const img = new Image(); img.src = src(d, v, 'raw.jpg'); img.loading = 'lazy';
    const name = v.name === 'overview' ? 'overview' : v.name.startsWith('g') ? `grid ${v.name.slice(1)}` : `detail ${v.name.slice(1)}`;
    el.append(img, `${name} · ${(v.mpp * 100).toFixed(0)} cm`);
    el.onclick = () => { state.view = i; render(); };
    return el;
  }));
}

function chips(container, values, selected, onPick, multi) {
  container.replaceChildren(...Object.entries(values).map(([value, text]) => {
    const el = document.createElement('span');
    el.className = 'chip' + ((multi ? selected.includes(value) : selected === value) ? ' on' : '');
    el.dataset.value = value; el.textContent = text;
    el.onclick = () => onPick(value);
    return el;
  }));
}
const pretty = (t) => t.replace(/_/g, ' ');

function renderForm() {
  const d = current();
  const l = label(d.dataset_id);
  for (const layer of LAYERS) {
    const box = document.querySelector(`.layer[data-layer=${layer}]`);
    const item = l.layers[layer];
    chips(box.querySelector('.verdicts'), Object.fromEntries(VERDICTS.map((v) => [v, v[0].toUpperCase() + v.slice(1)])),
      item.verdict, (v) => update((x) => { x.layers[layer].verdict = x.layers[layer].verdict === v ? null : v; }));
    chips(box.querySelector('.areas'), AREAS, item.area,
      (v) => update((x) => { x.layers[layer].area = x.layers[layer].area === v ? null : v; }));
    chips(box.querySelector('.tags'), Object.fromEntries(state.tags[layer].map((t) => [t, pretty(t)])), item.tags,
      (v) => update((x) => { const t = x.layers[layer].tags; x.layers[layer].tags = t.includes(v) ? t.filter((y) => y !== v) : [...t, v]; }), true);
  }
  chips(document.querySelector('.layer[data-layer=imagery] .tags'), Object.fromEntries(state.tags.imagery.map((t) => [t, pretty(t)])),
    l.imagery_tags, (v) => update((x) => { x.imagery_tags = x.imagery_tags.includes(v) ? x.imagery_tags.filter((y) => y !== v) : [...x.imagery_tags, v]; }), true);
  if (document.activeElement !== $('#note')) $('#note').value = l.note;
}

function renderHeader() {
  const d = current();
  const list = visible();
  $('#position').textContent = `${list.indexOf(d) + 1} / ${list.length}`;
  $('#meta').textContent = `Dataset ${d.dataset_id} · ${d.platform} · ${d.country || '?'} · ${d.biome || '?'} · ${d.acquisition.filter(Boolean).join('-')} · ${d.aoi_area_ha.toFixed(1)} ha · native ${(d.native_mpp * 100).toFixed(1)} cm`;
  $('#site').href = `https://deadtrees.earth/dataset/${d.dataset_id}`;
  const done = state.datasets.filter((x) => finished(x.dataset_id)).length;
  $('#progress').textContent = `${done} of ${state.datasets.length} finished`;
  history.replaceState(null, '', `?dataset=${d.dataset_id}`);
}

const GRADE = { great: 'Great', sentinel_ok: 'OK', bad: 'Bad' };
const ROLE = { audited_bad: 'Audited bad', hard_negative: 'Good, looks like a bad one', diverse_keep: 'Good, diverse scene' };
function renderAudit() {
  const a = current().audit || {};
  const rows = [
    ['Deadwood', GRADE[a.deadwood_quality] || '—', `grade-${a.deadwood_quality}`, a.deadwood_notes],
    ['Forest', GRADE[a.forest_cover_quality] || '—', `grade-${a.forest_cover_quality}`, a.forest_cover_notes],
    ['Overall', (a.final_assessment || '—').replace(/_/g, ' ')],
    ['In season', a.has_valid_phenology === false ? 'no' : a.has_valid_phenology ? 'yes' : '—'],
    ['Audited', `${(a.audit_date || '').slice(0, 10)} by ${a.auditor || '?'}`],
    ['Why picked', [ROLE[a.role], ...Object.entries(a.tags || {}).map(([l, t]) => `${l === 'deadwood' ? 'DW' : 'FC'}: ${t.join(', ').replace(/_/g, ' ')}`)].filter(Boolean).join(' · ')],
  ];
  $('#audit-body').replaceChildren(...rows.flatMap(([k, v, cls, note]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    const strong = document.createElement('span'); strong.textContent = v; if (cls) strong.className = cls;
    dd.append(strong); if (note) dd.append(` — ${note}`);
    return [dt, dd];
  }));
}
function renderSol() {
  const s = current().sol;
  $('#sol').hidden = !s;
  if (!s) return;
  $('#sol-body').replaceChildren(...[['Deadwood', s.deadwood], ['Forest', s.forest_cover]].flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    const g = document.createElement('span'); g.textContent = (v.auditor_grade || '?').replace(/^./, (c) => c.toUpperCase());
    g.className = `grade-${v.auditor_grade}`;
    dd.append(g, ` — wrong ${v.commission_pct}%, missed ${v.omission_pct}%. ${v.reason}`);
    return [dt, dd];
  }));
}
function render() { renderHeader(); renderThumbs(); renderViewer(); renderForm(); renderAudit(); renderSol(); }

function update(change) {
  const id = current().dataset_id;
  const next = structuredClone(label(id));
  change(next);
  state.labels[id] = next;
  renderForm(); renderHeader();
  save(id);
}

function save(id) {
  state.saving = state.saving.then(async () => {
    const body = structuredClone(state.labels[id]);
    $('#status').className = ''; $('#status').textContent = 'Saving…';
    const r = await fetch('/api/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await r.json();
    if (!r.ok) { $('#status').className = 'error'; $('#status').textContent = result.error || 'Save failed; your edit is kept in this page'; return; }
    state.labels[id] = Object.assign(state.labels[id], { revision: result.revision });
    $('#status').textContent = `Saved ${new Date(result.updated_at).toLocaleTimeString()}`;
  }).catch(() => { $('#status').className = 'error'; $('#status').textContent = 'Save failed; your edit is kept in this page'; });
}

let noteTimer;
$('#note').addEventListener('input', () => {
  const id = current().dataset_id;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { const n = structuredClone(label(id)); n.note = $('#note').value; state.labels[id] = n; save(id); }, 600);
});

const stage = $('#stage');
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect(); const z = state.zoom;
  const k = Math.exp(-e.deltaY * 0.0015); const px = e.clientX - r.left, py = e.clientY - r.top;
  z.x = px - (px - z.x) * k; z.y = py - (py - z.y) * k; z.s *= k; applyZoom();
}, { passive: false });
stage.addEventListener('pointerdown', (e) => {
  const start = { x: e.clientX, y: e.clientY, zx: state.zoom.x, zy: state.zoom.y };
  stage.classList.add('dragging'); stage.setPointerCapture(e.pointerId);
  const moveDrag = (m) => { state.zoom.x = start.zx + m.clientX - start.x; state.zoom.y = start.zy + m.clientY - start.y; applyZoom(); };
  const end = () => { stage.classList.remove('dragging'); stage.removeEventListener('pointermove', moveDrag); };
  stage.addEventListener('pointermove', moveDrag); stage.addEventListener('pointerup', end, { once: true });
});
stage.addEventListener('dblclick', fit);

for (const id of ['show-deadwood', 'show-forest_cover', 'outline']) $(`#${id}`).addEventListener('change', renderViewer);
$('#opacity').addEventListener('input', () => document.querySelectorAll('.overlay').forEach((i) => { if (!$('#outline').checked) i.style.opacity = $('#opacity').value / 100; }));
$('#fit').onclick = fit;
$('#prev').onclick = () => move(-1);
$('#next').onclick = () => move(1);
$('#filter').onchange = () => { if (!visible().includes(current())) move(0); else renderHeader(); };
window.addEventListener('resize', fit);
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA') { if (e.key === 'Escape') e.target.blur(); return; }
  const key = e.key;
  const toggle = (id) => { $(id).checked = !$(id).checked; renderViewer(); };
  if (key === 'n') move(1); else if (key === 'p') move(-1);
  else if (key === 'ArrowRight') { state.view = (state.view + 1) % current().views.length; render(); }
  else if (key === 'ArrowLeft') { state.view = (state.view - 1 + current().views.length) % current().views.length; render(); }
  else if (key === 'd') toggle('#show-deadwood'); else if (key === 'f') toggle('#show-forest_cover');
  else if (key === 'o') toggle('#outline'); else if (key === '0') fit();
  else if ('123'.includes(key)) update((x) => { x.layers.deadwood.verdict = VERDICTS[+key - 1]; });
  else if ('456'.includes(key)) update((x) => { x.layers.forest_cover.verdict = VERDICTS[+key - 4]; });
});

fetch('/api/datasets').then((r) => r.json()).then((data) => {
  state.datasets = data.datasets; state.labels = data.labels; state.tags = data.tags;
  const wanted = Number(new URLSearchParams(location.search).get('dataset'));
  state.index = Math.max(0, state.datasets.findIndex((d) => d.dataset_id === wanted));
  if (state.datasets.length) render(); else $('#meta').textContent = 'No rendered datasets yet';
});
