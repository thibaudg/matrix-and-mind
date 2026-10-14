/* ==========================================================================
   Tone Anchoring — app logic (v2)
   Data: Supabase schema `tones` (entries, inbox, history, cards, reviews, settings;
   views repo_stats, review_stats; rpc undo_change).
   Without Supabase keys in config.js the app runs in demo mode on sample data.
   ========================================================================== */

const TONE_NAME = { 1: 'flat', 2: 'rising', 3: 'dip-rise', 4: 'falling', 5: 'neutral' };
const GROUPS = [['tone', 'Tone'], ['radical', 'Radical'], ['hsk', 'HSK level'], ['date', 'Date added'], ['none', 'None']];
const SORTS = [['pinyin', 'Pinyin A–Z'], ['recent', 'Recently changed']];
const NEW_PER_DAY_OPTIONS = [5, 10, 15, 20];
const OUTSIDE_HC = 'outside-hc';
const DEMO = !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY || /[?&]demo\b/.test(location.search);

const state = {
  entries: [], inbox: [], loaded: false, lastLoad: 0,
  filter: 'all', q: '',
  openInboxId: null, editInboxId: null, showProcessed: false,
  addRef: null,
  openChangeId: null,
  prefs: { group: 'tone', sort: 'pinyin', tones: [1, 2, 3, 4, 5] },
  // v2
  view: 'main', entryId: null, editEntry: false, mainScroll: 0, historyFor: null,
  cards: new Map(), rstats: new Map(), reviewsToday: [], newPerDay: 10, reviewReady: true,
  session: null,
};
let api = null;
let currentUserId = null;
let scheduler = null;

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
function el(tag, cls, text){ const e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
function norm(s){ return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }
function toneOf(e){ return (e.tones && e.tones[0]) || 5; }
function toneLabel(t){ return t === 5 ? 'Neutral tone' : `Tone ${t} · ${TONE_NAME[t]}`; }
function toneShort(e){ return e.kind === 'word' ? Pinyin.toneText(e.tones) : (toneOf(e) === 5 ? 'neutral' : `${toneOf(e)} ${TONE_NAME[toneOf(e)]}`); }
function lsGet(k, d){ try{ const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }catch(e){ return d; } }
function lsSet(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
function toast(msg, action){
  const t = $('toast'); t.replaceChildren(el('span', null, msg));
  t.classList.toggle('has-action', !!action);
  if(action){
    const b = el('button', 'toast-act', action.label);
    b.onclick = () => { t.classList.remove('on'); action.fn(); };
    t.appendChild(b);
  }
  t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), action ? 4000 : 2200);
}
function fail(ex){ console.error(ex); toast((ex && ex.message) ? `Couldn't save: ${ex.message}` : "Something went wrong. Try again."); }
function dayStart(d = new Date()){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function when(iso){
  const d = new Date(iso), now = new Date();
  const diff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if(diff === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if(diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function dayLabel(iso){
  const d = new Date(iso), now = new Date();
  const diff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if(diff === 0) return 'Today';
  if(diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
function shortDate(iso){ return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }); }
function snippet(s, n = 60){ s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function span(ms){ // 10 min · 5 h · 3 d · 2 mo
  const m = Math.max(1, Math.round(ms / 60000));
  if(m < 60) return `${m} min`;
  const h = Math.round(m / 60); if(h < 24) return `${h} h`;
  const d = Math.round(h / 24); if(d < 45) return `${d} d`;
  const mo = Math.round(d / 30); return mo < 18 ? `${mo} mo` : `${Math.round(d / 365)} y`;
}
function entryById(id){ return state.entries.find(e => e.id === id); }
function isOutsideHc(e){ return (e.tags || []).includes(OUTSIDE_HC); }

/* ==========================================================================
   Data layer
   ========================================================================== */
function supabaseApi(){
  // Tables live in the `tones` schema of the Matrix & Mind project
  const supa = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, { db: { schema: 'tones' } });
  const chk = (r) => { if(r.error) throw r.error; return r.data; };
  return {
    supa,
    async entries(){ return chk(await supa.from('entries').select('*').order('pinyin_plain')); },
    async inbox(){ return chk(await supa.from('inbox').select('*').order('created_at', { ascending: false })); },
    async stats(){ return chk(await supa.from('repo_stats').select('*').single()); },
    async history(limit = 150){ return chk(await supa.from('history').select('*').order('changed_at', { ascending: false }).limit(limit)); },
    async historyFor(rowId){ return chk(await supa.from('history').select('*').eq('row_id', rowId).order('changed_at', { ascending: false }).limit(100)); },
    async updateEntry(id, patch){ return chk(await supa.from('entries').update(patch).eq('id', id).select().single()); },
    async addInbox(body, aboutId, notHc){ return chk(await supa.from('inbox').insert({ body, about_entry_id: aboutId || null, not_hc: !!notHc }).select().single()); },
    async updateInbox(id, body){ return chk(await supa.from('inbox').update({ body }).eq('id', id).eq('status', 'pending').select().single()); },
    async deleteInbox(id){ chk(await supa.from('inbox').delete().eq('id', id)); },
    async undo(historyId){ chk(await supa.rpc('undo_change', { p_history_id: historyId })); },
    // v2 · review
    async reviewData(sinceIso){
      const [cards, rstats, today, settings] = await Promise.all([
        supa.from('cards').select('*'),
        supa.from('review_stats').select('*'),
        supa.from('reviews').select('entry_id, was_new, reviewed_at').gte('reviewed_at', sinceIso),
        supa.from('settings').select('*'),
      ]);
      return { cards: chk(cards), rstats: chk(rstats), today: chk(today), settings: chk(settings) };
    },
    async saveCard(row){ return chk(await supa.from('cards').upsert(row, { onConflict: 'entry_id' }).select().single()); },
    async addReview(row){ return chk(await supa.from('reviews').insert(row).select().single()); },
    async setSetting(key, value){ chk(await supa.from('settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })); },
    async exportAll(){
      const [entries, inbox, cards, reviews] = await Promise.all([
        supa.from('entries').select('*'), supa.from('inbox').select('*'),
        supa.from('cards').select('*'), supa.from('reviews').select('*').order('reviewed_at'),
      ]);
      return { entries: chk(entries), inbox: chk(inbox), cards: cards.error ? [] : cards.data, reviews: reviews.error ? [] : reviews.data };
    },
  };
}

function demoApi(){
  const now = Date.now(), day = 86400000, min = 60000;
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  let n = 0; const id = () => 'demo-' + (++n);
  const E = (kind, hanzi, pinyin, tones, meaning, scene, extra = {}, age = 30) => ({
    id: id(), kind, hanzi, pinyin, tones, meaning, scene,
    pinyin_plain: norm(pinyin).replace(/ü/g, 'u'),
    components: null, radical: null, hsk_level: null, collision_guard: null, tags: [], status: 'locked', notes: null,
    created_at: iso(age * day), updated_at: iso(age * day), ...extra,
  });
  const entries = [
    E('character', '紧', 'jǐn', [3], 'tight / firm / urgent', 'Sample story: pulling a knot tight. You yank the rope ends downward (the dip), and the loop snaps tight, pulling everything taut and upward (the rise).', { components: '又 (hand) over 糸 (silk thread): hand pulling thread tight', radical: '糸', tags: [OUTSIDE_HC] }, 3),
    E('character', '等', 'děng', [3], 'wait', 'Sample story: at the tram stop you dip to read the timetable, then rise onto your toes to look down the line, again and again.', { radical: '⺮', hsk_level: 2 }, 70),
    E('character', '读', 'dú', [2], 'to read', 'Sample story: at the blackboard, your voice rises line by line as you read aloud.', { components: '讠 (speech) + 卖', radical: '讠', hsk_level: 1, collision_guard: 'Also at the blackboard: 孩. 读 is the rising voice, 孩 is the child.' }, 90),
    E('character', '进', 'jìn', [4], 'to enter', 'Sample story: you stride through the doorway and drop your bag on the floor with a thud.', { components: '辶 (walk) + 井', radical: '辶', hsk_level: 2 }, 40),
    E('character', '今', 'jīn', [1], 'today, now', 'Sample story: a flat horizon at dawn, the line of today stretching out evenly.', { radical: '人', hsk_level: 1 }, 12),
    E('character', '经', 'jīng', [1], 'to pass through', 'Sample story: a long flat conveyor belt carries everything past you.', { radical: '纟', hsk_level: 2 }, 120),
    E('character', '知', 'zhī', [1], 'to know', 'Sample story: an arrow flies level and straight to the mouth: you just know.', { components: '矢 (arrow) + 口 (mouth)', radical: '矢', hsk_level: 1 }, 110),
    E('character', '的', 'de', [5], 'possessive particle', 'Sample story: dust settling softly on a shelf.', { radical: '白', hsk_level: 1, status: 'needs_rebuild' }, 150),
    E('character', '觉', 'jué', [2], 'feel, sense, realize', 'Sample story: looking up because you became aware there\'s something on the roof.', { radical: '见', hsk_level: 1, notes: 'jiào in 睡觉, jué in 觉得 / 感觉' }, 100),
    E('character', '觉', 'jiào', [4], 'sleep', 'Sample story: eyelids drop shut.', { radical: '见', hsk_level: 1, notes: 'jiào in 睡觉, jué in 觉得 / 感觉' }, 99),
    E('character', '睡', 'shuì', [4], 'sleep', 'Sample story: you fall back onto the bed.', { radical: '目', hsk_level: 1 }, 98),
    E('word', '声音', 'shēngyīn', [1, 1], 'sound / voice', 'Sample story: two different flats side by side, the dial tone for 声, then the lingering bell hum for 音.', {}, 50),
    E('word', '时候', 'shíhou', [2, 5], 'time, moment', 'Sample story: the clock hand sweeps up to the hour, then 候 settles quietly.', { hsk_level: 1 }, 45),
    E('word', '睡觉', 'shuìjiào', [4, 4], 'sleep', 'Sample story: two drops, onto the bed and into sleep.', { hsk_level: 1 }, 97),
  ];
  const byH = (h, p) => entries.find(e => e.hanzi === h && (!p || e.pinyin === p));
  const inbox = [
    { id: id(), body: '视 vs 看: when do I use which?', status: 'pending', about_entry_id: null, not_hc: false, result_note: null, entry_ids: [], created_at: iso(2 * 3600000), processed_at: null },
    { id: id(), body: '绳 shéng, rope. Saw it on a sign at the climbing gym.', status: 'pending', about_entry_id: null, not_hc: true, result_note: null, entry_ids: [], created_at: iso(3600000), processed_at: null },
    { id: id(), body: "The knot doesn't fire anymore. Try something with a belt being pulled tight.", status: 'pending', about_entry_id: entries[0].id, not_hc: false, result_note: null, entry_ids: [], created_at: iso(day + 7200000), processed_at: null },
    { id: id(), body: '等 feels like 4-then-2', status: 'processed', about_entry_id: null, not_hc: false, result_note: 'Updated 等 · scene', entry_ids: [entries[1].id], created_at: iso(4 * day), processed_at: iso(3 * day) },
  ];
  // review state: a few cards due, one flagged, some history
  const card = (e, o) => ({ entry_id: e.id, due: iso(0), stability: 3, difficulty: 5, elapsed_days: 3, scheduled_days: 3, learning_steps: 0, reps: 3, lapses: 0, state: 2, last_review: iso(3 * day), flagged_at: null, ...o });
  const cards = [
    card(byH('等'), { due: iso(2 * 3600000), lapses: 1 }),
    card(byH('读'), { due: iso(day) }),
    card(byH('知'), { due: new Date(now + 3 * day).toISOString() }),
    card(byH('睡'), { due: new Date(now + 5 * day).toISOString() }),
    card(byH('觉', 'jiào'), { due: new Date(now + 2 * day).toISOString() }),
    card(byH('进'), { due: new Date(now + 6 * day).toISOString(), flagged_at: iso(10 * min) }),
  ];
  const reviews = [];
  let rid = 0;
  const rv = (e, ago, answer, r, t, m, rating) => reviews.push({ id: ++rid, entry_id: e.id, reviewed_at: iso(ago), answer, reading_ok: r, tone_ok: t, meaning_ok: m, rating, was_new: false, was_flagged: false, seconds: 6 });
  rv(byH('等'), 3 * day, 'deng2', true, false, true, 1); rv(byH('等'), 6 * day, 'deng3', true, true, true, 3);
  rv(byH('读'), 4 * day, 'du2', true, true, true, 3); rv(byH('知'), 2 * day, 'zhi1', true, true, false, 2);
  const settings = [{ key: 'new_per_day', value: 10 }];

  let hid = 0;
  const history = [];
  const log = (table, row, action, before, after, source = 'app', at = new Date().toISOString()) =>
    history.unshift({ id: ++hid, table_name: table, row_id: row, action, before: before ? { ...before } : null, after: after ? { ...after } : null, source, changed_at: at });
  log('entries', entries[1].id, 'update', { ...entries[1], scene: 'Sample story: an older version of the 等 scene.' }, entries[1], 'claude', iso(3 * day));
  log('entries', entries[0].id, 'update', { ...entries[0], components: '又 + 糸' }, entries[0], 'app', iso(3 * 3600000));
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const delay = (v) => new Promise((r) => setTimeout(() => r(clone(v)), 40));
  const stats = () => {
    const m = new Map();
    for(const r of [...reviews].sort((a, b) => b.reviewed_at.localeCompare(a.reviewed_at))){
      if(!m.has(r.entry_id)) m.set(r.entry_id, { entry_id: r.entry_id, reviews: 0, tone_misses: 0, reading_misses: 0, meaning_misses: 0, last_reviewed: r.reviewed_at, last_answer: r.answer, last_reading_ok: r.reading_ok, last_tone_ok: r.tone_ok, last_meaning_ok: r.meaning_ok });
      const s = m.get(r.entry_id); s.reviews++;
      if(r.tone_ok === false) s.tone_misses++; if(r.reading_ok === false) s.reading_misses++; if(r.meaning_ok === false) s.meaning_misses++;
    }
    return [...m.values()];
  };
  return {
    async entries(){ return delay(entries); },
    async inbox(){ return delay(inbox); },
    async stats(){
      const ch = entries.filter(e => e.kind === 'character');
      return delay({ characters: new Set(ch.map(e => e.hanzi)).size, readings: ch.length, words: entries.length - ch.length, needs_rebuild: entries.filter(e => e.status === 'needs_rebuild').length });
    },
    async history(){ return delay(history); },
    async historyFor(rowId){ return delay(history.filter(h => h.row_id === rowId)); },
    async updateEntry(eid, patch){
      const e = entries.find(x => x.id === eid); const before = { ...e };
      Object.assign(e, patch, { updated_at: new Date().toISOString() }); log('entries', eid, 'update', before, e); return delay(e);
    },
    async addInbox(body, aboutId, notHc){
      const it = { id: id(), body, status: 'pending', about_entry_id: aboutId || null, not_hc: !!notHc, result_note: null, entry_ids: [], created_at: new Date().toISOString(), processed_at: null };
      inbox.unshift(it); log('inbox', it.id, 'insert', null, it); return delay(it);
    },
    async updateInbox(iid, body){ const it = inbox.find(x => x.id === iid); const before = { ...it }; it.body = body; log('inbox', iid, 'update', before, it); return delay(it); },
    async deleteInbox(iid){ const i = inbox.findIndex(x => x.id === iid); log('inbox', iid, 'delete', inbox[i], null); inbox.splice(i, 1); return delay(null); },
    async undo(hidToUndo){
      const h = history.find(x => x.id === hidToUndo);
      if(!h || h.table_name !== 'entries') throw new Error('Undo is only available for entries');
      const i = entries.findIndex(x => x.id === h.row_id);
      if(h.action === 'insert'){ log('entries', h.row_id, 'delete', entries[i], null); entries.splice(i, 1); }
      else if(i >= 0){ const before = { ...entries[i] }; Object.assign(entries[i], h.before); log('entries', h.row_id, 'update', before, entries[i]); }
      else { entries.push({ ...h.before }); log('entries', h.row_id, 'insert', null, h.before); }
      return delay(null);
    },
    async reviewData(sinceIso){
      return delay({ cards, rstats: stats(), today: reviews.filter(r => r.reviewed_at >= sinceIso), settings });
    },
    async saveCard(row){
      let c = cards.find(x => x.entry_id === row.entry_id);
      if(!c){ c = { entry_id: row.entry_id, due: new Date().toISOString(), stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0, last_review: null, flagged_at: null }; cards.push(c); }
      Object.assign(c, row); return delay(c);
    },
    async addReview(row){ const r = { id: ++rid, reviewed_at: new Date().toISOString(), ...row }; reviews.push(r); return delay(r); },
    async setSetting(key, value){ const s = settings.find(x => x.key === key); if(s) s.value = value; else settings.push({ key, value }); return delay(null); },
    async exportAll(){ return delay({ entries, inbox, cards, reviews }); },
  };
}

/* ==========================================================================
   Loading
   ========================================================================== */
async function loadAll(){
  try{
    const [entries, inbox] = await Promise.all([api.entries(), api.inbox()]);
    state.entries = entries.map(e => ({ ...e, _plain: norm(e.pinyin_plain || e.pinyin).replace(/ /g, '') }));
    state.inbox = inbox;
    state.loaded = true; state.lastLoad = Date.now();
    await loadReview();
    renderCurrent();
  }catch(ex){
    console.error(ex);
    $('list').replaceChildren(el('div', 'empty', `Couldn't load your repository. ${ex.message || ''}`));
  }
}

// Review data is loaded separately so the app keeps working before schema_v2.sql is run.
async function loadReview(){
  try{
    const d = await api.reviewData(dayStart().toISOString());
    state.cards = new Map(d.cards.map(c => [c.entry_id, c]));
    state.rstats = new Map(d.rstats.map(s => [s.entry_id, s]));
    state.reviewsToday = d.today;
    const s = d.settings.find(x => x.key === 'new_per_day');
    if(s) state.newPerDay = +s.value || 10;
    state.reviewReady = true;
  }catch(ex){
    console.warn('Review data unavailable (run schema_v2.sql?)', ex);
    state.reviewReady = false;
  }
  updateBadge();
}

function renderCurrent(){
  if(state.view === 'entry') renderEntry();
  else if(state.view === 'main') render();
}

/* ==========================================================================
   Search, filter, group
   ========================================================================== */
function parseQuery(){
  const raw = state.q.trim();
  const q = norm(raw);
  const m = q.match(/^([a-z]+)([1-5])$/);   // "jin3" = pinyin + tone
  return { raw, q, compact: q.replace(/ /g, ''), py: m ? m[1] : null, tone: m ? +m[2] : null };
}
function entryMatches(e, Q){
  if(!Q.q) return true;
  if(Q.py) return e._plain.includes(Q.py) && e.tones.includes(Q.tone);
  if(e.hanzi.includes(Q.raw)) return true;
  if(e._plain.includes(Q.compact)) return true;
  const hay = norm([e.meaning, e.components, e.scene, e.notes, e.radical, (e.tags || []).join(' ')].join(' '));
  return hay.includes(Q.q);
}
function inboxMatches(it, Q){
  if(!Q.q) return true;
  return it.body.includes(Q.raw) || norm(it.body).includes(Q.q);
}
function toneAllowed(e){
  const set = state.prefs.tones;
  if(set.length === 5) return true;
  return e.kind === 'character' ? set.includes(toneOf(e)) : e.tones.some(t => set.includes(t));
}
function sortEntries(list){
  const s = state.prefs.sort;
  return list.sort((a, b) => s === 'recent'
    ? (b.updated_at || '').localeCompare(a.updated_at || '')
    : a._plain.localeCompare(b._plain) || toneOf(a) - toneOf(b) || a.hanzi.localeCompare(b.hanzi));
}
function groupEntries(list){
  const g = state.prefs.group;
  const map = new Map();
  const put = (key, label, order, e) => { if(!map.has(key)) map.set(key, { label, order, items: [] }); map.get(key).items.push(e); };
  for(const e of list){
    if(g === 'none') put('all', '', 0, e);
    else if(g === 'tone') e.kind === 'word' ? put('w', 'Words', 99, e) : put('t' + toneOf(e), toneLabel(toneOf(e)), toneOf(e), e);
    else if(g === 'radical') e.kind === 'word' ? put('w', 'Words', '￿', e) : put('r' + (e.radical || ''), e.radical ? `Radical ${e.radical}` : 'No radical yet', e.radical || '￾', e);
    else if(g === 'hsk') e.hsk_level ? put('h' + e.hsk_level, `HSK ${e.hsk_level}`, e.hsk_level, e) : put('h0', 'Beyond HSK 2 / not set', 99, e);
    else if(g === 'date'){
      const d = new Date(e.created_at);
      const key = d.getFullYear() * 100 + d.getMonth();
      put('d' + key, d.toLocaleDateString([], { month: 'long', year: 'numeric' }), -key, e);
    }
  }
  return [...map.values()].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .map(sec => ({ ...sec, items: sortEntries(sec.items) }));
}

/* ==========================================================================
   Rendering — main list
   ========================================================================== */
function render(){
  if(!state.loaded) return;
  const pending = state.inbox.filter(i => i.status === 'pending');
  $('sort-btn').classList.toggle('active', state.prefs.group !== 'tone' || state.prefs.sort !== 'pinyin' || state.prefs.tones.length !== 5);
  document.querySelectorAll('#filter button').forEach(b => b.classList.toggle('on', b.dataset.f === state.filter));

  const Q = parseQuery();
  const searching = !!Q.q;
  const out = [];

  if(state.filter === 'all' || state.filter === 'inbox'){
    const pend = pending.filter(i => inboxMatches(i, Q));
    if(pend.length || state.filter === 'inbox'){
      out.push(secHead(state.filter === 'inbox' ? 'Pending' : 'Inbox', pend.length));
      out.push(pend.length ? panel(pend.map(inboxRow)) : el('div', 'empty', searching ? 'No inbox items match.' : 'Inbox is empty. Tap ＋ to capture something for Claude.'));
    }
    if(state.filter === 'inbox'){
      const done = state.inbox.filter(i => i.status !== 'pending' && inboxMatches(i, Q));
      if(done.length){
        const h = secHead('Processed', null);
        const tg = el('button', 'toggle', `${done.length} ${state.showProcessed ? '▴' : '▾'}`);
        tg.onclick = () => { state.showProcessed = !state.showProcessed; render(); };
        h.appendChild(tg); out.push(h);
        if(state.showProcessed) out.push(panel(done.map(inboxRow)));
      }
    }
  }

  if(state.filter !== 'inbox'){
    const kinds = state.filter === 'char' ? ['character'] : state.filter === 'word' ? ['word'] : ['character', 'word'];
    const matches = state.entries.filter(e => kinds.includes(e.kind) && toneAllowed(e) && entryMatches(e, Q));
    for(const sec of groupEntries(matches)){
      if(sec.label) out.push(secHead(sec.label, sec.items.length));
      else out.push(el('div', 'sec-h'));
      out.push(panel(sec.items.map(e => entryRow(e))));
    }
    if(!matches.length){
      if(searching) out.push(el('div', 'empty', `Nothing matches “${Q.raw}”. Tap ＋ to add it to the inbox for Claude.`));
      else if(!state.entries.length) out.push(el('div', 'empty', DEMO ? 'No entries.' : 'No entries yet. If you expected your repository here, check that your account is in the tones.owners table (README, step 3).'));
      else out.push(el('div', 'empty', 'No entries with these filters. Check the tone filter in Sort and group.'));
    }
  }
  $('list').replaceChildren(...out);
}

function secHead(label, count){
  const h = el('div', 'sec-h');
  h.appendChild(el('span', null, label));
  if(count != null) h.appendChild(el('span', null, String(count)));
  return h;
}
function panel(children){ const p = el('div', 'panel'); p.append(...children); return p; }

function tilesFor(e, cls = 'tile'){
  const wrap = el('div', 'tiles');
  [...e.hanzi].forEach((ch, i) => {
    const t = e.kind === 'word' ? (e.tones[i] || e.tones[0] || 5) : toneOf(e);
    wrap.appendChild(el('div', `${cls} t${t}`, ch));
  });
  return wrap;
}

function entryRow(e){
  const row = el('div', `row t${toneOf(e)}`);
  row.dataset.id = e.id;
  const hd = el('div', 'hd');
  hd.appendChild(tilesFor(e));
  const head = el('div', 'head');
  head.append(el('span', 'py', e.pinyin), document.createTextNode(' '), el('span', 'mn', e.meaning));
  hd.appendChild(head);
  const c = state.cards.get(e.id);
  if(c && c.flagged_at) hd.appendChild(el('span', 'flag', '↻ review soon'));
  row.appendChild(hd);
  if(e.scene) row.appendChild(el('div', 'preview', e.scene));
  row.onclick = () => openEntry(e.id);
  return row;
}

function inboxRow(it){
  const open = state.openInboxId === it.id;
  const done = it.status !== 'pending';
  const row = el('div', `irow${open ? ' open' : ''}${done ? ' done' : ''}`);
  row.dataset.id = it.id;
  const body = el('div'); body.style.flex = '1'; body.style.minWidth = '0';
  const txt = el('div', 'txt');
  const ref = it.about_entry_id && entryById(it.about_entry_id);
  if(it.about_entry_id) txt.appendChild(el('span', 'reftext', ref ? `Rework ${ref.hanzi} · ` : 'Rework · '));
  txt.appendChild(document.createTextNode(it.body));

  if(open && state.editInboxId === it.id){
    const ta = el('textarea', 'ed'); ta.value = it.body; ta.rows = 4;
    body.appendChild(ta);
    const btns = el('div', 'btn-row');
    const c = el('button', 'btn ghost', 'Cancel'); c.onclick = (ev) => { ev.stopPropagation(); state.editInboxId = null; render(); };
    const s = el('button', 'btn go', 'Save');
    s.onclick = async (ev) => {
      ev.stopPropagation();
      if(!ta.value.trim()){ toast('Write something first.'); return; }
      s.disabled = true;
      try{ const upd = await api.updateInbox(it.id, ta.value.trim()); Object.assign(it, upd); state.editInboxId = null; render(); toast('Saved'); }
      catch(ex){ fail(ex); s.disabled = false; }
    };
    btns.append(c, s); body.appendChild(btns);
    setTimeout(() => ta.focus(), 30);
  }else{
    body.appendChild(txt);
    if(it.not_hc) body.appendChild(el('span', 'nhc', 'not HC'));
    if(done && it.result_note) body.appendChild(el('div', 'result', `→ ${it.result_note}`));
    if(open){
      const foot = el('div', 'foot');
      foot.appendChild(el('span', 'det', done ? `Processed ${when(it.processed_at || it.created_at)}` : 'Waiting for Claude'));
      if(!done){
        const acts = el('div', 'acts');
        const be = el('button', 'act', 'Edit'); be.onclick = (ev) => { ev.stopPropagation(); state.editInboxId = it.id; render(); };
        const bd = el('button', 'act danger', 'Delete');
        bd.onclick = async (ev) => {
          ev.stopPropagation();
          if(!confirm('Delete this inbox item?')) return;
          try{ await api.deleteInbox(it.id); state.inbox = state.inbox.filter(x => x.id !== it.id); state.openInboxId = null; render(); toast('Deleted'); }
          catch(ex){ fail(ex); }
        };
        acts.append(be, el('span', 'sep', '·'), bd); foot.appendChild(acts);
      }
      body.appendChild(foot);
    }
  }
  row.appendChild(body);
  row.appendChild(el('span', 'tm', when(it.created_at)));
  row.onclick = () => {
    if(state.editInboxId === it.id) return;
    state.openInboxId = open ? null : it.id; state.editInboxId = null; render();
  };
  return row;
}

/* ==========================================================================
   Navigation (browser history, so swipe-back and the back button work)
   ========================================================================== */
function showView(name){
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
}
function go(view, extra = {}, push = true){
  if(state.view === 'main') state.mainScroll = window.scrollY;
  const from = state.view;
  $('toast').classList.remove('on');
  state.view = view; Object.assign(state, extra);
  if(push) history.pushState({ view, from, ...extra, depth: ((history.state && history.state.depth) || 0) + 1 }, '');
  showView(view);
  if(view === 'main'){ render(); requestAnimationFrame(() => window.scrollTo(0, state.mainScroll)); }
  else window.scrollTo(0, 0);
  if(view === 'entry') renderEntry();
}
function back(){
  if(history.state && history.state.depth) history.back();
  else go('main', {}, false);
}
window.addEventListener('popstate', (ev) => {
  const s = ev.state;
  closeSheet();
  if(state.view === 'review') endSession(true);
  if(!s || s.view === 'main' || s.view === 'review') go('main', {}, false);
  else if(s.view === 'entry') go('entry', { entryId: s.entryId, editEntry: false }, false);
  else if(s.view === 'changes'){ go('changes', { historyFor: s.historyFor || null }, false); loadChanges(); }
});
function openEntry(id){ go('entry', { entryId: id, editEntry: false }); }

/* ==========================================================================
   Entry page
   ========================================================================== */
function siblingsOf(e){ return state.entries.filter(x => x.kind === 'character' && x.hanzi === e.hanzi && x.id !== e.id); }
function wordsWith(e){ return state.entries.filter(x => x.kind === 'word' && x.hanzi.includes(e.hanzi)); }

// For a word containing this character: which reading does it use, if not this one?
function readingInWord(e, w){
  const i = [...w.hanzi].indexOf(e.hanzi);
  const t = w.tones[i];
  if(t == null || t === toneOf(e)) return null;
  const sib = siblingsOf(e).find(x => toneOf(x) === t);
  return sib ? sib.pinyin : null;
}

function reviewInfo(e){
  const c = state.cards.get(e.id), s = state.rstats.get(e.id);
  const lines = [];
  if(c && c.flagged_at) lines.push(['flagged', '↻ In your next review']);
  if(!c || !c.reps){ lines.push(['soft', 'Not reviewed yet']); return lines; }
  const due = new Date(c.due), now = new Date();
  if(!(c && c.flagged_at)){
    if(due <= now) lines.push(['', 'Due now']);
    else if(due - now < 86400000 && dayStart(due).getTime() === dayStart(now).getTime()) lines.push(['', `Next today, ${due.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`]);
    else lines.push(['', `Next in ${span(due - now)}`]);
  }
  if(s){
    if(s.last_reading_ok === false) lines.push(['miss', `Reading missed last time (typed ${s.last_answer || 'nothing'})`]);
    else if(s.last_tone_ok === false){
      const typed = Pinyin.check(e, s.last_answer || '').typedTones;
      lines.push(['miss', `Tone missed last time (typed ${Pinyin.toneText(typed)})`]);
    }
    else if(s.last_meaning_ok === false) lines.push(['miss', 'Meaning missed last time']);
    else lines.push(['soft', 'Right last time']);
    if(s.tone_misses) lines.push(['soft', `Tone misses: ${s.tone_misses} of ${s.reviews} reviews`]);
  }
  return lines;
}

function linkBtn(label, onClick){ const a = el('button', 'lnk', label); a.onclick = (ev) => { ev.stopPropagation(); onClick(); }; return a; }
function erow(label, content){
  const r = el('div', 'erow');
  r.appendChild(el('div', 'k', label));
  const v = el('div', 'v');
  if(content instanceof Node) v.appendChild(content); else v.textContent = content;
  r.appendChild(v);
  return r;
}

function renderEntry(){
  const e = entryById(state.entryId);
  const box = $('entry-body');
  const from = history.state && history.state.from;
  $('entry-back').textContent = from === 'entry' ? '‹ Back' : from === 'changes' ? '‹ Changes' : '‹ Repository';
  if(!e){ $('entry-edit').style.visibility = 'hidden'; box.replaceChildren(el('div', 'empty', 'This entry is no longer in the repository.')); return; }
  const editing = state.editEntry;
  $('entry-edit').style.visibility = editing ? 'hidden' : '';

  const card = el('div', `ecard t${toneOf(e)}`);
  const head = el('div', 'ehead');
  head.appendChild(tilesFor(e, e.kind === 'word' ? 'btile w' : 'btile'));
  const ht = el('div', 'ehtext');
  const l1 = el('div', 'l1');
  l1.appendChild(el('span', 'py', e.pinyin));
  l1.appendChild(el('span', e.kind === 'word' ? 'tn soft' : 'tn', ` · ${toneShort(e)}`));
  ht.append(l1, el('div', 'mn', e.meaning || ''));
  head.appendChild(ht);
  card.appendChild(head);

  let sc = null, co = null;
  if(editing){
    card.appendChild(el('div', 'ed-label', 'Scene'));
    sc = el('textarea', 'ed'); sc.value = e.scene || ''; sc.rows = 6; card.appendChild(sc);
  }else{
    card.appendChild(el('div', 'escene', e.scene || '—'));
  }

  const rows = el('div', 'erows');
  if(editing){
    const w = el('div'); co = el('textarea', 'ed'); co.value = e.components || ''; co.rows = 3; w.appendChild(co);
    rows.appendChild(erow('Components', w));
  }else if(e.components) rows.appendChild(erow('Components', e.components));

  if(!editing){
    if(e.kind === 'character'){
      const sibs = siblingsOf(e);
      if(sibs.length){
        const w = el('div', 'links');
        sibs.forEach(x => w.appendChild(linkBtn(`${x.hanzi} ${x.pinyin} · ${snippet(x.meaning, 24)} ›`, () => openEntry(x.id))));
        rows.appendChild(erow('Also read as', w));
      }
      const words = wordsWith(e);
      if(words.length){
        const w = el('div', 'links');
        words.forEach(x => {
          const line = el('div');
          line.appendChild(linkBtn(`${x.hanzi} ${x.pinyin} ›`, () => openEntry(x.id)));
          const other = readingInWord(e, x);
          if(other) line.appendChild(el('span', 'note', ` (uses ${other})`));
          w.appendChild(line);
        });
        rows.appendChild(erow('Words', w));
      }
    }else{
      const w = el('div', 'links'); const missing = [];
      [...new Set(e.hanzi)].forEach(ch => {
        const hits = state.entries.filter(x => x.kind === 'character' && x.hanzi === ch);
        if(hits.length) hits.forEach(x => { const l = el('div'); l.appendChild(linkBtn(`${x.hanzi} ${x.pinyin} ›`, () => openEntry(x.id))); w.appendChild(l); });
        else missing.push(ch);
      });
      if(missing.length) w.appendChild(el('div', 'note', `${missing.join(' · ')} not in the repository yet`));
      rows.appendChild(erow('Characters', w));
    }
    if(e.notes) rows.appendChild(erow('Notes', e.notes));
    if(e.collision_guard) rows.appendChild(erow('Collision guard', e.collision_guard));
    const tags = (e.tags || []).map(t => t === OUTSIDE_HC ? 'outside HelloChinese' : t);
    if(tags.length) rows.appendChild(erow('Tags', tags.join(' · ')));
    if(state.reviewReady){
      const w = el('div');
      reviewInfo(e).forEach(([cls, txt]) => w.appendChild(el('div', `rl ${cls}`, txt)));
      rows.appendChild(erow('Review', w));
    }
    const det = [e.radical ? `Radical ${e.radical}` : null, e.hsk_level ? `HSK ${e.hsk_level}` : 'HSK beyond 2', e.status === 'needs_rebuild' ? 'Needs rebuild' : 'Locked'].filter(Boolean).join(' · ');
    rows.appendChild(erow('Details', det));
  }
  card.appendChild(rows);

  if(editing){
    const btns = el('div', 'btn-row');
    const cancel = el('button', 'btn ghost', 'Cancel');
    cancel.onclick = () => { state.editEntry = false; renderEntry(); };
    const save = el('button', 'btn go', 'Save');
    save.onclick = async () => {
      if(!sc.value.trim()){ toast('The scene can’t be empty.'); sc.focus(); return; }
      save.disabled = true; save.textContent = 'Saving…';
      try{
        const upd = await api.updateEntry(e.id, { scene: sc.value.trim(), components: co.value.trim() || null });
        Object.assign(e, upd); state.editEntry = false; renderEntry(); toast('Saved');
      }catch(ex){ fail(ex); save.disabled = false; save.textContent = 'Save'; }
    };
    btns.append(cancel, save); card.appendChild(btns);
    setTimeout(() => sc.focus(), 30);
  }

  const out = [card];
  if(!editing){
    const acts = el('div', 'eacts');
    acts.appendChild(linkBtn('Rework', () => openAdd(e)));
    if(state.reviewReady){
      acts.appendChild(el('span', 'sep', '·'));
      const c = state.cards.get(e.id);
      if(c && c.flagged_at) acts.appendChild(Object.assign(linkBtn('Remove from next review', () => setFlag(e, false)), { className: 'lnk soft' }));
      else acts.appendChild(linkBtn('Review soon', () => setFlag(e, true)));
    }
    out.push(acts);
    const ft = el('div', 'efoot');
    ft.append(document.createTextNode(`Added ${shortDate(e.created_at)} · `), linkBtn('History', () => { go('changes', { historyFor: e.id }); loadChanges(); }));
    out.push(ft);
  }
  box.replaceChildren(...out);
}

async function setFlag(e, on){
  try{
    const row = await api.saveCard({ entry_id: e.id, flagged_at: on ? new Date().toISOString() : null });
    state.cards.set(e.id, { ...(state.cards.get(e.id) || {}), ...row });
    updateBadge();
    if(state.view === 'entry') renderEntry();
    if(on) toast('Added to your next review', { label: 'Undo', fn: () => setFlag(e, false) });
    else toast('Removed from your next review');
  }catch(ex){ fail(ex); }
}

/* ==========================================================================
   Review (FSRS via vendor/fsrs.js)
   ========================================================================== */
const RATINGS = [[1, 'Again'], [2, 'Hard'], [3, 'Good'], [4, 'Easy']];

function initScheduler(){
  if(!scheduler && window.FSRS) scheduler = FSRS.fsrs(FSRS.generatorParameters({ enable_fuzz: true }));
  return scheduler;
}
function isNew(e){ const c = state.cards.get(e.id); return !c || !c.reps; }
function toFsrsCard(c, now){
  if(!c || !c.reps) return FSRS.createEmptyCard(now);
  return {
    due: new Date(c.due), stability: +c.stability, difficulty: +c.difficulty,
    elapsed_days: c.elapsed_days, scheduled_days: c.scheduled_days, learning_steps: c.learning_steps || 0,
    reps: c.reps, lapses: c.lapses, state: c.state, last_review: c.last_review ? new Date(c.last_review) : undefined,
  };
}
function newToday(){ return state.reviewsToday.filter(r => r.was_new).length; }

// ① Review soon flags ② due cards ③ new cards up to the daily limit
//    (outside-hc first; a word only once all its characters have been reviewed)
function buildQueue(){
  const now = new Date(), C = state.cards;
  const flagged = state.entries.filter(e => C.get(e.id) && C.get(e.id).flagged_at)
    .sort((a, b) => new Date(C.get(a.id).flagged_at) - new Date(C.get(b.id).flagged_at));
  const fl = new Set(flagged.map(e => e.id));
  const due = state.entries.filter(e => { const c = C.get(e.id); return c && c.reps > 0 && !fl.has(e.id) && new Date(c.due) <= now; })
    .sort((a, b) => new Date(C.get(a.id).due) - new Date(C.get(b.id).due));
  const chars = new Set(state.entries.filter(e => e.kind === 'character').map(e => e.hanzi));
  const seen = new Set(state.entries.filter(e => e.kind === 'character' && !isNew(e)).map(e => e.hanzi));
  const fresh = state.entries.filter(e => !fl.has(e.id) && isNew(e) && (e.kind === 'character' || [...e.hanzi].every(ch => !chars.has(ch) || seen.has(ch))))
    .sort((a, b) => (isOutsideHc(b) - isOutsideHc(a)) || a.created_at.localeCompare(b.created_at) || a._plain.localeCompare(b._plain));
  const room = Math.max(0, state.newPerDay - newToday());
  return { flagged, due, fresh: fresh.slice(0, room), freshLeft: fresh.length };
}

function updateBadge(){
  const b = $('menu-badge');
  if(!b) return;
  if(!state.reviewReady || !state.loaded){ b.style.display = 'none'; return; }
  const q = buildQueue();
  const n = q.flagged.length + q.due.length;
  b.textContent = n > 99 ? '99+' : String(n);
  b.style.display = n ? '' : 'none';
}

// Hint for characters with two readings: a word that uses this reading, e.g. 觉 (睡觉)
function readingHint(e){
  if(e.kind !== 'character' || !siblingsOf(e).length) return null;
  const w = wordsWith(e).find(x => x.tones[[...x.hanzi].indexOf(e.hanzi)] === toneOf(e));
  return w ? `(${w.hanzi})` : `(${snippet(e.meaning, 20)})`;
}

function startReview(){
  if(!state.reviewReady){ toast('Review needs the v2 database update (schema_v2.sql).'); return; }
  if(!initScheduler()){ toast("Couldn't load the review scheduler."); return; }
  go('review');
  startReviewInPlace();
}
function endSession(){ state.session = null; updateBadge(); }

function curEntry(){ const s = state.session; return s && entryById(s.queue[s.pos]); }

function renderReview(){
  const s = state.session;
  if(!s) return;
  const top = $('rv-top');
  const total = s.queue.length;
  top.style.visibility = (s.phase === 'front' || s.phase === 'back') ? '' : 'hidden';
  $('rv-count').style.visibility = top.style.visibility;
  $('rv-bar').style.width = total ? `${Math.round(100 * s.pos / total)}%` : '0';
  $('rv-count').textContent = `${Math.min(s.pos + 1, total)} / ${total}`;
  const body = $('rv-body');
  if(s.phase === 'front') body.replaceChildren(...reviewFront(s));
  else if(s.phase === 'back') body.replaceChildren(...reviewBack(s));
  else if(s.phase === 'summary') body.replaceChildren(...reviewSummary(s));
  else body.replaceChildren(...reviewEmpty());
}

function reviewFront(s){
  const e = curEntry();
  if(!e){ s.pos++; return s.pos < s.queue.length ? reviewFront(s) : (s.phase = 'summary', reviewSummary(s)); }
  s.shownAt = Date.now();
  const front = el('div', 'rv-front');
  front.appendChild(el('div', `rv-big${e.kind === 'word' ? ' word' : ''}`, e.hanzi));
  const hint = readingHint(e);
  const c = state.cards.get(e.id);
  front.appendChild(el('div', 'rv-kind', [e.kind === 'word' ? 'Word' : 'Character', hint, c && c.flagged_at ? '· you flagged this' : null].filter(Boolean).join(' ')));

  const form = el('form', 'rv-form');
  const inp = el('input', 'rv-input');
  Object.assign(inp, { type: 'text', id: 'rv-input', placeholder: 'Type the pinyin', autocomplete: 'off', spellcheck: false });
  inp.setAttribute('autocapitalize', 'off'); inp.setAttribute('autocorrect', 'off'); inp.setAttribute('enterkeyhint', 'done');
  const hintLine = el('div', 'hint', e.kind === 'word' ? 'Pinyin with tone numbers or marks, dictionary tones' : 'Pinyin with tone number or mark');
  const err = el('div', 'rv-err');
  const check = el('button', 'primary', 'Check'); check.type = 'submit';
  form.onsubmit = (ev) => {
    ev.preventDefault();
    if(!inp.value.trim()){ err.textContent = 'Type the pinyin first, or tap Don’t know.'; inp.focus(); return; }
    revealAnswer(inp.value);
  };
  inp.oninput = () => { err.textContent = ''; };
  const dk = el('button', 'lnk soft rv-dk', 'Don’t know'); dk.type = 'button';
  dk.onclick = () => revealAnswer('');
  form.append(inp, err, hintLine, check, dk);
  setTimeout(() => inp.focus(), 60);
  return [front, form];
}

function revealAnswer(answer){
  const s = state.session, e = curEntry();
  s.answer = answer.trim();
  s.result = Pinyin.check(e, s.answer);
  s.meaning = true;
  const now = new Date();
  s.preview = scheduler.repeat(toFsrsCard(state.cards.get(e.id), now), now);
  s.phase = 'back';
  if(document.activeElement) document.activeElement.blur();
  renderReview();
}

function suggestedRating(s){
  if(s.result.empty || !s.result.reading_ok || !s.result.tone_ok) return 1;
  return s.meaning ? 3 : 2;
}

function reviewBack(s){
  const e = curEntry(), r = s.result;
  const wrap = el('div', `rv-back t${toneOf(e)}`);
  const head = el('div', 'ehead');
  head.appendChild(tilesFor(e, e.kind === 'word' ? 'btile w' : 'btile'));
  const ht = el('div', 'ehtext');
  ht.append(el('div', 'py big', e.pinyin), el('div', 'mn', e.meaning || ''));
  head.appendChild(ht); wrap.appendChild(head);

  const chips = el('div', 'chips');
  if(r.empty) chips.appendChild(el('span', 'chip bad', 'Didn’t know'));
  else{
    chips.appendChild(el('span', `chip ${r.reading_ok ? 'good' : 'bad'}`, r.reading_ok ? '✓ Reading' : `✗ Reading: you typed ${s.answer}`));
    chips.appendChild(el('span', `chip ${r.tone_ok ? 'good' : 'bad'}`, r.tone_ok ? '✓ Tone' : `✗ Tone: you typed ${Pinyin.toneText(r.typedTones)}`));
  }
  wrap.appendChild(chips);
  wrap.appendChild(el('div', 'escene rv-scene', e.scene || '—'));

  const mq = el('div', 'rv-meaning');
  mq.appendChild(el('span', null, 'Meaning?'));
  [[true, 'Knew it'], [false, 'Didn’t']].forEach(([v, label]) => {
    const b = el('button', `pill${s.meaning === v ? ' on' : ''}`, label);
    b.onclick = () => { s.meaning = v; renderReview(); };
    mq.appendChild(b);
  });
  wrap.appendChild(mq);

  const sug = suggestedRating(s), now = new Date();
  const rates = el('div', 'rates');
  RATINGS.forEach(([g, label]) => {
    const b = el('button', `rate r${g}${g === sug ? ' sug' : ''}`);
    b.append(el('span', null, label), el('small', null, span(s.preview[g].card.due - now)));
    b.disabled = s.saving;
    b.onclick = () => rate(g);
    rates.appendChild(b);
  });
  return [wrap, rates];
}

async function rate(g){
  const s = state.session, e = curEntry();
  if(!s || s.saving) return;
  s.saving = true; renderReview();
  const now = new Date();
  const prev = state.cards.get(e.id);
  const nc = s.preview[g].card;
  const row = {
    entry_id: e.id, due: new Date(nc.due).toISOString(), stability: nc.stability, difficulty: nc.difficulty,
    elapsed_days: nc.elapsed_days, scheduled_days: nc.scheduled_days, learning_steps: nc.learning_steps || 0,
    reps: nc.reps, lapses: nc.lapses, state: nc.state,
    last_review: nc.last_review ? new Date(nc.last_review).toISOString() : now.toISOString(), flagged_at: null,
  };
  const r = s.result;
  const review = {
    entry_id: e.id, answer: s.answer, reading_ok: r.empty ? false : r.reading_ok, tone_ok: r.empty ? false : r.tone_ok, meaning_ok: s.meaning,
    rating: g, was_new: isNew(e), was_flagged: !!(prev && prev.flagged_at),
    seconds: Math.min(9999, Math.round((Date.now() - s.shownAt) / 100) / 10), due_after: row.due,
  };
  try{
    const [saved] = await Promise.all([api.saveCard(row), api.addReview(review)]);
    state.cards.set(e.id, saved || row);
    state.reviewsToday.push({ entry_id: e.id, was_new: review.was_new, reviewed_at: now.toISOString() });
    const st = state.rstats.get(e.id) || { entry_id: e.id, reviews: 0, tone_misses: 0, reading_misses: 0, meaning_misses: 0 };
    st.reviews++; if(review.tone_ok === false) st.tone_misses++; if(review.reading_ok === false) st.reading_misses++; if(review.meaning_ok === false) st.meaning_misses++;
    Object.assign(st, { last_reviewed: now.toISOString(), last_answer: review.answer, last_reading_ok: review.reading_ok, last_tone_ok: review.tone_ok, last_meaning_ok: review.meaning_ok });
    state.rstats.set(e.id, st);
    s.done.push({ id: e.id, answer: s.answer, result: r, meaning: s.meaning, rating: g, wasNew: review.was_new });
    // Again / learning steps: show it once more later in this session
    const shown = s.done.filter(d => d.id === e.id).length;
    if(new Date(row.due) - now < 20 * 60000 && shown < 3) s.queue.push(e.id);
    s.pos++;
    s.phase = s.pos < s.queue.length ? 'front' : 'summary';
  }catch(ex){ fail(ex); }
  s.saving = false;
  renderReview();
}

function closeReview(){
  const s = state.session;
  if(s && (s.phase === 'front' || s.phase === 'back') && s.done.length){ s.early = true; s.phase = 'summary'; renderReview(); return; }
  back();
}

function newPerDayPills(){
  const w = el('div', 'rv-setting');
  w.appendChild(el('div', 'lbl', 'New cards per day'));
  const p = el('div', 'pills');
  NEW_PER_DAY_OPTIONS.forEach(n => {
    const b = el('button', `pill${state.newPerDay === n ? ' on' : ''}`, String(n));
    b.onclick = async () => {
      const old = state.newPerDay; state.newPerDay = n; renderReview();
      try{ await api.setSetting('new_per_day', n); updateBadge(); }catch(ex){ state.newPerDay = old; renderReview(); fail(ex); }
    };
    p.appendChild(b);
  });
  w.appendChild(p);
  return w;
}

function missRow(d, label){
  const e = entryById(d.id);
  const r = el('div', 'row mrow');
  const hd = el('div', 'hd');
  hd.appendChild(tilesFor(e));
  const head = el('div', 'head');
  head.append(el('span', 'py', e.pinyin), document.createTextNode(' '), el('span', 'mn', label));
  hd.appendChild(head);
  hd.appendChild(linkBtn('Rework', () => openAdd(e, `Missed in review: ${label}.`)));
  r.appendChild(hd);
  r.onclick = () => openEntry(e.id);
  return r;
}

function reviewSummary(s){
  const out = [];
  const ids = new Set(s.done.map(d => d.id));
  const mins = Math.max(1, Math.round((Date.now() - s.started) / 60000));
  const nNew = new Set(s.done.filter(d => d.wasNew).map(d => d.id)).size;
  const hero = el('div', 'rv-hero');
  hero.appendChild(el('div', 'rv-ok', '✓'));
  hero.appendChild(el('div', 'rv-title', `${ids.size} reviewed`));
  hero.appendChild(el('div', 'rv-sub', `${nNew} new · ${ids.size - nNew} due · about ${mins} minute${mins === 1 ? '' : 's'}`));
  out.push(hero);
  // first answer per card decides the miss lists
  const first = new Map(); s.done.forEach(d => { if(!first.has(d.id)) first.set(d.id, d); });
  const F = [...first.values()];
  const groups = [
    ['Didn’t know', F.filter(d => d.result.empty), () => 'didn’t know'],
    ['Tone misses', F.filter(d => !d.result.empty && !d.result.tone_ok), (d) => `typed ${Pinyin.toneText(d.result.typedTones)}`],
    ['Reading misses', F.filter(d => !d.result.empty && !d.result.reading_ok), (d) => `typed ${d.answer}`],
    ['Meaning misses', F.filter(d => !d.meaning), (d) => snippet((entryById(d.id) || {}).meaning, 28)],
  ];
  groups.forEach(([label, list, fn]) => {
    if(!list.length) return;
    out.push(secHead(`${label} · ${list.length}`, null));
    out.push(panel(list.map(d => missRow(d, fn(d)))));
  });
  if(F.length && groups.every(g => !g[1].length)) out.push(el('div', 'rv-clean', 'No misses. Nice.'));
  out.push(newPerDayPills());
  const btns = el('div', 'rv-btns');
  if(s.early && s.pos < s.queue.length){
    const kg = el('button', 'btn ghost', `Keep going (${s.queue.length - s.pos} left)`);
    kg.onclick = () => { s.early = false; s.phase = 'front'; renderReview(); };
    btns.appendChild(kg);
  }
  const done = el('button', 'btn go', 'Done'); done.onclick = () => back();
  btns.appendChild(done);
  out.push(btns);
  return out;
}

function reviewEmpty(){
  const out = [];
  const hero = el('div', 'rv-hero');
  hero.appendChild(el('div', 'rv-ok', '✓'));
  hero.appendChild(el('div', 'rv-title', 'Nothing to review right now'));
  const next = [...state.cards.values()].filter(c => c.reps > 0).map(c => new Date(c.due)).filter(d => d > new Date()).sort((a, b) => a - b)[0];
  const q = buildQueue();
  const lines = [];
  if(next) lines.push(`Next card due in ${span(next - new Date())}.`);
  if(q.freshLeft && !q.fresh.length) lines.push(`You've had your ${state.newPerDay} new cards today.`);
  hero.appendChild(el('div', 'rv-sub', lines.join(' ') || 'Every entry is reviewed.'));
  out.push(hero);
  out.push(newPerDayPills());
  const btns = el('div', 'rv-btns');
  const again = el('button', 'btn ghost', 'Check again'); again.onclick = () => { const s = buildQueue(); if(s.fresh.length || s.due.length || s.flagged.length){ startReviewInPlace(); } else toast('Still nothing due'); };
  const done = el('button', 'btn go', 'Done'); done.onclick = () => back();
  btns.append(again, done);
  out.push(btns);
  return out;
}
function startReviewInPlace(){
  const q = buildQueue();
  const ids = [...q.flagged, ...q.due, ...q.fresh].map(e => e.id);
  state.session = { queue: ids, pos: 0, done: [], started: Date.now(), phase: ids.length ? 'front' : 'empty', early: false, answer: '', result: null, meaning: true, preview: null, shownAt: Date.now(), saving: false, counts: { fresh: q.fresh.length, due: q.due.length + q.flagged.length } };
  renderReview();
}

/* ==========================================================================
   Sheets
   ========================================================================== */
let openSheetId = null;
function openSheet(id){
  closeSheet();
  openSheetId = id; $('scrim').classList.add('on'); $(id).classList.add('on');
}
function closeSheet(){
  if(!openSheetId) return;
  $(openSheetId).classList.remove('on'); $('scrim').classList.remove('on'); openSheetId = null;
}

function setNotHc(on){ const sw = $('add-nothc'); sw.classList.toggle('on', on); sw.setAttribute('aria-checked', String(on)); }
function openAdd(refEntry, prefill){
  state.addRef = refEntry || null;
  $('add-title').textContent = refEntry ? `Rework ${refEntry.hanzi}` : 'Add to inbox';
  const ref = $('add-ref');
  if(refEntry){
    ref.replaceChildren(el('span', `reftag t${toneOf(refEntry)}`, `${refEntry.hanzi} ${refEntry.pinyin} · linked`));
    ref.style.display = '';
    $('add-text').placeholder = 'What should change? Paste Claude’s new version or describe it.';
    $('add-hint').textContent = 'Goes to the inbox. Claude replaces the entry when it processes it.';
    $('add-save').textContent = 'Send to inbox';
  }else{
    ref.style.display = 'none';
    $('add-text').placeholder = 'Paste from Claude or type…';
    $('add-hint').textContent = 'Free text or paste from Claude. No format needed.';
    $('add-save').textContent = 'Add';
  }
  $('add-nothc-row').style.display = refEntry ? 'none' : '';
  setNotHc(false);
  $('add-text').value = prefill ? prefill + ' ' : '';
  openSheet('sheet-add');
  setTimeout(() => $('add-text').focus(), 220);
}
async function saveAdd(){
  const body = $('add-text').value.trim();
  if(!body){ toast('Write something first.'); $('add-text').focus(); return; }
  const btn = $('add-save'); btn.disabled = true;
  try{
    const notHc = !state.addRef && $('add-nothc').classList.contains('on');
    const it = await api.addInbox(body, state.addRef ? state.addRef.id : null, notHc);
    state.inbox.unshift(it); closeSheet();
    if(state.view === 'main') render();
    toast(state.addRef ? 'Sent to inbox for Claude' : 'Added to inbox');
  }catch(ex){ fail(ex); }
  finally{ btn.disabled = false; }
}

function renderSortSheet(){
  const mk = (wrapId, items, cur, onPick) => {
    const w = $(wrapId); w.replaceChildren();
    items.forEach(([k, label]) => {
      const b = el('button', `pill${k === cur ? ' on' : ''}`, label);
      b.onclick = () => { onPick(k); savePrefs(); renderSortSheet(); render(); };
      w.appendChild(b);
    });
  };
  mk('group-pills', GROUPS, state.prefs.group, (k) => state.prefs.group = k);
  mk('sortby-pills', SORTS, state.prefs.sort, (k) => state.prefs.sort = k);
  const tw = $('tone-pills'); tw.replaceChildren();
  [1, 2, 3, 4, 5].forEach(t => {
    const on = state.prefs.tones.includes(t);
    const b = el('button', `pill tone t${t}${on ? '' : ' off'}`, t === 5 ? 'neutral' : String(t));
    b.onclick = () => {
      const s = new Set(state.prefs.tones);
      if(on && s.size > 1) s.delete(t); else s.add(t);
      state.prefs.tones = [...s].sort(); savePrefs(); renderSortSheet(); render();
    };
    tw.appendChild(b);
  });
}
function savePrefs(){ lsSet('ta-prefs', state.prefs); }

async function openMenu(){
  $('stats').textContent = '…'; $('changes-today').textContent = '';
  if(state.reviewReady){
    const q = buildQueue(), due = q.flagged.length + q.due.length;
    $('review-side').textContent = (due || q.fresh.length) ? `${due} due · ${q.fresh.length} new` : 'Nothing due';
  }else $('review-side').textContent = 'needs setup';
  openSheet('sheet-menu');
  try{
    const s = await api.stats();
    $('stats').textContent = `${s.characters} characters · ${s.readings} readings · ${s.words} words` + (s.needs_rebuild ? ` · ${s.needs_rebuild} to rebuild` : '');
    const h = await api.history(100);
    const today = h.filter(x => dayLabel(x.changed_at) === 'Today').length;
    $('changes-today').textContent = today ? `${today} today` : '';
  }catch(ex){ $('stats').textContent = 'Counts unavailable'; console.error(ex); }
}

async function exportJson(){
  try{
    const data = { exported_at: new Date().toISOString(), ...(await api.exportAll()) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = el('a'); a.href = URL.createObjectURL(blob);
    a.download = `tone-anchoring-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`Exported ${data.entries.length} entries, ${data.inbox.length} inbox items, ${data.reviews.length} reviews`);
  }catch(ex){ fail(ex); }
}

/* ==========================================================================
   Changes page (all changes, or one entry's history)
   ========================================================================== */
const FIELD_LABEL = { scene: 'Story', components: 'Components', meaning: 'Meaning', pinyin: 'Pinyin', tones: 'Tones', hanzi: 'Hanzi', radical: 'Radical', hsk_level: 'HSK', status: 'Status', tags: 'Tags', notes: 'Notes', collision_guard: 'Collision guard', kind: 'Type', created_at: 'Date added', body: 'Text', result_note: 'Result', not_hc: 'Not from HelloChinese' };
function changedFields(h){
  if(!h.before || !h.after) return [];
  return Object.keys(FIELD_LABEL).filter(k => JSON.stringify(h.before[k] ?? null) !== JSON.stringify(h.after[k] ?? null));
}
function describe(h){
  const r = h.after || h.before || {};
  if(h.table_name === 'entries'){
    const name = `${r.hanzi || ''}`;
    if(h.action === 'insert') return [`Added ${name}`, r.pinyin || ''];
    if(h.action === 'delete') return [`Deleted ${name}`, r.pinyin || ''];
    return [`Updated ${name}`, changedFields(h).map(k => FIELD_LABEL[k].toLowerCase()).join(', ')];
  }
  if(h.action === 'insert') return ['Added to inbox', snippet(r.body, 50)];
  if(h.action === 'delete') return ['Deleted inbox item', snippet(r.body, 50)];
  if(h.before && h.after && h.before.status !== h.after.status && h.after.status === 'processed') return ['Processed inbox item', h.after.result_note || snippet(r.body, 50)];
  return ['Edited inbox item', snippet(r.body, 50)];
}

function showChanges(){ go('changes', { historyFor: null }); loadChanges(); }
async function loadChanges(){
  const e = state.historyFor && entryById(state.historyFor);
  $('changes-title').textContent = state.historyFor ? `History · ${e ? e.hanzi + ' ' + e.pinyin : 'entry'}` : 'Changes';
  $('changes-back').textContent = state.historyFor ? '‹ Back' : '‹ Repository';
  const box = $('changes-list'); box.replaceChildren(el('div', 'loading', 'Loading…'));
  try{
    const hist = state.historyFor ? await api.historyFor(state.historyFor) : await api.history(150);
    if(!hist.length){ box.replaceChildren(el('div', 'empty', state.historyFor ? 'No changes to this entry since it was added.' : 'No changes yet.')); return; }
    const out = []; let cur = null, pnl = null;
    for(const h of hist){
      const lab = dayLabel(h.changed_at);
      if(lab !== cur){ cur = lab; out.push(secHead(lab, null)); pnl = el('div', 'panel'); out.push(pnl); }
      pnl.appendChild(changeRow(h));
    }
    box.replaceChildren(...out);
  }catch(ex){ box.replaceChildren(el('div', 'empty', `Couldn't load changes. ${ex.message || ''}`)); }
}
function changeRow(h){
  const row = el('div', 'crow');
  const l1 = el('div', 'l1');
  l1.appendChild(el('span', `src ${h.source === 'app' ? 'app' : 'claude'}`, h.source === 'app' ? 'You' : 'Claude'));
  const [what, sub] = describe(h);
  const w = el('div', 'what'); w.appendChild(el('div', null, what));
  w.appendChild(el('div', 'sub', [sub, when(h.changed_at)].filter(Boolean).join(' · ')));
  l1.appendChild(w);
  if(h.table_name === 'entries'){
    const u = el('button', 'act', 'Undo');
    u.onclick = async (ev) => {
      ev.stopPropagation();
      const msg = h.action === 'insert' ? `Undo: remove ${h.after.hanzi} again?` : `Undo: put ${(h.before || {}).hanzi} back the way it was before this change?`;
      if(!confirm(msg)) return;
      try{ await api.undo(h.id); toast('Undone'); await loadAll(); loadChanges(); }catch(ex){ fail(ex); }
    };
    l1.appendChild(u);
  }
  row.appendChild(l1);
  const fields = changedFields(h);
  if(h.action === 'update' && fields.length){
    row.style.cursor = 'pointer';
    const diff = el('div', 'diff'); diff.style.display = state.openChangeId === h.id ? '' : 'none';
    fields.forEach(k => {
      diff.appendChild(el('div', 'f', FIELD_LABEL[k]));
      const fmt = (v) => v == null || v === '' ? '(empty)' : Array.isArray(v) ? v.join(', ') : String(v);
      diff.appendChild(el('div', 'was', fmt(h.before[k])));
      diff.appendChild(el('div', 'now', fmt(h.after[k])));
    });
    row.appendChild(diff);
    row.onclick = () => { const on = diff.style.display === 'none'; diff.style.display = on ? '' : 'none'; state.openChangeId = on ? h.id : null; };
  }
  return row;
}

/* ==========================================================================
   Auth, wiring
   ========================================================================== */
function wire(){
  const s = $('search');
  let t = null;
  s.addEventListener('input', () => {
    $('search-box').classList.toggle('has-text', !!s.value);
    clearTimeout(t); t = setTimeout(() => { state.q = s.value; render(); }, 80);
  });
  $('search-clear').onclick = () => { s.value = ''; state.q = ''; $('search-box').classList.remove('has-text'); render(); s.focus(); };
  document.querySelectorAll('#filter button').forEach(b => b.onclick = () => { state.filter = b.dataset.f; state.openInboxId = null; render(); window.scrollTo(0, 0); });
  $('add-btn').onclick = () => openAdd(null);
  $('add-save').onclick = saveAdd;
  $('add-nothc').onclick = () => setNotHc(!$('add-nothc').classList.contains('on'));
  $('sort-btn').onclick = () => { renderSortSheet(); openSheet('sheet-sort'); };
  $('menu-btn').onclick = openMenu;
  $('scrim').onclick = closeSheet;
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeSheet);
  document.addEventListener('keydown', (e) => { if(e.key === 'Escape') closeSheet(); });
  $('m-review').onclick = () => { closeSheet(); startReview(); };
  $('m-changes').onclick = () => { closeSheet(); showChanges(); };
  $('m-export').onclick = () => { closeSheet(); exportJson(); };
  $('m-signout').onclick = async () => { closeSheet(); if(DEMO){ toast('Demo mode: nothing to sign out of'); return; } await api.supa.auth.signOut(); };
  $('changes-back').onclick = back;
  $('entry-back').onclick = back;
  $('entry-edit').onclick = () => { state.editEntry = true; renderEntry(); };
  $('rv-close').onclick = closeReview;
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible' && state.loaded && Date.now() - state.lastLoad > 30000
       && !state.editEntry && !state.editInboxId && state.view !== 'review') loadAll();
  });

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error'); err.textContent = '';
    const btn = $('login-submit'); btn.disabled = true; btn.textContent = 'Signing in…';
    try{
      const { error } = await api.supa.auth.signInWithPassword({ email: $('login-email').value.trim(), password: $('login-password').value });
      if(error) throw error;
    }catch(ex){ err.textContent = ex.message || 'Sign-in failed.'; }
    finally{ btn.disabled = false; btn.textContent = 'Sign in'; }
  });
}

function onSignedIn(session){
  if(currentUserId === session.user.id && state.loaded) return;
  currentUserId = session.user.id;
  state.view = 'main'; showView('main'); loadAll();
}
function onSignedOut(){
  currentUserId = null; state.entries = []; state.inbox = []; state.loaded = false;
  state.cards = new Map(); state.rstats = new Map();
  $('login-password').value = ''; state.view = 'login'; showView('login');
}

async function init(){
  state.prefs = { ...state.prefs, ...lsGet('ta-prefs', {}) };
  if(!Array.isArray(state.prefs.tones) || !state.prefs.tones.length) state.prefs.tones = [1, 2, 3, 4, 5];
  if(history.state && history.state.view && history.state.view !== 'main') history.replaceState(null, '');
  wire();
  if(DEMO){
    $('demo-banner').style.display = '';
    api = demoApi(); state.view = 'main'; showView('main'); loadAll(); return;
  }
  api = supabaseApi();
  api.supa.auth.onAuthStateChange((_ev, session) => { if(session && session.user) onSignedIn(session); else onSignedOut(); });
  const { data } = await api.supa.auth.getSession();
  if(data && data.session) onSignedIn(data.session); else { state.view = 'login'; showView('login'); }
}
init();
