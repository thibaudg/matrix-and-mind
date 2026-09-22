/* ==========================================================================
   Matrix & Mind — app logic (v2)
   Storage: Supabase (Postgres + Auth). One row per record; task/thought
   data stored as JSON. Counts computed client-side. View prefs in localStorage.
   ========================================================================== */

const QUADS = ['do', 'schedule', 'delegate', 'drop'];
const QUAD_META = {
  do:       { title: 'Do with intention', listSub: 'First' },
  schedule: { title: 'Schedule',          listSub: 'Then' },
  delegate: { title: 'Do – low effort',   listSub: 'Quick wins' },
  drop:     { title: 'Drop',              listSub: 'Let go' }
};

let supa = null;
let user = null;

let matrices = [];   // {id, name, tasks:[{id,text,quadrant,done}], updated_at}
let sessions = [];   // {id, name, data:{thoughts:[{id,text}], balances:[{id,text}], summary}, updated_at}

let currentMatrixId = null, currentTasks = [];
let currentSessionId = null, currentData = null;

let loginMode = 'signin';

/* ---------- helpers ---------- */
function uid(p){ return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function $(id){ return document.getElementById(id); }
function el(tag, cls){ const e = document.createElement(tag); if(cls) e.className = cls; return e; }
function nowISO(){ return new Date().toISOString(); }

function showView(name){
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + name).classList.add('active');
  window.scrollTo(0, 0);
}

/* view preferences (localStorage — safe on a normal website) */
function lsGet(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : v; }catch(e){ return d; } }
function lsSet(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }
function getMatrixView(){ return lsGet('mm-matrix-view', 'grid'); }
function getSessionView(){ return lsGet('mm-session-view', 'cols'); }

/* normalize a session's stored JSON into {thoughts, balances, summary},
   migrating the old pair format ([{neg,pos,star}]) if present */
function normSessionData(raw){
  if(raw && !Array.isArray(raw) && typeof raw === 'object'){
    return {
      thoughts: Array.isArray(raw.thoughts) ? raw.thoughts : [],
      balances: Array.isArray(raw.balances) ? raw.balances : [],
      summary:  typeof raw.summary === 'string' ? raw.summary : ''
    };
  }
  const arr = Array.isArray(raw) ? raw : [];
  const thoughts = [], balances = [];
  arr.forEach(p => {
    if(p && (p.neg || '').trim()) thoughts.push({ id: uid('t'), text: p.neg.trim() });
    if(p && (p.pos || '').trim()) balances.push({ id: uid('b'), text: p.pos.trim() });
  });
  return { thoughts, balances, summary: '' };
}

/* ==========================================================================
   Supabase data layer
   ========================================================================== */
async function loadAll(){
  const [m, s] = await Promise.all([
    supa.from('matrices').select('*').order('updated_at', { ascending: false }),
    supa.from('sessions').select('*').order('updated_at', { ascending: false })
  ]);
  matrices = (m.data || []).map(r => ({ ...r, tasks: r.tasks || [] }));
  sessions = (s.data || []).map(r => ({ ...r, data: normSessionData(r.pairs) }));
}

async function insertMatrix(name){
  const { data } = await supa.from('matrices')
    .insert({ user_id: user.id, name, tasks: [] }).select().single();
  if(data){ data.tasks = data.tasks || []; matrices.unshift(data); }
  return data;
}
async function saveMatrix(id, patch){
  const rec = matrices.find(x => x.id === id);
  if(rec) Object.assign(rec, patch, { updated_at: nowISO() });
  await supa.from('matrices').update({ ...patch, updated_at: nowISO() }).eq('id', id);
}
async function removeMatrix(id){
  matrices = matrices.filter(x => x.id !== id);
  await supa.from('matrices').delete().eq('id', id);
}

async function insertSession(name){
  const starter = { thoughts: [], balances: [], summary: '' };
  const { data } = await supa.from('sessions')
    .insert({ user_id: user.id, name, pairs: starter }).select().single();
  if(data){ data.data = normSessionData(data.pairs); sessions.unshift(data); }
  return data;
}
async function saveSessionData(id){
  const rec = sessions.find(x => x.id === id);
  const obj = rec ? rec.data : currentData;
  if(rec) rec.updated_at = nowISO();
  await supa.from('sessions').update({ pairs: obj, updated_at: nowISO() }).eq('id', id);
}
async function removeSession(id){
  sessions = sessions.filter(x => x.id !== id);
  await supa.from('sessions').delete().eq('id', id);
}

