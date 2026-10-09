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
  if (f === 'adjudicate') return state.datasets.filter((d) => d.adjudicate.length);
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

function src(d, view, suffix) { return view.file ? `/files/${view.file}` : `/files/datasets/${d.dataset_id}/${view.name}-${suffix}`; }
const viewId = (v) => (v.name === 'overview' ? 'O' : v.name.toUpperCase());
const normView = (id) => String(id || '').toUpperCase().split('-')[0].replace(/^O.*/, 'O');
function views(d) {
  return [...d.views, ...((d.sol && d.sol.zooms) || []).map((z) => ({ name: z.name, file: z.file, zoom: z }))];
}
function marks(d, view) {
  // Sol's issue boxes and zoom footprints that fall on this view, in its pixels.
  const out = [];
  if (view.file) return out;
  for (const layer of d.sol ? LAYERS : []) {
    (d.sol[layer].issues || []).forEach((issue, i) => {
      for (const r of issue.regions || []) {
        if (normView(r.view) === viewId(view) && Array.isArray(r.box) && r.box.length === 4) {
          const fkey = `${d.sol.run}:${layer}:${i}:${issue.regions.indexOf(r)}`;
          const fb = (label(d.dataset_id).box_feedback || {})[fkey];
          out.push({ box: r.box, label: `${layer === 'deadwood' ? 'DW' : 'FC'} ${issue.mode.replace(/_/g, ' ')}${fb && fb.verdict ? (fb.verdict === 'right' ? ' ✓' : ' ✗') : ''}`,
            key: `${layer}:${i}`, fkey, cls: `mark issue ${layer} ${issue.severity}${fb && fb.verdict ? ` fb-${fb.verdict}` : ''}` });
        }
      }
    });
  }
  for (const u of label(d.dataset_id).user_boxes || []) {
    if (u.view === viewId(view)) {
      out.push({ box: u.box, label: `you · ${u.layer === 'deadwood' ? 'DW' : 'FC'} ${u.kind.replace(/_/g, ' ')}${u.note ? `: ${u.note}` : ''}`,
        key: u.id, user: u, cls: 'mark user' });
    }
  }
  for (const z of (d.sol && d.sol.zooms) || []) {
    if (normView(z.view) === viewId(view)) out.push({ box: z.rect, label: z.name, key: z.name, cls: 'mark zoom' });
  }
  return out;
}

