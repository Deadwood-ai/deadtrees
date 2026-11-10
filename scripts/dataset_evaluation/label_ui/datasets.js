const $ = (s) => document.querySelector(s);
const CALLS = [['keep', 'Keep'], ['fix', 'Keep, fix'], ['exclude', 'Exclude'], ['unsure', 'Unsure']];
const REASON_KEYS = 'qwertyuiop';
const FIX_KEYS = 'asd';
const LABEL = {
  blurry: 'Blurry', duplicate: 'Duplicate', no_trees: 'No trees', wrong_georeferencing: 'Wrong georef', artifacts: 'Artifacts',
  season: 'Season', not_rgb: 'Not RGB', broken_ortho: 'Broken ortho', too_dark: 'Too dark', other: 'Other',
  cog_issue: 'COG issue', thumbnail_issue: 'Thumbnail issue', reprocess: 'Reprocess',
};
// audit.verdict back to the page's words
const WORD = { ok: 'keep', minor: 'fix', major: 'exclude', unsure: 'unsure' };
const st = { datasets: [], labels: {}, drafts: {}, reasons: [], fixFlags: [], i: 0, views: {}, hover: null };

const cur = () => st.datasets[st.i];
const saved = (d = cur()) => st.labels[d.dataset_id];
const draft = (d = cur()) => st.drafts[d.dataset_id] || { call: null, reasons: [], fix_flags: [], note: '', ...(saved(d) || {}) };
const done = (d) => !!saved(d);
// The dataset rule's call, from the newest run that has one.
function ruleCall(d) {
  const runs = Object.values(d.models || {});
  for (const run of runs.reverse()) {
    const rule = (run.assessments || []).find((a) => a.model === 'dataset-evaluation-rule');
    if (rule) return WORD[rule.verdict];
  }
  return null;
}
const FILTERS = {
  all: () => true,
  open: (d) => !done(d),
  dev: (d) => d.split === 'dev',
  holdout: (d) => d.split === 'holdout',
  disagree: (d) => done(d) && ruleCall(d) && (saved(d).call === 'exclude') !== (ruleCall(d) === 'exclude'),
};

function problem(l) {
  if (!l.call) return 'Pick keep, keep but fix, exclude or unsure.';
  if (l.call === 'exclude' && !l.reasons.length) return 'An exclusion needs a reason.';
  if (l.call === 'fix' && !l.fix_flags.length) return 'Keep but fix needs what to fix.';
  return null;
}

function chip(text, key, on, onClick, cls, disabled) {
  const c = document.createElement('span');
  c.className = `chip ${cls || ''}${on ? ' on' : ''}${disabled ? ' disabled' : ''}`;
  if (key) { const k = document.createElement('kbd'); k.textContent = key; c.append(k); }
  c.append(text);
  if (!disabled) c.onclick = onClick;
  return c;
}
function heading(text) { const h = document.createElement('h3'); h.textContent = text; return h; }

function renderForm() {
  const l = draft();
  $('#calls').replaceChildren(heading('CALL'), ...CALLS.map(([v, text], n) => {
    const c = chip(text, String(n + 1), l.call === v, () => setCall(v));
    c.dataset.call = v; return c;
  }));
  $('#reasons').replaceChildren(heading('EXCLUDE BECAUSE'), ...st.reasons.map((r, n) =>
    chip(LABEL[r] || r, REASON_KEYS[n], l.reasons.includes(r), () => toggle('reasons', r), 'reason', l.call !== 'exclude')));
  $('#fixes').replaceChildren(heading('FIX'), ...st.fixFlags.map((f, n) =>
    chip(LABEL[f] || f, FIX_KEYS[n], l.fix_flags.includes(f), () => toggle('fix_flags', f), 'fixflag', l.call === 'exclude')));
  if (document.activeElement !== $('#note')) $('#note').value = l.note || '';
}
function edit(change) {
  const d = cur(); const l = structuredClone(draft(d)); change(l); st.drafts[d.dataset_id] = l; renderForm();
  $('#status').textContent = saved(d) ? 'Changed; Enter saves.' : '';
}
function setCall(v) {
  edit((l) => {
    l.call = v;
    if (v !== 'exclude') l.reasons = [];
    if (v === 'exclude') l.fix_flags = [];
  });
}
function toggle(field, value) {
  edit((l) => {
    if (field === 'reasons' && l.call !== 'exclude') l.call = 'exclude';
    if (field === 'fix_flags' && l.call === 'exclude') return;
    if (field === 'fix_flags' && !l.call) l.call = 'fix';
    l[field] = l[field].includes(value) ? l[field].filter((x) => x !== value) : [...l[field], value];
  });
}