/* ==========================================================================
   Auth
   ========================================================================== */
function setupLogin(){
  const form = $('login-form');
  const toggle = $('login-toggle');
  const submit = $('login-submit');
  const err = $('login-error');

  toggle.addEventListener('click', () => {
    loginMode = (loginMode === 'signin') ? 'signup' : 'signin';
    submit.textContent = (loginMode === 'signin') ? 'Sign in' : 'Create account';
    $('login-switch').innerHTML = (loginMode === 'signin')
      ? 'New here? <b id="login-toggle">Create an account</b>'
      : 'Already have an account? <b id="login-toggle">Sign in</b>';
    $('login-password').setAttribute('autocomplete', loginMode === 'signin' ? 'current-password' : 'new-password');
    err.textContent = '';
    $('login-toggle').addEventListener('click', () => toggle.click());
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const email = $('login-email').value.trim();
    const password = $('login-password').value;
    if(!email || !password) return;
    submit.disabled = true;
    submit.textContent = '…';
    try{
      let res;
      if(loginMode === 'signin') res = await supa.auth.signInWithPassword({ email, password });
      else                       res = await supa.auth.signUp({ email, password });
      if(res.error) throw res.error;
      if(loginMode === 'signup' && res.data && !res.data.session){
        err.style.color = 'var(--light)';
        err.textContent = 'Check your email to confirm, then sign in.';
        loginMode = 'signin';
        submit.textContent = 'Sign in';
      }
    }catch(ex){
      err.style.color = 'var(--danger)';
      err.textContent = ex.message || 'Something went wrong.';
    }finally{
      submit.disabled = false;
      if(submit.textContent === '…') submit.textContent = (loginMode === 'signin') ? 'Sign in' : 'Create account';
    }
  });

  $('signout-btn').addEventListener('click', async () => { await supa.auth.signOut(); });
}

async function onSignedIn(session){
  user = session.user;
  await loadAll();
  renderMatrixList();
  renderSessionList();
  setTab('matrices');
  showView('home');
}
function onSignedOut(){
  user = null; matrices = []; sessions = [];
  $('login-email').value = ''; $('login-password').value = '';
  showView('login');
}

/* ==========================================================================
   Tabs
   ========================================================================== */
function setTab(which){
  const tm = $('tab-matrices'), tt = $('tab-thinking');
  const pm = $('pane-matrices'), pt = $('pane-thinking');
  if(which === 'matrices'){
    tm.classList.add('on'); tt.classList.remove('on');
    pm.style.display = ''; pt.style.display = 'none';
  } else {
    tt.classList.add('on'); tm.classList.remove('on');
    pt.style.display = ''; pm.style.display = 'none';
  }
}
function setupTabs(){
  $('tab-matrices').addEventListener('click', () => setTab('matrices'));
  $('tab-thinking').addEventListener('click', () => setTab('thinking'));
}

/* shared inline-add control: a dashed button that becomes an input */
function makeInlineAdd(label, placeholder, onAdd){
  const wrap = el('div');
  const btn = el('button', 'inline-add');
  btn.type = 'button';
  btn.textContent = label;
  const form = el('div', 'inline-add-form');
  const input = el('input'); input.type = 'text'; input.placeholder = placeholder;
  const go = el('button'); go.type = 'button'; go.textContent = 'Add';
  form.appendChild(input); form.appendChild(go);
  wrap.appendChild(btn); wrap.appendChild(form);

  function open(){ btn.style.display = 'none'; form.classList.add('open'); input.focus(); }
  function close(){ form.classList.remove('open'); btn.style.display = ''; input.value = ''; }
  function submit(){ const v = input.value.trim(); if(v) onAdd(v); close(); }

  btn.addEventListener('click', open);
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if(e.key === 'Enter') submit();
    if(e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => { setTimeout(() => { if(!input.value.trim()) close(); }, 150); });
  return wrap;
}

