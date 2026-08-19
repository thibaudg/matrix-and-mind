/* ==========================================================================
   Matrix & Mind — app logic
   Storage: Supabase (Postgres + Auth), one row per record, task/thought
   lists stored as JSON. Counts are computed client-side.
   ========================================================================== */

const QUADS = ['do', 'schedule', 'delegate', 'drop'];
const MAX_STARS = 4;

let supa = null;
let user = null;

// in-memory copies of the user's records
let matrices = [];   // {id, name, tasks:[{id,text,quadrant,done}], updated_at}
let sessions = [];   // {id, name, pairs:[{id,neg,pos,star}], updated_at}

let currentMatrixId = null, currentTasks = [];
let currentSessionId = null, currentPairs = [];

let loginMode = 'signin'; // or 'signup'

/* ---------- helpers ---------- */
function uid(p){ return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function $(id){ return document.getElementById(id); }

function showView(name){
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + name).classList.add('active');
  window.scrollTo(0, 0);
}

function nowISO(){ return new Date().toISOString(); }

/* ==========================================================================
   Supabase data layer
   ========================================================================== */
async function loadAll(){
  const [m, s] = await Promise.all([
    supa.from('matrices').select('*').order('updated_at', { ascending: false }),
    supa.from('sessions').select('*').order('updated_at', { ascending: false })
  ]);
  matrices = (m.data || []).map(r => ({ ...r, tasks: r.tasks || [] }));
  sessions = (s.data || []).map(r => ({ ...r, pairs: r.pairs || [] }));
}

