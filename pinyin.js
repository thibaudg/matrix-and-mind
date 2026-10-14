/* ==========================================================================
   Tone Anchoring — pinyin answer checker (review cards)
   Accepts tone numbers (deng3, sheng1yin1), tone marks (děng), or both mixed;
   neutral = 5, 0 or nothing; v / ü / u: for ü. Spaces, capitals, apostrophes ignored.
   ========================================================================== */
(function(root){
  // Valid Mandarin syllables (toneless, ü written as v), plus "r" for erhua (儿).
  const FINALS = {
    '': 'a ai an ang ao e ei en eng er o ou',
    b: 'a ai an ang ao ei en eng i ian iao ie in ing o u',
    p: 'a ai an ang ao ei en eng i ian iao ie in ing o ou u',
    m: 'a ai an ang ao e ei en eng i ian iao ie in ing iu o ou u',
    f: 'a an ang ei en eng o ou u',
    d: 'a ai an ang ao e ei en eng i ia ian iao ie ing iu ong ou u uan ui un uo',
    t: 'a ai an ang ao e eng i ian iao ie ing ong ou u uan ui un uo',
    n: 'a ai an ang ao e ei en eng i ian iang iao ie in ing iu ong ou u uan uo v ve',
    l: 'a ai an ang ao e ei eng i ia ian iang iao ie in ing iu o ong ou u uan un uo v ve',
    g: 'a ai an ang ao e ei en eng ong ou u ua uai uan uang ui un uo',
    k: 'a ai an ang ao e ei en eng ong ou u ua uai uan uang ui un uo',
    h: 'a ai an ang ao e ei en eng ong ou u ua uai uan uang ui un uo',
    j: 'i ia ian iang iao ie in ing iong iu u uan ue un',
    q: 'i ia ian iang iao ie in ing iong iu u uan ue un',
    x: 'i ia ian iang iao ie in ing iong iu u uan ue un',
    zh: 'a ai an ang ao e ei en eng i ong ou u ua uai uan uang ui un uo',
    ch: 'a ai an ang ao e en eng i ong ou u ua uai uan uang ui un uo',
    sh: 'a ai an ang ao e ei en eng i ou u ua uai uan uang ui un uo',
    r: 'an ang ao e en eng i ong ou u ua uan ui un uo',
    z: 'a ai an ang ao e ei en eng i ong ou u uan ui un uo',
    c: 'a ai an ang ao e en eng i ong ou u uan ui un uo',
    s: 'a ai an ang ao e en eng i ong ou u uan ui un uo',
    y: 'a an ang ao e i in ing o ong ou u uan ue un',
    w: 'a ai an ang ei en eng o u',
  };
  const SYL = new Set(['r']);
  for(const [ini, fins] of Object.entries(FINALS)) fins.split(' ').forEach(f => SYL.add(ini + f));

  // Combining marks after NFD normalisation
  const TONE_MARK = { '\u0304': 1, '\u0301': 2, '\u030C': 3, '\u0300': 4 };
  const UMLAUT = '\u0308';

  // -> { plain, marks: [{pos, tone}], digits: [{pos, tone}] }  (pos = index in plain)
  function parse(s){
    s = (s || '').toString().toLowerCase().replace(/u:/g, 'v').normalize('NFD');
    let plain = '';
    const marks = [], digits = [];
    for(const ch of s){
      if(ch >= 'a' && ch <= 'z') plain += ch;
      else if(TONE_MARK[ch]) { if(plain) marks.push({ pos: plain.length - 1, tone: TONE_MARK[ch] }); }
      else if(ch === UMLAUT) { if(plain.endsWith('u')) plain = plain.slice(0, -1) + 'v'; }
      else if(ch >= '0' && ch <= '5') digits.push({ pos: plain.length, tone: ch === '0' ? 5 : +ch });
    }
    return { plain, marks, digits };
  }

  // Split a toneless string into exactly n syllables; returns end positions or null
  function segment(plain, n){
    const L = plain.length, memo = new Map();
    function f(i, k){
      if(i === L) return k === 0 ? [] : null;
      if(k === 0) return null;
      const key = i * 16 + k;
      if(memo.has(key)) return memo.get(key);
      let res = null;
      for(let len = Math.min(6, L - i); len >= 1 && !res; len--){
        if(SYL.has(plain.slice(i, i + len))){
          const rest = f(i + len, k - 1);
          if(rest) res = [i + len, ...rest];
        }
      }
      memo.set(key, res);
      return res;
    }
    return f(0, n);
  }

  function sylAt(ends, pos){
    for(let i = 0; i < ends.length; i++) if(pos < ends[i]) return i;
    return ends.length - 1;
  }

  function tonesFrom(typed, ends, n){
    const tones = new Array(n).fill(5);
    typed.marks.forEach(m => { tones[sylAt(ends, m.pos)] = m.tone; });
    typed.digits.forEach(d => { if(d.pos > 0) tones[sylAt(ends, d.pos - 1)] = d.tone; });
    return tones;
  }

  // entry: { kind, hanzi, pinyin, tones }  ->  { reading_ok, tone_ok, typedTones, empty }
  function check(entry, answer){
    const n = entry.kind === 'word' ? [...entry.hanzi].length : 1;
    const exp = parse(entry.pinyin);
    const typ = parse(answer);
    const expTones = (entry.tones || []).slice(0, n);
    while(expTones.length < n) expTones.push(5);
    if(!typ.plain) return { reading_ok: false, tone_ok: false, typedTones: [], empty: true };

    const reading_ok = typ.plain === exp.plain;
    const ends = n === 1 ? [typ.plain.length] : segment(reading_ok ? exp.plain : typ.plain, n);
    let typedTones;
    if(ends) typedTones = tonesFrom(typ, ends, n);
    else {
      const seq = [...typ.marks.map(m => ({ p: m.pos, t: m.tone })), ...typ.digits.map(d => ({ p: d.pos - 0.5, t: d.tone }))]
        .sort((a, b) => a.p - b.p).map(x => x.t);
      typedTones = seq;
    }
    const tone_ok = typedTones.length === n && typedTones.every((t, i) => t === expTones[i]);
    return { reading_ok, tone_ok, typedTones, empty: false };
  }

  // "4", "4 + 2", "neutral"
  function toneText(tones){
    return (tones || []).map(t => t === 5 ? 'neutral' : String(t)).join(' + ') || '—';
  }

  const api = { parse, segment, check, toneText, SYL };
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Pinyin = api;
})(typeof window !== 'undefined' ? window : this);