/* ==========================================================================
   Matrices — list
   ========================================================================== */
function matrixCounts(m){
  const t = m.tasks || [];
  return { open: t.filter(x => !x.done).length, done: t.filter(x => x.done).length };
}
function renderMatrixList(){
  const box = $('matrices-content');
  box.innerHTML = '';
  if(matrices.length === 0){
    box.insertAdjacentHTML('beforeend', '<div class="empty-state">No matrices yet. Create one to get started.</div>');
  } else {
    const ul = el('ul', 'rec-list');
    matrices.forEach(m => {
      const c = matrixCounts(m);
      const li = el('li', 'rec-row');
      li.innerHTML = `
        <div class="ico">◫</div>
        <div class="main"><div class="rname"></div><div class="rstats">${c.open} open · ${c.done} done</div></div>
        <div class="row-actions"><button class="rename" aria-label="rename">✎</button><button class="delete" aria-label="delete">✕</button></div>`;
      li.querySelector('.rname').textContent = m.name;
      li.querySelector('.main').addEventListener('click', () => openMatrix(m.id));
      li.querySelector('.rename').addEventListener('click', async (e) => {
        e.stopPropagation();
        const n = prompt('Rename matrix', m.name);
        if(n && n.trim()){ await saveMatrix(m.id, { name: n.trim() }); renderMatrixList(); }
      });
      li.querySelector('.delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if(confirm(`Delete "${m.name}"? This can't be undone.`)){ await removeMatrix(m.id); renderMatrixList(); }
      });
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
  const b = el('button', 'new-btn'); b.textContent = '+ New matrix';
  b.addEventListener('click', openCreate);
  box.appendChild(b);
}

/* ---------- create ---------- */
function openCreate(){
  const i = $('new-name-input'); i.value = '';
  $('create-submit').disabled = true;
  showView('create');
  setTimeout(() => i.focus(), 50);
}
function setupCreateView(){
  const input = $('new-name-input'), submit = $('create-submit'), row = $('preset-row');
  const now = new Date();
  const presets = ['This Week', 'Week of ' + now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                   now.toLocaleDateString(undefined, { month: 'long' }), 'Today'];
  presets.forEach(p => {
    const b = el('button', 'preset-btn'); b.textContent = p;
    b.addEventListener('click', () => { input.value = p; submit.disabled = false; input.focus(); });
    row.appendChild(b);
  });
  input.addEventListener('input', () => { submit.disabled = !input.value.trim(); });
  input.addEventListener('keydown', (e) => { if(e.key === 'Enter' && input.value.trim()) submit.click(); });
  submit.addEventListener('click', async () => {
    const name = input.value.trim(); if(!name) return;
    submit.disabled = true;
    const rec = await insertMatrix(name);
    submit.disabled = false;
    if(rec) openMatrix(rec.id);
  });
  $('create-back').addEventListener('click', () => { showView('home'); setTab('matrices'); renderMatrixList(); });
}

/* ==========================================================================
   Matrices — detail (grid + list views)
   ========================================================================== */
function openMatrix(id){
  currentMatrixId = id;
  const rec = matrices.find(m => m.id === id);
  currentTasks = rec ? (rec.tasks || []) : [];
  $('matrix-title-display').textContent = rec ? rec.name : '';
  applyMatrixView();
  showView('matrix');
}
function persistTasks(){ saveMatrix(currentMatrixId, { tasks: currentTasks }); }

function setMatrixView(v){ lsSet('mm-matrix-view', v); applyMatrixView(); }
function applyMatrixView(){
  const view = getMatrixView();
  document.querySelectorAll('#matrix-view-toggle button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  $('matrix-grid-view').style.display = (view === 'grid') ? '' : 'none';
  $('matrix-list-view').style.display = (view === 'list') ? '' : 'none';
  renderGridTasks();
  if(view === 'list') renderMatrixListView();
}
function refreshMatrix(){
  renderGridTasks();
  if(getMatrixView() === 'list') renderMatrixListView();
}

function toggleTask(id){ const t = currentTasks.find(x => x.id === id); if(t){ t.done = !t.done; refreshMatrix(); persistTasks(); } }
function delTask(id){ currentTasks = currentTasks.filter(x => x.id !== id); refreshMatrix(); persistTasks(); }
function addTask(quadrant, text){
  if(!text.trim()) return;
  currentTasks.push({ id: uid('t'), text: text.trim(), quadrant, done: false });
  refreshMatrix(); persistTasks();
}

/* grid view task rendering (into the fixed #tasks-<q> lists) */
function renderGridTasks(){
  QUADS.forEach(q => {
    const ul = $('tasks-' + q); ul.innerHTML = '';
    const items = currentTasks.filter(t => t.quadrant === q);
    if(items.length === 0){ const li = el('li', 'empty'); li.textContent = 'nothing here yet'; ul.appendChild(li); }
    items.forEach(t => {
      const li = el('li', 'task' + (t.done ? ' done' : ''));
      li.innerHTML = `<div class="chk"></div><div class="txt"></div><button class="del" aria-label="delete">✕</button>`;
      li.querySelector('.txt').textContent = t.text;
      li.querySelector('.chk').addEventListener('click', () => toggleTask(t.id));
      li.querySelector('.txt').addEventListener('click', () => toggleTask(t.id));
      li.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); delTask(t.id); });
      ul.appendChild(li);
    });
  });
}

/* list view (stacked boxes in priority order) */
function renderMatrixListView(){
  const box = $('matrix-list-view'); box.innerHTML = '';
  QUADS.forEach(q => {
    const card = el('div', 'mlist m-' + q);
    const head = el('div', 'mlist-head');
    head.innerHTML = `<span class="mlist-title"></span><span class="mlist-sub">${QUAD_META[q].listSub}</span>`;
    head.querySelector('.mlist-title').textContent = QUAD_META[q].title;
    card.appendChild(head);

    const rows = el('div', 'mlist-rows');
    const items = currentTasks.filter(t => t.quadrant === q);
    if(items.length === 0){ const e = el('div', 'mlist-empty'); e.textContent = 'nothing here yet'; rows.appendChild(e); }
    items.forEach(t => {
      const row = el('div', 'mlist-row' + (t.done ? ' done' : ''));
      row.innerHTML = `<div class="chk"></div><div class="txt"></div><button class="del" aria-label="delete">✕</button>`;
      row.querySelector('.txt').textContent = t.text;
      row.querySelector('.chk').addEventListener('click', () => toggleTask(t.id));
      row.querySelector('.txt').addEventListener('click', () => toggleTask(t.id));
      row.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); delTask(t.id); });
      rows.appendChild(row);
    });
    card.appendChild(rows);
    card.appendChild(makeInlineAdd('＋ add', 'New task…', (v) => addTask(q, v)));
    box.appendChild(card);
  });
}

/* one-time grid quad add controls */
function setupQuadControls(){
  QUADS.forEach(q => {
    const quadEl = $('q-' + q);
    const btn = el('button', 'add-btn'); btn.textContent = '＋ add';
    const form = el('div', 'add-form');
    form.innerHTML = `<input type="text" placeholder="New task…" /><button>Add</button>`;
    quadEl.appendChild(btn); quadEl.appendChild(form);
    const input = form.querySelector('input'), sub = form.querySelector('button');
    btn.addEventListener('click', () => { btn.style.display = 'none'; form.classList.add('open'); input.focus(); });
    function submit(){ addTask(q, input.value); input.value = ''; form.classList.remove('open'); btn.style.display = ''; }
    sub.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if(e.key === 'Enter') submit(); if(e.key === 'Escape'){ form.classList.remove('open'); btn.style.display = ''; } });
    input.addEventListener('blur', () => { setTimeout(() => { if(!input.value.trim()){ form.classList.remove('open'); btn.style.display = ''; } }, 150); });
  });
}

function setupMatrixNav(){
  $('matrix-back').addEventListener('click', () => { showView('home'); setTab('matrices'); renderMatrixList(); });
  document.querySelectorAll('#matrix-view-toggle button').forEach(b => {
    b.addEventListener('click', () => setMatrixView(b.dataset.view));
  });
  const disp = $('matrix-title-display'), inp = $('matrix-title-input');
  disp.addEventListener('click', () => {
    inp.value = disp.textContent; disp.style.display = 'none'; inp.style.display = 'block'; inp.focus(); inp.select();
  });
  function commit(){
    const n = inp.value.trim();
    if(n){ disp.textContent = n; saveMatrix(currentMatrixId, { name: n }); }
    inp.style.display = 'none'; disp.style.display = 'block';
  }
  inp.addEventListener('keydown', (e) => { if(e.key === 'Enter') commit(); if(e.key === 'Escape'){ inp.style.display = 'none'; disp.style.display = 'block'; } });
  inp.addEventListener('blur', commit);
}

/* ==========================================================================
   Positive thinking — session list
   ========================================================================== */
function sessionCounts(s){
  const d = s.data || { thoughts: [], balances: [] };
  return {
    t: d.thoughts.filter(x => (x.text || '').trim()).length,
    b: d.balances.filter(x => (x.text || '').trim()).length
  };
}
function renderSessionList(){
  const box = $('thinking-content'); box.innerHTML = '';
  if(sessions.length === 0){
    box.insertAdjacentHTML('beforeend', '<div class="empty-state">No sessions yet. Start one when a thought needs balancing.</div>');
  } else {
    const ul = el('ul', 'rec-list');
    sessions.forEach(s => {
      const c = sessionCounts(s);
      const li = el('li', 'rec-row');
      li.innerHTML = `
        <div class="ico" style="background:var(--light-bg);color:var(--light);">✎</div>
        <div class="main"><div class="rname"></div>
          <div class="rstats">${c.t} thought${c.t === 1 ? '' : 's'} · ${c.b} positive</div></div>
        <div class="row-actions"><button class="delete" aria-label="delete">✕</button></div>`;
      li.querySelector('.rname').textContent = s.name;
      li.querySelector('.main').addEventListener('click', () => openSession(s.id));
      li.querySelector('.delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if(confirm(`Delete "${s.name}"? This can't be undone.`)){ await removeSession(s.id); renderSessionList(); }
      });
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
  const b = el('button', 'new-btn'); b.textContent = '+ New session';
  b.addEventListener('click', createSessionAndOpen);
  box.appendChild(b);
}
async function createSessionAndOpen(){
  const now = new Date();
  const name = 'Positive thinking · ' + now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const rec = await insertSession(name);
  if(rec) openSession(rec.id);
}

/* ==========================================================================
   Positive thinking — session (two independent lists + free-text summary)
   ========================================================================== */
function openSession(id){
  currentSessionId = id;
  const rec = sessions.find(s => s.id === id);
  currentData = rec ? rec.data : { thoughts: [], balances: [], summary: '' };
  $('session-title-display').textContent = rec ? rec.name : '';
  applySessionView();
  showView('session');
}
function persistSession(){ saveSessionData(currentSessionId); }

function setSessionView(v){ lsSet('mm-session-view', v); applySessionView(); }
function applySessionView(){
  const view = getSessionView();
  document.querySelectorAll('#session-view-toggle button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  renderSession();
}

function listFor(side){ return side === 'l' ? currentData.thoughts : currentData.balances; }

function renderSession(){
  const view = getSessionView();
  const body = $('session-body'); body.innerHTML = '';

  if(view === 'cols'){
    const heads = el('div', 'pt-heads');
    heads.innerHTML = '<div class="pt-head l">The thought</div><div class="pt-head r">The balance</div>';
    body.appendChild(heads);
    const cols = el('div', 'pt-cols');
    const cl = el('div', 'pt-col'), cr = el('div', 'pt-col');
    buildList('l', cl); buildList('r', cr);
    cols.appendChild(cl); cols.appendChild(cr);
    body.appendChild(cols);
  } else {
    const hl = el('div', 'pt-section-h l'); hl.textContent = 'The thought'; body.appendChild(hl);
    const sl = el('div', 'pt-stack-list'); buildList('l', sl); body.appendChild(sl);
    body.appendChild(el('div', 'pt-divide'));
    const hr = el('div', 'pt-section-h r'); hr.textContent = 'The balance'; body.appendChild(hr);
    const sr = el('div', 'pt-stack-list'); buildList('r', sr); body.appendChild(sr);
  }
  renderSummary();
}

function buildList(side, container){
  const list = listFor(side);
  list.forEach(item => container.appendChild(makeItem(side, item)));
  const label = side === 'l' ? '＋ add a thought' : '＋ add a balance';
  const ph = side === 'l' ? 'What went through your mind…' : 'Something good, big or small…';
  container.appendChild(makeInlineAdd(label, ph, (v) => {
    list.push({ id: uid(side), text: v });
    persistSession();
    renderSession();
  }));
}

function makeItem(side, item){
  const div = el('div', 'pt-item ' + side);
  div.dataset.id = item.id;
  const text = el('div', 'pt-item-text');
  if((item.text || '').trim()){ text.textContent = item.text; }
  else { text.textContent = side === 'l' ? 'What went through your mind…' : 'Something good, big or small…'; div.classList.add('placeholder'); }
  div.appendChild(text);

  const del = el('button', 'pt-del'); del.textContent = '✕'; del.setAttribute('aria-label', 'remove');
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    const list = listFor(side);
    const i = list.findIndex(x => x.id === item.id);
    if(i > -1) list.splice(i, 1);
    persistSession(); renderSession();
  });
  div.appendChild(del);

  div.addEventListener('click', (e) => {
    if(e.target === del) return;
    if(div.querySelector('textarea')) return;
    editItem(div, side, item);
  });
  return div;
}

function editItem(div, side, item){
  div.classList.remove('placeholder');
  div.querySelectorAll('.pt-item-text').forEach(n => n.remove());
  const ta = el('textarea');
  ta.value = item.text || '';
  ta.rows = 2;
  div.insertBefore(ta, div.firstChild);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);

  function commit(){
    item.text = ta.value.trim();
    const list = listFor(side);
    if(!item.text){ const i = list.findIndex(x => x.id === item.id); if(i > -1) list.splice(i, 1); }
    persistSession(); renderSession();
  }
  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => { if(e.key === 'Escape'){ ta.value = item.text || ''; ta.blur(); } });
}