async function save() {
  const d = cur(); const l = draft(d); const why = problem(l);
  if (why) { $('#status').textContent = why; return; }
  const body = { dataset_id: d.dataset_id, revision: (saved(d) || {}).revision || 0, call: l.call,
    reasons: l.reasons, fix_flags: l.fix_flags, note: l.note };
  const r = await fetch('/api/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json();
  if (!r.ok) { $('#status').textContent = out.error || 'Save failed; your answer is kept in this page.'; return; }
  st.labels[d.dataset_id] = out; delete st.drafts[d.dataset_id];
  $('#status').textContent = `Saved ${new Date().toLocaleTimeString()}`;
  nextOpen();
}

function renderInfo() {
  const d = cur();
  const a = d.audit || {};
  const audit = $('#audit'); audit.hidden = !$('#showAudit').checked;
  audit.replaceChildren();
  if (!audit.hidden) {
    const h = document.createElement('h4'); h.textContent = 'OLD AUDIT';
    const p = document.createElement('div');
    p.textContent = `${a.final_assessment || 'none'}${a.reason ? ` (${a.reason})` : ''} · ${a.auditor || '?'} ${a.year || ''}`;
    const n = document.createElement('div'); n.className = 'muted';
    n.textContent = [a.notes, a.cog_issue_notes, a.thumbnail_issue_notes].filter(Boolean).join(' · ');
    audit.append(h, p, n);
  }
  const models = $('#models'); models.hidden = !$('#showModels').checked;
  models.replaceChildren();
  if (!models.hidden) {
    const h = document.createElement('h4'); h.textContent = 'MODEL ANSWERS'; models.append(h);
    const runs = Object.entries(d.models || {});
    if (!runs.length) models.append('No model run yet.');
    for (const [run, result] of runs) {
      for (const m of result.assessments || []) {
        const div = document.createElement('div'); div.className = 'model';
        const word = WORD[m.verdict] || m.verdict;
        const head = document.createElement('div');
        const v = document.createElement('b'); v.className = `verdict-${word}`; v.textContent = word;
        head.append(`${m.model} `, v, ` ${Math.round(m.major_likelihood)}%`, m.details && m.details.reason ? ` · ${m.details.reason}` : '');
        div.append(head);
        if (m.details && m.details.summary) { const s = document.createElement('div'); s.className = 'muted'; s.textContent = m.details.summary; div.append(s); }
        div.title = run;
        models.append(div);
      }
    }
  }
}

// Each view zooms and pans on its own.
function fit(name) {
  const v = st.views[name]; if (!v || !v.size) return;
  const r = v.el.getBoundingClientRect();
  const s = Math.min(r.width / v.size[0], r.height / v.size[1]);
  v.z = { s, x: (r.width - v.size[0] * s) / 2, y: (r.height - v.size[1] * s) / 2 }; apply(name);
}
function apply(name) { const v = st.views[name]; v.inner.style.transform = `translate(${v.z.x}px,${v.z.y}px) scale(${v.z.s})`; }
function bindZoom(el, inner, name) {
  st.views[name] = { el, inner, z: { s: 1, x: 0, y: 0 }, size: null };
  el.addEventListener('wheel', (e) => { e.preventDefault(); const v = st.views[name]; const r = el.getBoundingClientRect(); const f = Math.exp(-e.deltaY * 0.0015);
    const px = e.clientX - r.left, py = e.clientY - r.top; v.z.x = px - (px - v.z.x) * f; v.z.y = py - (py - v.z.y) * f; v.z.s *= f; apply(name); }, { passive: false });
  el.addEventListener('pointerdown', (e) => { const v = st.views[name]; const s = { x: e.clientX, y: e.clientY, zx: v.z.x, zy: v.z.y }; el.setPointerCapture(e.pointerId);
    const mv = (m) => { v.z.x = s.zx + m.clientX - s.x; v.z.y = s.zy + m.clientY - s.y; apply(name); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', () => el.removeEventListener('pointermove', mv), { once: true }); });
  el.addEventListener('dblclick', () => fit(name));
  el.addEventListener('mouseenter', () => { st.hover = name; el.classList.add('hover'); });
  el.addEventListener('mouseleave', () => { if (st.hover === name) st.hover = null; el.classList.remove('hover'); });
}
function load(name, src) {
  const v = st.views[name];
  const img = new Image(); img.src = src;
  img.onload = () => { v.size = [img.naturalWidth, img.naturalHeight]; fit(name); };
  v.inner.replaceChildren(img); v.size = null;
}
function renderViews() {
  const d = cur();
  document.querySelectorAll('#views .view').forEach((el) => {
    const name = el.dataset.name; const has = d.images.includes(`${name}.jpg`);
    el.hidden = !has;
    if (has) load(name, `/files/${d.dataset_id}/${name}.jpg`);
  });
  const t = $('#thumb'); t.hidden = !d.images.includes('thumbnail.jpg');
  if (!t.hidden) t.querySelector('img').src = `/files/${d.dataset_id}/thumbnail.jpg`;
  // Preload the next dataset so stepping is instant.
  const n = st.datasets[(st.i + 1) % st.datasets.length];
  n.images.forEach((f) => { new Image().src = `/files/${n.dataset_id}/${f}`; });
}
function openZoom() {
  if (!st.hover) return;
  const zoom = $('#zoom'); zoom.hidden = false;
  if (!st.views.zoom) bindZoom(zoom, zoom.querySelector('.inner'), 'zoom');
  load('zoom', `/files/${cur().dataset_id}/${st.hover}.jpg`);
}
const closeZoom = () => { $('#zoom').hidden = true; };

function render() {
  const d = cur();
  const keep = FILTERS[$('#filter').value] || FILTERS.all; const shown = st.datasets.filter(keep);
  $('#pos').textContent = $('#filter').value === 'all' ? `${st.i + 1} / ${st.datasets.length}` : `${shown.indexOf(d) + 1} / ${shown.length}`;
  const [overviewMpp, cropMpp] = [d.mpp.overview, d.mpp.crop];
  $('#meta').textContent = `Dataset ${d.dataset_id} · ${d.platform} · ${d.data_access} · ${d.split} · overview ${(overviewMpp * 100).toFixed(0)} cm/px · crops ${(cropMpp * 100).toFixed(1)} cm/px`;
  $('#site').href = `https://deadtrees.earth/dataset/${d.dataset_id}`;
  $('#progress').textContent = `${st.datasets.filter(done).length} of ${st.datasets.length} labeled`;
  history.replaceState(null, '', `?dataset=${d.dataset_id}`);
  renderViews(); renderForm(); renderInfo();
}
function move(step) {
  const keep = FILTERS[$('#filter').value] || FILTERS.all;
  for (let n = 1; n <= st.datasets.length; n++) {
    const j = (st.i + step * n + st.datasets.length * n) % st.datasets.length;
    if (keep(st.datasets[j])) { st.i = j; return render(); }
  }
  $('#status').textContent = 'No dataset matches this filter.';
}
function nextOpen() {
  for (let n = 1; n <= st.datasets.length; n++) { const j = (st.i + n) % st.datasets.length; if (!done(st.datasets[j])) { st.i = j; return render(); } }
  $('#status').textContent = 'Every dataset is labeled.'; render();
}

let noteTimer;
// The note reaches the draft after a pause in typing, and at once when the field is left, so a save right after typing has all of it.
function flushNote() { if (!noteTimer) return; clearTimeout(noteTimer); noteTimer = null; edit((l) => { l.note = $('#note').value; }); }
$('#note').addEventListener('input', () => { clearTimeout(noteTimer); noteTimer = setTimeout(flushNote, 300); });
$('#note').addEventListener('blur', flushNote);
$('#prev').onclick = () => move(-1); $('#next').onclick = () => move(1); $('#nextOpen').onclick = nextOpen; $('#save').onclick = save;
$('#filter').onchange = () => { $('#filter').blur(); if (!FILTERS[$('#filter').value](cur())) move(1); else render(); };
for (const id of ['showAudit', 'showModels']) {
  $(`#${id}`).onchange = () => { try { localStorage.setItem(id, $(`#${id}`).checked ? '1' : '0'); } catch (e) { /* storage blocked */ }
    $(`#${id}`).blur(); renderInfo(); };
}
$('#zoom').addEventListener('click', (e) => { if (e.target.id === 'zoom') closeZoom(); });
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA') { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return; // browser shortcuts (Ctrl+S, Ctrl+R) are not labels
  const key = e.key.toLowerCase();
  if (e.key === 'Escape') return closeZoom();
  if (/^[1-4]$/.test(key)) return setCall(CALLS[Number(key) - 1][0]);
  if (REASON_KEYS.includes(key) && st.reasons[REASON_KEYS.indexOf(key)]) return toggle('reasons', st.reasons[REASON_KEYS.indexOf(key)]);
  if (FIX_KEYS.includes(key) && st.fixFlags[FIX_KEYS.indexOf(key)]) return toggle('fix_flags', st.fixFlags[FIX_KEYS.indexOf(key)]);
  if (key === 'z') return openZoom();
  if (e.key === 'Enter') { e.preventDefault(); return save(); }
  if (e.key === 'Tab') { e.preventDefault(); return nextOpen(); }
  if (e.key === 'ArrowRight') return move(1);
  if (e.key === 'ArrowLeft') return move(-1);
});
document.querySelectorAll('#views .view').forEach((el) => bindZoom(el, el.querySelector('.inner'), el.dataset.name));
window.addEventListener('resize', () => Object.keys(st.views).forEach(fit));

fetch('/api/datasets').then((r) => r.json()).then((d) => {
  st.datasets = d.datasets; st.labels = d.labels; st.reasons = d.reasons; st.fixFlags = d.fix_flags;
  // Hidden by default so labeling stays blind; the choice is remembered in this browser.
  for (const id of ['showAudit', 'showModels']) { try { $(`#${id}`).checked = localStorage.getItem(id) === '1'; } catch (e) { /* storage blocked */ } }
  if (!st.datasets.length) { $('#status').textContent = 'No rendered datasets yet: run render_gold.py first.'; return; }
  const want = Number(new URLSearchParams(location.search).get('dataset'));
  const open = st.datasets.findIndex((x) => !done(x));
  st.i = want ? Math.max(0, st.datasets.findIndex((x) => x.dataset_id === want)) : Math.max(0, open);
  render();
});