async function insertMatrix(name){
  const { data } = await supa.from('matrices')
    .insert({ user_id: user.id, name, tasks: [] })
    .select().single();
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
  const starter = [{ id: uid('p'), neg: '', pos: '', star: false }];
  const { data } = await supa.from('sessions')
    .insert({ user_id: user.id, name, pairs: starter })
    .select().single();
  if(data){ data.pairs = data.pairs || []; sessions.unshift(data); }
  return data;
}
async function saveSession(id, patch){
  const rec = sessions.find(x => x.id === id);
  if(rec) Object.assign(rec, patch, { updated_at: nowISO() });
  await supa.from('sessions').update({ ...patch, updated_at: nowISO() }).eq('id', id);
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
    // re-bind toggle (innerHTML replaced the node)
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
      if(loginMode === 'signin'){
        res = await supa.auth.signInWithPassword({ email, password });
      } else {
        res = await supa.auth.signUp({ email, password });
      }
      if(res.error){ throw res.error; }
      if(loginMode === 'signup' && res.data && !res.data.session){
        // email confirmation is ON — no session yet
        err.style.color = 'var(--light)';
        err.textContent = 'Check your email to confirm, then sign in.';
        loginMode = 'signin';
        submit.textContent = 'Sign in';
      }
      // onAuthStateChange handles the signed-in case
    }catch(ex){
      err.style.color = 'var(--danger)';
      err.textContent = ex.message || 'Something went wrong.';
    }finally{
      submit.disabled = false;
      if(submit.textContent === '…') submit.textContent = (loginMode === 'signin') ? 'Sign in' : 'Create account';
    }
  });

  $('signout-btn').addEventListener('click', async () => {
    await supa.auth.signOut();
  });
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
  user = null;
  matrices = []; sessions = [];
  $('login-email').value = '';
  $('login-password').value = '';
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
    box.insertAdjacentHTML('beforeend',
      '<div class="empty-state">No matrices yet. Create one to get started.</div>');
  } else {
    const ul = document.createElement('ul');
    ul.className = 'rec-list';
    matrices.forEach(m => {
      const c = matrixCounts(m);
      const li = document.createElement('li');
      li.className = 'rec-row';
      li.innerHTML = `
        <div class="ico">◫</div>
        <div class="main">
          <div class="rname"></div>
          <div class="rstats">${c.open} open · ${c.done} done</div>
        </div>
        <div class="row-actions">
          <button class="rename" aria-label="rename">✎</button>
          <button class="delete" aria-label="delete">✕</button>
        </div>`;
      li.querySelector('.rname').textContent = m.name;
      li.querySelector('.main').addEventListener('click', () => openMatrix(m.id));
      li.querySelector('.rename').addEventListener('click', async (e) => {
        e.stopPropagation();
        const n = prompt('Rename matrix', m.name);
        if(n && n.trim()){ await saveMatrix(m.id, { name: n.trim() }); renderMatrixList(); }
      });
      li.querySelector('.delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if(confirm(`Delete "${m.name}"? This can't be undone.`)){
          await removeMatrix(m.id);
          renderMatrixList();
        }
      });
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  const b = document.createElement('button');
  b.className = 'new-btn';
  b.textContent = '+ New matrix';
  b.addEventListener('click', openCreate);
  box.appendChild(b);
}

/* ==========================================================================
   Matrices — create
   ========================================================================== */
function openCreate(){
  const i = $('new-name-input');
  i.value = '';
  $('create-submit').disabled = true;
  showView('create');
  setTimeout(() => i.focus(), 50);
}

function setupCreateView(){
  const input = $('new-name-input');
  const submit = $('create-submit');
  const row = $('preset-row');

  const now = new Date();
  const presets = [
    'This Week',
    'Week of ' + now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    now.toLocaleDateString(undefined, { month: 'long' }),
    'Today'
  ];
  presets.forEach(p => {
    const b = document.createElement('button');
    b.className = 'preset-btn';
    b.textContent = p;
    b.addEventListener('click', () => { input.value = p; submit.disabled = false; input.focus(); });
    row.appendChild(b);
  });

  input.addEventListener('input', () => { submit.disabled = !input.value.trim(); });
  input.addEventListener('keydown', (e) => { if(e.key === 'Enter' && input.value.trim()) submit.click(); });

  submit.addEventListener('click', async () => {
    const name = input.value.trim();
    if(!name) return;
    submit.disabled = true;
    const rec = await insertMatrix(name);
    submit.disabled = false;
    if(rec) openMatrix(rec.id);
  });

  $('create-back').addEventListener('click', () => {
    showView('home'); setTab('matrices'); renderMatrixList();
  });
}

/* ==========================================================================
   Matrices — detail
   ========================================================================== */
function openMatrix(id){
  currentMatrixId = id;
  const rec = matrices.find(m => m.id === id);
  currentTasks = rec ? (rec.tasks || []) : [];
  $('matrix-title-display').textContent = rec ? rec.name : '';
  renderTasks();
  showView('matrix');
}

function persistTasks(){
  saveMatrix(currentMatrixId, { tasks: currentTasks });
}

function renderTasks(){
  QUADS.forEach(q => {
    const ul = $('tasks-' + q);
    ul.innerHTML = '';
    const items = currentTasks.filter(t => t.quadrant === q);
    if(items.length === 0){
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'nothing here yet';
      ul.appendChild(li);
    }
    items.forEach(t => {
      const li = document.createElement('li');
      li.className = 'task' + (t.done ? ' done' : '');
      li.innerHTML = `<div class="chk"></div><div class="txt"></div><button class="del" aria-label="delete">✕</button>`;
      li.querySelector('.txt').textContent = t.text;
      li.querySelector('.chk').addEventListener('click', () => toggleTask(t.id));
      li.querySelector('.txt').addEventListener('click', () => toggleTask(t.id));
      li.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); delTask(t.id); });
      ul.appendChild(li);
    });
  });
}

function toggleTask(id){
  const t = currentTasks.find(x => x.id === id);
  if(t){ t.done = !t.done; renderTasks(); persistTasks(); }
}
function delTask(id){
  currentTasks = currentTasks.filter(x => x.id !== id);
  renderTasks(); persistTasks();
}
function addTask(quadrant, text){
  if(!text.trim()) return;
  currentTasks.push({ id: uid('t'), text: text.trim(), quadrant, done: false });
  renderTasks(); persistTasks();
}

function setupQuadControls(){
  QUADS.forEach(q => {
    const quadEl = $('q-' + q);
    const btn = document.createElement('button');
    btn.className = 'add-btn';
    btn.textContent = '＋ add';
    const form = document.createElement('div');
    form.className = 'add-form';
    form.innerHTML = `<input type="text" placeholder="New task…" /><button>Add</button>`;
    quadEl.appendChild(btn); quadEl.appendChild(form);

    const input = form.querySelector('input');
    const sub = form.querySelector('button');

    btn.addEventListener('click', () => { btn.style.display = 'none'; form.classList.add('open'); input.focus(); });
    function submit(){
      addTask(q, input.value); input.value = '';
      form.classList.remove('open'); btn.style.display = '';
    }
    sub.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if(e.key === 'Enter') submit();
      if(e.key === 'Escape'){ form.classList.remove('open'); btn.style.display = ''; }
    });
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if(!input.value.trim()){ form.classList.remove('open'); btn.style.display = ''; }
      }, 150);
    });
  });
}

function setupMatrixNav(){
  $('matrix-back').addEventListener('click', () => {
    showView('home'); setTab('matrices'); renderMatrixList();
  });
  const disp = $('matrix-title-display');
  const inp = $('matrix-title-input');

  disp.addEventListener('click', () => {
    inp.value = disp.textContent;
    disp.style.display = 'none'; inp.style.display = 'block';
    inp.focus(); inp.select();
  });
  function commit(){
    const n = inp.value.trim();
    if(n){
      disp.textContent = n;
      saveMatrix(currentMatrixId, { name: n });
    }
    inp.style.display = 'none'; disp.style.display = 'block';
  }
  inp.addEventListener('keydown', (e) => {
    if(e.key === 'Enter') commit();
    if(e.key === 'Escape'){ inp.style.display = 'none'; disp.style.display = 'block'; }
  });
  inp.addEventListener('blur', commit);
}

/* ==========================================================================
   Positive thinking — list
   ========================================================================== */
function sessionCounts(s){
  const p = s.pairs || [];
  return {
    thoughts: p.filter(x => (x.neg || '').trim() || (x.pos || '').trim()).length,
    kept: p.filter(x => x.star && (x.pos || '').trim()).length
  };
}

function renderSessionList(){
  const box = $('thinking-content');
  box.innerHTML = '';

  if(sessions.length === 0){
    box.insertAdjacentHTML('beforeend',
      '<div class="empty-state">No sessions yet. Start one when a thought needs balancing.</div>');
  } else {
    const ul = document.createElement('ul');
    ul.className = 'rec-list';
    sessions.forEach(s => {
      const c = sessionCounts(s);
      const li = document.createElement('li');
      li.className = 'rec-row';
      li.innerHTML = `
        <div class="ico" style="background:var(--light-bg);color:var(--light);">✎</div>
        <div class="main">
          <div class="rname"></div>
          <div class="rstats">${c.thoughts} thought${c.thoughts === 1 ? '' : 's'} · ${c.kept} kept</div>
        </div>
        <div class="row-actions">
          <button class="delete" aria-label="delete">✕</button>
        </div>`;
      li.querySelector('.rname').textContent = s.name;
      li.querySelector('.main').addEventListener('click', () => openSession(s.id));
      li.querySelector('.delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if(confirm(`Delete "${s.name}"? This can't be undone.`)){
          await removeSession(s.id);
          renderSessionList();
        }
      });
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  const b = document.createElement('button');
  b.className = 'new-btn';
  b.textContent = '+ New session';
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
   Positive thinking — session
   ========================================================================== */
function openSession(id){
  currentSessionId = id;
  const rec = sessions.find(s => s.id === id);
  currentPairs = rec ? (rec.pairs || []) : [];
  if(currentPairs.length === 0) currentPairs.push({ id: uid('p'), neg: '', pos: '', star: false });
  $('session-title-display').textContent = rec ? rec.name : '';
  renderPairs();
  showView('session');
}

function persistPairs(){
  saveSession(currentSessionId, { pairs: currentPairs });
}

function starCount(){
  return currentPairs.filter(p => p.star && (p.pos || '').trim()).length;
}

function renderPairs(){
  const ul = $('pairs');
  ul.innerHTML = '';

  currentPairs.forEach(p => {
    const li = document.createElement('li');
    li.className = 'pair';

    const left = makeCell(p, 'neg', 'What went through your mind…');
    const right = makeCell(p, 'pos', 'A fairer way to see it…');

    const star = document.createElement('button');
    star.className = 'star' + (p.star ? ' on' : '');
    star.textContent = p.star ? '★' : '☆';
    star.setAttribute('aria-label', 'keep this thought');
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      if(!(p.pos || '').trim()) return;
      if(!p.star && starCount() >= MAX_STARS) return;
      p.star = !p.star;
      persistPairs();
      renderPairs();
    });
    right.appendChild(star);

    const del = document.createElement('button');
    del.className = 'pair-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'remove this pair');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      currentPairs = currentPairs.filter(x => x.id !== p.id);
      if(currentPairs.length === 0) currentPairs.push({ id: uid('p'), neg: '', pos: '', star: false });
      persistPairs();
      renderPairs();
    });
    left.appendChild(del);

    li.appendChild(left);
    li.appendChild(right);
    ul.appendChild(li);
  });

  renderTakeaways();
}