function renderSummary(){
  const box = $('summary-field'); box.innerHTML = '';
  const val = (currentData.summary || '').trim();
  const text = el('div');
  if(val){ text.textContent = currentData.summary; }
  else { text.textContent = 'A line or two to carry with you…'; box.classList.add('placeholder'); }
  box.appendChild(text);
  box.onclick = (e) => {
    if(box.querySelector('textarea')) return;
    editSummary();
  };
}
function editSummary(){
  const box = $('summary-field');
  box.classList.remove('placeholder');
  box.innerHTML = '';
  const ta = el('textarea');
  ta.value = currentData.summary || '';
  ta.rows = 2;
  box.appendChild(ta);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  function commit(){ currentData.summary = ta.value.trim(); persistSession(); renderSummary(); }
  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => { if(e.key === 'Escape'){ ta.value = currentData.summary || ''; ta.blur(); } });
}

function setupSessionNav(){
  $('session-back').addEventListener('click', () => { showView('home'); setTab('thinking'); renderSessionList(); });
  document.querySelectorAll('#session-view-toggle button').forEach(b => {
    b.addEventListener('click', () => setSessionView(b.dataset.view));
  });
}

/* ==========================================================================
   Boot
   ========================================================================== */
function configMissing(){
  return !window.SUPABASE_URL || window.SUPABASE_URL.indexOf('YOUR_') === 0
      || !window.SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY.indexOf('YOUR_') === 0;
}
async function init(){
  setupTabs();
  setupCreateView();
  setupQuadControls();
  setupMatrixNav();
  setupSessionNav();
  setupLogin();

  if(configMissing()){
    $('login-error').textContent = 'Add your Supabase URL and key in config.js.';
    showView('login');
    return;
  }
  supa = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  supa.auth.onAuthStateChange((_event, session) => {
    if(session && session.user) onSignedIn(session); else onSignedOut();
  });
  const { data } = await supa.auth.getSession();
  if(data && data.session) onSignedIn(data.session); else showView('login');
}
init();