function renderViewer() {
  const d = current();
  const view = views(d)[state.view];
  const box = $('#layers');
  box.replaceChildren();
  if (view.file) {
    const img = new Image(); img.src = src(d, view); img.className = 'raw';
    img.onload = () => { view.size = [img.naturalWidth, img.naturalHeight]; img.width = view.size[0]; img.height = view.size[1]; fit(); };
    box.append(img);
    $('#view-info').textContent = `${view.name}: Sol zoom on ${view.zoom.view} · ${view.zoom.cm_per_px} cm/px · raw | deadwood | forest · "${view.zoom.purpose}"`;
    return;
  }
  const add = (url, cls) => { const img = new Image(); img.src = url; img.className = cls; img.width = view.size[0]; img.height = view.size[1]; box.append(img); return img; };
  add(src(d, view, 'raw.jpg'), 'raw');
  const mode = $('#outline').checked ? 'outline' : 'fill';
  for (const layer of LAYERS) {
    const img = add(src(d, view, `${layer}-${mode}.png`), `overlay ${layer}`);
    img.hidden = !$(`#show-${layer}`).checked;
    img.style.opacity = mode === 'fill' ? $('#opacity').value / 100 : 1;
  }
  for (const m of marks(d, view)) {
    const el = document.createElement('div');
    el.className = m.cls + (state.highlight && state.highlight === m.key ? ' highlight' : '');
    const [x0, y0, x1, y1] = m.box;
    Object.assign(el.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`,
      width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
    const tag = document.createElement('span'); tag.textContent = m.label; el.append(tag);
    el.hidden = !$('#show-marks').checked;
    if (m.fkey || m.user) {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => { e.stopPropagation(); openPopover(e, m); });
    }
    box.append(el);
  }
  const pf = view.predicted_fraction;
  $('#view-info').textContent = `${view.name} · ${(view.mpp * 100).toFixed(1)} cm/px · predicted deadwood ${(pf.deadwood * 100).toFixed(1)}% · forest ${(pf.forest_cover * 100).toFixed(0)}%`;
  fit();
}

function fit() {
  const view = views(current())[state.view];
  if (!view.size) return;
  const stage = $('#stage').getBoundingClientRect();
  const s = Math.min(stage.width / view.size[0], stage.height / view.size[1]);
  state.zoom = { s, x: (stage.width - view.size[0] * s) / 2, y: (stage.height - view.size[1] * s) / 2 };
  applyZoom();
}
function applyZoom() { const z = state.zoom; $('#layers').style.transform = `translate(${z.x}px,${z.y}px) scale(${z.s})`; }

function renderThumbs() {
  const d = current();
  const strip = $('#thumbs');
  strip.replaceChildren(...views(d).map((v, i) => {
    const el = document.createElement('div');
    const n = marks(d, v).filter((m) => !m.cls.includes('zoom')).length;
    el.className = 'thumb' + (i === state.view ? ' active' : '') + (v.file ? ' zoomthumb' : '') + (n ? ' flagged' : '');
    const img = new Image(); img.src = src(d, v, 'raw.jpg'); img.loading = 'lazy';
    const name = v.file ? `Sol ${v.name} (${v.zoom.view})` : v.name === 'overview' ? 'overview' : v.name.startsWith('g') ? `grid ${v.name.slice(1)}` : `detail ${v.name.slice(1)}`;
    el.append(img, v.file ? name : `${name} · ${(v.mpp * 100).toFixed(0)} cm${n ? ` · ${n}⚑` : ''}`);
    el.onclick = () => { state.view = i; state.highlight = null; render(); };
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
  $('#check').textContent = d.adjudicate.length ? `Check ${d.adjudicate.map((l) => (l === 'deadwood' ? 'deadwood' : 'forest')).join(' + ')}` : '';
  for (const layer of LAYERS) document.querySelector(`.layer[data-layer=${layer}]`).classList.toggle('check', d.adjudicate.includes(layer));
  const queue = state.datasets.filter((x) => x.adjudicate.length);
  const checked = queue.filter((x) => x.adjudicate.every((l) => label(x.dataset_id).layers[l].verdict)).length;
  $('#progress').textContent = `${checked} of ${queue.length} adjudicated`;
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
function jump(viewName, key) {
  const d = current();
  const i = views(d).findIndex((v) => (v.file ? v.name : viewId(v)) === normView(viewName) || v.name === viewName);
  if (i < 0) return;
  state.view = i; state.highlight = key; render();
}
function renderSol() {
  const s = current().sol;
  $('#sol').hidden = !s;
  if (!s) return;
  $('#sol-run').textContent = s.run.replace('sol-issue-finder-', '');
  $('#sol-body').replaceChildren(...[['Deadwood', 'deadwood'], ['Forest', 'forest_cover']].flatMap(([k, layer]) => {
    const v = s[layer];
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    const g = document.createElement('span'); g.textContent = (v.auditor_grade || '?').replace(/^./, (c) => c.toUpperCase());
    g.className = `grade-${v.auditor_grade}`;
    dd.append(g, ` — wrong ${v.commission_pct}%, missed ${v.omission_pct}%. ${v.reason}`);
    const list = document.createElement('ul'); list.className = 'issues';
    (v.issues || []).forEach((issue, i) => {
      const li = document.createElement('li');
      li.className = issue.severity;
      li.append(`${issue.mode.replace(/_/g, ' ')} (${issue.severity}): ${issue.evidence} `);
      const fkey = `${s.run}:${layer}:${i}`;
      const given = (label(current().dataset_id).issue_feedback || {})[fkey];
      const fb = document.createElement('span'); fb.className = 'feedback';
      for (const [value, text] of [['real_major', 'real, major'], ['real_minor', 'real, minor'], ['wrong', 'wrong']]) {
        const c = document.createElement('span'); c.className = 'chip small' + (given === value ? ' on' : ''); c.textContent = text;
        c.onclick = () => update((x) => { x.issue_feedback = Object.assign({}, x.issue_feedback); if (x.issue_feedback[fkey] === value) delete x.issue_feedback[fkey]; else x.issue_feedback[fkey] = value; });
        fb.append(c);
      }
      li.append(fb);
      const targets = (issue.regions || []).length ? [...new Set(issue.regions.map((r) => normView(r.view)))] : (issue.views || []).map(normView);
      for (const t of [...new Set(targets)]) {
        const b = document.createElement('button'); b.className = 'goto'; b.textContent = t;
        b.onclick = () => jump(t, `${layer}:${i}`);
        li.append(b);
      }
      list.append(li);
    });
    dd.append(list);
    return [dt, dd];
  }));
}
function render() { renderHeader(); renderThumbs(); renderViewer(); renderForm(); renderAudit(); renderSol(); }

function update(change) {
  const id = current().dataset_id;
  const next = structuredClone(label(id));
  change(next);
  state.labels[id] = next;
  renderForm(); renderHeader(); renderSol();
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
function closePopover() { $('#popover').hidden = true; }
$('#popover').addEventListener('pointerdown', (e) => e.stopPropagation());
$('#popover').addEventListener('wheel', (e) => e.stopPropagation());
function openPopover(e, m) {
  // m.fkey: Sol box verdict; m.user: edit a drawn box; m.draft: new drawn box.
  const pop = $('#popover');
  const d = current();
  const l = label(d.dataset_id);
  const isSol = Boolean(m.fkey);
  const existing = isSol ? (l.box_feedback || {})[m.fkey] || {} : m.user || m.draft;
  pop.querySelector('.title').textContent = isSol ? m.label.replace(/ [✓✗]$/, '') : m.user ? 'Your box' : 'New box';
  pop.querySelector('.sol-only').hidden = !isSol;
  pop.querySelector('.user-only').hidden = isSol;
  pop.querySelector('.delete').hidden = !m.user;
  pop.querySelector('[name=note]').value = existing.note || '';
  if (!isSol) {
    pop.querySelector('[name=layer]').value = existing.layer || 'deadwood';
    pop.querySelector('[name=kind]').value = existing.kind || 'missed_by_sol';
  }
  pop.querySelectorAll('.sol-only .chip').forEach((c) => c.classList.toggle('on', existing.verdict === c.dataset.value));
  const save = (verdict) => {
    const note = pop.querySelector('[name=note]').value.trim();
    update((x) => {
      if (isSol) {
        x.box_feedback = Object.assign({}, x.box_feedback);
        if (verdict === null) delete x.box_feedback[m.fkey]; else x.box_feedback[m.fkey] = { verdict, note };
      } else {
        const entry = { id: (m.user || m.draft).id, view: (m.user || m.draft).view, box: (m.user || m.draft).box,
          layer: pop.querySelector('[name=layer]').value, kind: pop.querySelector('[name=kind]').value, note };
        x.user_boxes = (x.user_boxes || []).filter((u) => u.id !== entry.id);
        if (verdict !== 'delete') x.user_boxes.push(entry);
      }
    });
    closePopover(); renderViewer(); renderThumbs();
  };
  pop.querySelectorAll('.sol-only .chip').forEach((c) => { c.onclick = () => save(c.dataset.value); });
  pop.querySelector('.clear').onclick = () => save(null);
  pop.querySelector('.save').onclick = () => save(isSol ? existing.verdict || null : 'keep');
  pop.querySelector('.delete').onclick = () => save('delete');
  pop.querySelector('.cancel').onclick = closePopover;
  const r = $('#stage').getBoundingClientRect();
  pop.style.left = `${Math.min(e.clientX - r.left + 8, r.width - 300)}px`;
  pop.style.top = `${Math.min(e.clientY - r.top + 8, r.height - 230)}px`;
  pop.hidden = false;
  pop.querySelector('[name=note]').focus();
}
function toImage(e) {
  const r = $('#stage').getBoundingClientRect(); const z = state.zoom;
  return [Math.round((e.clientX - r.left - z.x) / z.s), Math.round((e.clientY - r.top - z.y) / z.s)];
}
stage.addEventListener('pointerdown', (e) => {
  closePopover();
  const view = views(current())[state.view];
  if (e.shiftKey && !view.file) {
    // Shift-drag draws a reviewer box in this view's pixels.
    const a = toImage(e);
    const draft = document.createElement('div'); draft.className = 'mark user drafting'; $('#layers').append(draft);
    stage.setPointerCapture(e.pointerId);
    const drawMove = (m) => {
      const b = toImage(m);
      Object.assign(draft.style, { left: `${Math.min(a[0], b[0])}px`, top: `${Math.min(a[1], b[1])}px`,
        width: `${Math.abs(b[0] - a[0])}px`, height: `${Math.abs(b[1] - a[1])}px` });
    };
    const drawEnd = (m) => {
      stage.removeEventListener('pointermove', drawMove);
      const b = toImage(m);
      draft.remove();
      if (Math.abs(b[0] - a[0]) < 6 || Math.abs(b[1] - a[1]) < 6) return;
      const clamp = (v, max) => Math.max(0, Math.min(max, v));
      const box = [clamp(Math.min(a[0], b[0]), view.size[0]), clamp(Math.min(a[1], b[1]), view.size[1]),
        clamp(Math.max(a[0], b[0]), view.size[0]), clamp(Math.max(a[1], b[1]), view.size[1])];
      openPopover(m, { draft: { id: `u${Date.now().toString(36)}`, view: viewId(view), box } });
    };
    stage.addEventListener('pointermove', drawMove); stage.addEventListener('pointerup', drawEnd, { once: true });
    return;
  }
  const start = { x: e.clientX, y: e.clientY, zx: state.zoom.x, zy: state.zoom.y };
  stage.classList.add('dragging'); stage.setPointerCapture(e.pointerId);
  const moveDrag = (m) => { state.zoom.x = start.zx + m.clientX - start.x; state.zoom.y = start.zy + m.clientY - start.y; applyZoom(); };
  const end = () => { stage.classList.remove('dragging'); stage.removeEventListener('pointermove', moveDrag); };
  stage.addEventListener('pointermove', moveDrag); stage.addEventListener('pointerup', end, { once: true });
});
stage.addEventListener('dblclick', fit);

for (const id of ['show-deadwood', 'show-forest_cover', 'outline', 'show-marks']) $(`#${id}`).addEventListener('change', renderViewer);
$('#opacity').addEventListener('input', () => document.querySelectorAll('.overlay').forEach((i) => { if (!$('#outline').checked) i.style.opacity = $('#opacity').value / 100; }));
$('#fit').onclick = fit;
$('#prev').onclick = () => move(-1);
$('#next').onclick = () => move(1);
$('#filter').onchange = () => { if (!visible().includes(current())) move(0); else renderHeader(); };
window.addEventListener('resize', fit);
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
    if (e.key === 'Escape') { e.target.blur(); closePopover(); }
    return;
  }
  const key = e.key;
  const toggle = (id) => { $(id).checked = !$(id).checked; renderViewer(); };
  if (key === 'n') move(1); else if (key === 'p') move(-1);
  else if (key === 'ArrowRight') { state.view = (state.view + 1) % views(current()).length; state.highlight = null; render(); }
  else if (key === 'ArrowLeft') { state.view = (state.view - 1 + views(current()).length) % views(current()).length; state.highlight = null; render(); }
  else if (key === 'b') { $('#show-marks').checked = !$('#show-marks').checked; renderViewer(); }
  else if (key === 'd') toggle('#show-deadwood'); else if (key === 'f') toggle('#show-forest_cover');
  else if (key === 'o') toggle('#outline'); else if (key === '0') fit();
  else if ('123'.includes(key)) update((x) => { x.layers.deadwood.verdict = VERDICTS[+key - 1]; });
  else if ('456'.includes(key)) update((x) => { x.layers.forest_cover.verdict = VERDICTS[+key - 4]; });
});

fetch('/api/datasets').then((r) => r.json()).then((data) => {
  state.datasets = data.datasets; state.labels = data.labels; state.tags = data.tags;
  if (state.datasets.some((d) => d.adjudicate.length)) $('#filter').value = 'adjudicate';
  const wanted = Number(new URLSearchParams(location.search).get('dataset'));
  state.index = Math.max(0, state.datasets.findIndex((d) => d.dataset_id === wanted));
  if (state.datasets.length) render(); else $('#meta').textContent = 'No rendered datasets yet';
});