function makeCell(pair, field, placeholder){
  const div = document.createElement('div');
  div.className = 'cell ' + (field === 'neg' ? 'l' : 'r');
  const value = pair[field] || '';

  const text = document.createElement('div');
  if(value.trim()){
    text.textContent = value;
  } else {
    text.textContent = placeholder;
    div.classList.add('placeholder');
  }
  div.appendChild(text);

  div.addEventListener('click', (e) => {
    if(e.target.classList.contains('star') || e.target.classList.contains('pair-del')) return;
    if(div.querySelector('textarea')) return;
    editCell(div, pair, field, placeholder);
  });

  return div;
}

function editCell(div, pair, field, placeholder){
  div.classList.remove('placeholder');
  div.querySelectorAll('div').forEach(n => n.remove());

  const ta = document.createElement('textarea');
  ta.value = pair[field] || '';
  ta.placeholder = placeholder;
  ta.rows = 3;
  div.insertBefore(ta, div.firstChild);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  function commit(){
    pair[field] = ta.value.trim();
    if(field === 'pos' && !pair.pos) pair.star = false;
    persistPairs();
    renderPairs();
  }
  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => {
    if(e.key === 'Escape'){ ta.value = pair[field] || ''; ta.blur(); }
  });
}

function renderTakeaways(){
  const box = $('takeaways-body');
  box.innerHTML = '';
  const kept = currentPairs.filter(p => p.star && (p.pos || '').trim());

  if(kept.length === 0){
    const p = document.createElement('p');
    p.className = 'none';
    p.textContent = 'Nothing starred yet. Tap ☆ on a balancing thought to add it here.';
    box.appendChild(p);
    return;
  }
  const ol = document.createElement('ol');
  kept.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.pos;
    ol.appendChild(li);
  });
  box.appendChild(ol);
}

function setupSessionNav(){
  $('session-back').addEventListener('click', () => {
    showView('home'); setTab('thinking'); renderSessionList();
  });
  $('add-pair').addEventListener('click', () => {
    currentPairs.push({ id: uid('p'), neg: '', pos: '', star: false });
    persistPairs();
    renderPairs();
  });
}

/* ==========================================================================
   Tabs wiring + boot
   ========================================================================== */
function setupTabs(){
  $('tab-matrices').addEventListener('click', () => setTab('matrices'));
  $('tab-thinking').addEventListener('click', () => setTab('thinking'));
}

function configMissing(){
  return !window.SUPABASE_URL || window.SUPABASE_URL.indexOf('YOUR_') === 0
      || !window.SUPABASE_ANON_KEY || window.SUPABASE_ANON_KEY.indexOf('YOUR_') === 0;
}

async function init(){
  // static setup that doesn't depend on auth
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
    if(session && session.user){ onSignedIn(session); }
    else { onSignedOut(); }
  });

  const { data } = await supa.auth.getSession();
  if(data && data.session){ onSignedIn(data.session); }
  else { showView('login'); }
}

init();
