/* Rozliczenia – prosta PWA, dane trzymane w localStorage telefonu.
 *
 * Model (wersja 4):
 *   ruchy: [{ id, date, amount, currency, kind: 'in' | 'out', cel, note, poza }]
 *     kind 'in'  = szef dał pieniądze; cel mówi, co to było:
 *                  'wydatki' (kasa na wydatki) | 'wyplata' (moja wypłata) | 'pati' (dla Pati)
 *     kind 'out' = wydatek z kasy na wydatki; poza=true → zapłacone ze swojego (nie odejmuje)
 *   praca: [{ id, date, amount, note }]  – dni pracy Pati u Svena (zarobione €)
 *   prace: [{ id, date, stawka, hours, amount, currency, note, paid, paidDate }]
 *     dodatkowe roboty: stawka × godziny (albo sama stawka), później oznaczenie wypłaty
 *
 *   Zostało (Kasa) = suma in/wydatki − suma out (bez poza)
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'rozliczenia.v1';
  const SYNC_KEY = 'rozliczenia.sync';
  const VERSION = 4;
  const DEFAULT_RATE = 4.2; // ile zł za 1 € (1429 zł → 340,24 € w arkuszu)
  const GIST_ID = '0767aa98411befb5079087083df67a9e';
  const GIST_FILE = 'rozliczenia-sync.json';
  const GIST_RAW = `https://gist.githubusercontent.com/BrygolaBartlomiej/${GIST_ID}/raw/${GIST_FILE}`;

  const CEL = {
    wydatki: { label: 'na wydatki' },
    wyplata: { label: 'moja wypłata' },
    pati:    { label: 'dla Pati' },
  };

  // ---------- Dane startowe (z arkusza) ----------
  const SEED = {
    version: VERSION,
    settings: { rate: DEFAULT_RATE },
    ruchy: [
      { id: 's1', kind: 'in',  cel: 'wydatki', date: '2026-09-23', amount: 650, currency: 'EUR', note: '' },
      { id: 's2', kind: 'out', date: '2026-09-30', amount: 340, currency: 'EUR', note: 'Zakupy 1429 zł (598+264+290+68+66+97+46) ≈ 340 €' },
      { id: 's3', kind: 'out', date: '2026-09-30', amount: 270, currency: 'EUR', note: 'Pozostałe wydatki do 01.10' },
      { id: 's4', kind: 'out', date: '2026-10-12', amount: 285, currency: 'PLN', note: '' },
      { id: 's5', kind: 'in',  cel: 'wydatki', date: '2026-10-13', amount: 300, currency: 'PLN', note: '' },
      { id: 's6', kind: 'in',  cel: 'pati',    date: '2026-10-13', amount: 100, currency: 'EUR', note: '' },
      { id: 'p3', kind: 'in',  cel: 'pati',    date: '2026-09-01', amount: 100, currency: 'EUR', note: '' },
    ],
    praca: [
      { id: 'p1', date: '2026-08-12', amount: 100, note: '' },
      { id: 'p2', date: '2026-08-26', amount: 200, note: '' },
      { id: 'p4', date: '2026-09-09', amount: 100, note: '' },
      { id: 'p5', date: '2026-10-07', amount: 100, note: '' },
    ],
    prace: [],
  };

  // ---------- Stan ----------
  let cloudReady = false;
  let lastSyncAt = 0;
  let lastSyncError = '';
  let pushing = false;
  let syncInfo = { password: '', token: '' };
  try {
    const rawSync = localStorage.getItem(SYNC_KEY);
    if (rawSync) syncInfo = JSON.parse(rawSync);
  } catch (e) { /* ignore */ }
  let state = load();
  if (!Array.isArray(state.prace)) state.prace = [];
  let tab = 'kasa';
  let monthFilter = { kasa: 'all', wyplata: 'all', prace: 'all', pati: 'all' };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const migrated = migrate(JSON.parse(raw));
        if (migrated) { save(migrated); return migrated; }
      }
    } catch (e) { /* ignorujemy, zaczynamy od seeda */ }
    const copy = JSON.parse(JSON.stringify(SEED));
    save(copy);
    return copy;
  }

  // ---------- Migracje ----------
  function migrate(p) {
    if (!p || typeof p !== 'object') return null;
    const rateVal = p.settings && p.settings.rate > 0 ? p.settings.rate : DEFAULT_RATE;

    // v3/v4 – ruchy + praca Pati; v4 dodaje dodatkowe roboty
    if (Array.isArray(p.ruchy) && Array.isArray(p.praca) && p.version >= 3) {
      p.version = VERSION;
      p.settings = { rate: rateVal };
      p.prace = Array.isArray(p.prace) ? p.prace : [];
      return p;
    }
    // v2 (ruchy z kategoriami rozchodów) → v4
    if (Array.isArray(p.ruchy) && Array.isArray(p.praca)) {
      return { version: VERSION, settings: { rate: rateVal }, ruchy: v2ToV3(p.ruchy), praca: p.praca, prace: [] };
    }
    // v1 (szef / wyplata / pati) → v2 → v4
    if (Array.isArray(p.szef) && Array.isArray(p.pati)) {
      const v2 = v1ToV2(p);
      return { version: VERSION, settings: { rate: rateVal }, ruchy: v2ToV3(v2.ruchy), praca: v2.praca, prace: [] };
    }
    return null;
  }

  function v1ToV2(p) {
    const ruchy = [];
    const praca = [];
    for (const e of p.szef) {
      if (e.type === 'wplata') ruchy.push({ id: e.id, kind: 'in', date: e.date, amount: +e.amount, currency: e.currency || 'EUR', cat: null, note: e.note === 'Od szefa' ? '' : (e.note || '') });
      else ruchy.push({ id: e.id, kind: 'out', date: e.date, amount: +e.amount, currency: e.currency || 'EUR', cat: 'wydatek', note: e.note || '' });
    }
    for (const e of (Array.isArray(p.wyplata) ? p.wyplata : [])) {
      ruchy.push({ id: e.id, kind: 'out', date: e.date, amount: +e.amount, currency: e.currency || 'EUR', cat: 'wyplata', note: e.note || '' });
    }
    for (const e of p.pati) {
      if (e.type === 'praca') praca.push({ id: e.id, date: e.date, amount: +e.amount, note: e.note || '' });
      else ruchy.push({ id: e.id, kind: 'out', date: e.date, amount: +e.amount, currency: 'EUR', cat: 'pati', note: e.note || '' });
    }
    return { ruchy, praca };
  }

  // W v2 wypłata / Pati były ROZCHODAMI z puli, więc użytkownik często wpisywał dwa razy:
  // „Dostałem 700 €” + „Wypłata 700 €”. Teraz to jeden wpis „Dostałem 700 € – moja wypłata”.
  // Scalamy: dla każdego rozchodu wypłata/Pati szukamy wpłaty o tej samej kwocie i walucie
  // w odległości do 7 dni i ją usuwamy.
  function v2ToV3(ruchy) {
    const ins = ruchy.filter((e) => e.kind === 'in').map((e) => ({ ...e, _used: false }));
    const out = [];
    const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
    const cleanNote = (n) => (n || '').replace(/^Wypłata dla Pati(\s*\(.*\))?$/i, '').replace(/^DO SPRAWDZENIA.*$/i, '').trim();

    for (const e of ruchy) {
      if (e.kind === 'in') continue;
      if (e.cat === 'wyplata' || e.cat === 'pati') {
        const match = ins
          .filter((i) => !i._used && i.currency === (e.currency || 'EUR') && +i.amount === +e.amount && dayDiff(i.date, e.date) <= 7)
          .sort((a, b) => dayDiff(a.date, e.date) - dayDiff(b.date, e.date))[0];
        if (match) match._used = true;
        out.push({ id: e.id, kind: 'in', cel: e.cat, date: e.date, amount: +e.amount, currency: e.currency || 'EUR', note: cleanNote(e.note) || (match && match.note) || '' });
      } else {
        const o = { id: e.id, kind: 'out', date: e.date, amount: +e.amount, currency: e.currency || 'EUR', note: e.note || '' };
        if (e.poza) o.poza = true;
        out.push(o);
      }
    }
    for (const i of ins) {
      if (i._used) continue;
      out.push({ id: i.id, kind: 'in', cel: i.cel || 'wydatki', date: i.date, amount: +i.amount, currency: i.currency || 'EUR', note: i.note === 'Od szefa' ? '' : (i.note || '') });
    }
    return out;
  }

  function save(s = state) {
    s.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    if (cloudReady) schedulePush();
  }

  function loadSync() {
    try {
      const raw = localStorage.getItem(SYNC_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return { password: '', token: '' };
  }
  function saveSync() {
    localStorage.setItem(SYNC_KEY, JSON.stringify({ password: syncInfo.password || '', token: syncInfo.token || '' }));
  }
  const syncOn = () => !!(syncInfo && syncInfo.password);

  // ---------- Chmura (zaszyfrowany gist na Twoim GitHubie) ----------
  function b64enc(u8) {
    let s = '';
    for (const b of u8) s += String.fromCharCode(b);
    return btoa(s);
  }
  function b64dec(str) {
    const bin = atob(str);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function deriveKey(password, salt) {
    const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
      raw,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function encryptPayload(password, obj) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    return { v: 1, s: b64enc(salt), i: b64enc(iv), c: b64enc(new Uint8Array(ct)) };
  }
  async function decryptPayload(password, blob) {
    if (!blob || !blob.c) return null;
    const key = await deriveKey(password, b64dec(blob.s));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64dec(blob.i) }, key, b64dec(blob.c));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  function mergeState(local, remote) {
    if (!remote) return local;
    if (!local) return remote;
    const removed = { ...(remote.removed || {}), ...(local.removed || {}) };
    const mergeList = (a, b) => {
      const m = new Map();
      for (const e of [...(b || []), ...(a || [])]) {
        if (!e || !e.id) continue;
        const rem = removed[e.id];
        if (rem && (!e.updatedAt || e.updatedAt <= rem)) continue;
        const prev = m.get(e.id);
        if (!prev || (e.updatedAt || 0) >= (prev.updatedAt || 0)) m.set(e.id, e);
      }
      return [...m.values()];
    };
    const settings = (local.updatedAt || 0) >= (remote.updatedAt || 0) ? local.settings : remote.settings;
    return {
      version: VERSION,
      settings: settings || { rate: DEFAULT_RATE },
      ruchy: mergeList(local.ruchy, remote.ruchy),
      praca: mergeList(local.praca, remote.praca),
      prace: mergeList(local.prace, remote.prace),
      removed,
      updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
    };
  }
  function payloadOf(s) {
    return {
      version: VERSION,
      settings: s.settings,
      ruchy: s.ruchy,
      praca: s.praca,
      prace: s.prace || [],
      removed: s.removed || {},
      updatedAt: s.updatedAt || Date.now(),
      gistToken: syncInfo.token || '',
    };
  }
  async function cloudPull() {
    if (!syncOn()) return;
    let text = '';
    try {
      const raw = await fetch(`${GIST_RAW}?t=${Date.now()}`, { cache: 'no-store' });
      if (raw.ok) text = await raw.text();
      else if (syncInfo.token) {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${syncInfo.token}` },
        });
        if (!res.ok) throw new Error('odczyt ' + res.status);
        const g = await res.json();
        text = (g.files && g.files[GIST_FILE] && g.files[GIST_FILE].content) || '';
      } else if (raw.status === 404) return;
      else throw new Error('odczyt ' + raw.status);
    } catch (e) {
      if (syncInfo.token) throw e;
      return;
    }
    text = (text || '').trim();
    if (!text || text === '{"v":1,"blob":""}') return;
    let blob;
    try { blob = JSON.parse(text); } catch (e) { return; }
    let remote;
    try {
      remote = await decryptPayload(syncInfo.password, blob);
    } catch (e) {
      throw new Error('złe hasło');
    }
    if (!remote) throw new Error('złe hasło');
    if (remote.gistToken && !syncInfo.token) {
      syncInfo.token = remote.gistToken;
      saveSync();
    }
    const merged = mergeState(state, remote);
    state = merged;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    lastSyncAt = Date.now();
    lastSyncError = '';
  }
  async function cloudPush() {
    if (!syncOn() || !syncInfo.token || pushing) return;
    pushing = true;
    try {
      const enc = await encryptPayload(syncInfo.password, payloadOf(state));
      const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${syncInfo.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(enc) } } }),
      });
      if (res.status === 401 || res.status === 403) throw new Error('klucz GitHub nieważny');
      if (!res.ok) throw new Error('zapis ' + res.status);
      lastSyncAt = Date.now();
      lastSyncError = '';
    } finally {
      pushing = false;
    }
  }
  let pushTimer;
  function schedulePush() {
    if (!syncOn() || !syncInfo.token) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      cloudPush().catch((e) => { lastSyncError = e.message || 'błąd zapisu'; });
    }, 800);
  }
  async function startCloud() {
    if (!syncOn()) { cloudReady = true; return; }
    try {
      await cloudPull();
    } catch (e) {
      lastSyncError = e.message || 'błąd odczytu';
    }
    cloudReady = true;
    if (syncInfo.token) {
      try { await cloudPush(); } catch (e) { lastSyncError = e.message || 'błąd zapisu'; }
    }
    render();
    setInterval(() => {
      if (!syncOn() || document.hidden) return;
      cloudPull().then(() => render()).catch((e) => { lastSyncError = e.message || 'błąd odczytu'; });
    }, 25000);
  }

  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  }

  // ---------- Formatowanie ----------
  const nf = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (v, cur) => `${nf.format(v)} ${cur === 'PLN' ? 'zł' : '€'}`;
  const rate = () => (state.settings && state.settings.rate > 0 ? state.settings.rate : DEFAULT_RATE);
  const plnToEur = (v) => v / rate();
  const rateText = () => `1 € = ${nf.format(rate())} zł`;
  const MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
  const MONTHS_FULL = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];

  function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }
  function todayISO() {
    const d = new Date();
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  }
  function monthKey(iso) { return iso.slice(0, 7); }
  function monthLabel(key) { const [y, m] = key.split('-'); return `${MONTHS[+m - 1]} ${y}`; }
  function monthLabelFull(key) { const [y, m] = key.split('-'); return `${MONTHS_FULL[+m - 1]} ${y}`; }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function sortDesc(list) {
    return [...list].sort((a, b) => (b.date.localeCompare(a.date)) || String(b.id).localeCompare(String(a.id)));
  }

  // ---------- Dane wg zakładek ----------
  const kasaList = () => state.ruchy.filter((e) => e.kind === 'out' || e.cel === 'wydatki' || !e.cel);
  const wyplataList = () => state.ruchy.filter((e) => e.kind === 'in' && e.cel === 'wyplata');
  const patiList = () => state.ruchy.filter((e) => e.kind === 'in' && e.cel === 'pati');

  function sums(list) {
    const r = { in: { EUR: 0, PLN: 0 }, out: { EUR: 0, PLN: 0 }, poza: { EUR: 0, PLN: 0 }, saldo: { EUR: 0, PLN: 0 } };
    for (const e of list) {
      const c = e.currency === 'PLN' ? 'PLN' : 'EUR';
      if (e.kind === 'in') r.in[c] += +e.amount;
      else if (e.poza) r.poza[c] += +e.amount;
      else r.out[c] += +e.amount;
    }
    r.saldo.EUR = r.in.EUR - r.out.EUR;
    r.saldo.PLN = r.in.PLN - r.out.PLN;
    return r;
  }
  function eurToPln(v) { return v * rate(); }
  function netSaldo(s) {
    return {
      eur: s.saldo.EUR + plnToEur(s.saldo.PLN),
      pln: eurToPln(s.saldo.EUR) + s.saldo.PLN,
    };
  }
  function saldoPati() {
    const earned = state.praca.reduce((s, e) => s + +e.amount, 0);
    const paid = patiList().reduce((s, e) => s + (e.currency === 'PLN' ? plnToEur(+e.amount) : +e.amount), 0);
    return { earned, paid, due: earned - paid };
  }
  function extraAmount(e) {
    const stawka = +(e.stawka != null ? e.stawka : e.amount) || 0;
    const hours = +e.hours || 0;
    const total = hours > 0 ? stawka * hours : stawka;
    return Math.round(total * 100) / 100;
  }
  function extraHoursLabel(h) {
    if (!(h > 0)) return '';
    const n = Math.round(+h * 100) / 100;
    return String(n).replace('.', ',');
  }
  function extraRateLine(e) {
    const cur = e.currency === 'PLN' ? 'PLN' : 'EUR';
    const stawka = +(e.stawka != null ? e.stawka : e.amount) || 0;
    const hours = +e.hours || 0;
    if (hours > 0) return `${money(stawka, cur)}/h × ${extraHoursLabel(hours)} h`;
    return `stawka ${money(stawka, cur)}`;
  }
  function saldoPrace() {
    const earned = { EUR: 0, PLN: 0 };
    const paid = { EUR: 0, PLN: 0 };
    let waiting = 0;
    for (const e of (state.prace || [])) {
      const c = e.currency === 'PLN' ? 'PLN' : 'EUR';
      const amt = extraAmount(e);
      earned[c] += amt;
      if (e.paid) paid[c] += amt;
      else waiting += 1;
    }
    const due = { EUR: earned.EUR - paid.EUR, PLN: earned.PLN - paid.PLN };
    return {
      earned,
      paid,
      due,
      waiting,
      netDueEur: due.EUR + plnToEur(due.PLN),
      netEarnedEur: earned.EUR + plnToEur(earned.PLN),
      netPaidEur: paid.EUR + plnToEur(paid.PLN),
    };
  }

  // ---------- Renderowanie ----------
  const $view = document.getElementById('view');
  const $title = document.getElementById('title');
  const $fab = document.getElementById('fab');

  function render() {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $fab.hidden = tab === 'wiecej';
    if (tab === 'kasa') renderKasa();
    else if (tab === 'wyplata') renderWyplata();
    else if (tab === 'prace') renderPrace();
    else if (tab === 'pati') renderPati();
    else renderWiecej();
    $view.scrollTop = 0;
  }

  function monthChipsHTML(list, which) {
    const months = [...new Set(list.map((e) => monthKey(e.date)))].sort().reverse();
    if (months.length < 2) return '';
    const cur = monthFilter[which];
    return `<div class="chips">
      <button class="chip ${cur === 'all' ? 'active' : ''}" data-month="all">Wszystko</button>
      ${months.map((m) => `<button class="chip ${cur === m ? 'active' : ''}" data-month="${m}">${monthLabel(m)}</button>`).join('')}
    </div>`;
  }
  function applyMonth(list, which) {
    const m = monthFilter[which];
    return m === 'all' ? list : list.filter((e) => monthKey(e.date) === m);
  }

  function amtHTML(e) {
    const plus = e.kind === 'in';
    const cls = plus ? 'plus' : (e.poza ? 'neutral' : 'minus');
    return `<div class="amt ${cls}">${plus ? '+' : '−'}${money(e.amount, e.currency)}${e.currency === 'PLN' ? `<small>≈ ${money(plnToEur(e.amount), 'EUR')}</small>` : ''}</div>`;
  }

  function ruchItemHTML(e) {
    const plus = e.kind === 'in';
    let title, sub;
    if (plus) {
      title = e.note || 'Od szefa';
      sub = `dostałem · ${(CEL[e.cel] || CEL.wydatki).label}`;
    } else {
      title = e.note || 'Wydatek';
      sub = e.poza ? 'wydałem · ze swojego' : 'wydałem';
    }
    return `<button class="item" data-edit="ruch" data-id="${esc(e.id)}">
      <div class="date"><b>${e.date.slice(8, 10)}</b>${MONTHS[+e.date.slice(5, 7) - 1]}</div>
      <div class="note">${esc(title)}<small>${sub}</small></div>
      ${amtHTML(e)}
    </button>`;
  }

  function renderKasa() {
    $title.textContent = 'Kasa na wydatki';
    const all = kasaList();
    const s = sums(all);
    const net = netSaldo(s);
    const filtered = sortDesc(applyMonth(all, 'kasa'));
    const minusHint = net.eur < 0
      ? '<p class="hint">Czerwone = nawet po przeliczeniu wydałeś więcej, niż szef dał na wydatki.</p>'
      : '';
    let split;
    if (s.saldo.EUR > 0 && s.saldo.PLN < 0) {
      split = `${money(s.saldo.EUR, 'EUR')} pokrywa ${money(s.saldo.PLN, 'PLN')}`;
    } else if (s.saldo.PLN > 0 && s.saldo.EUR < 0) {
      split = `${money(s.saldo.PLN, 'PLN')} pokrywa ${money(s.saldo.EUR, 'EUR')}`;
    } else {
      split = `osobno: ${money(s.saldo.EUR, 'EUR')} i ${money(s.saldo.PLN, 'PLN')}`;
    }

    let html = `
      <div class="cards single">
        <button class="card card-btn" data-action="rate">
          <div class="label">Zostało</div>
          <div class="value ${net.eur < 0 ? 'neg' : ''}">${money(net.eur, 'EUR')}</div>
          <div class="sub">= ${money(net.pln, 'PLN')} · ${split}<br>kurs ${rateText()} · dotknij, żeby zmienić</div>
        </button>
      </div>
      ${minusHint}
      ${(s.poza.EUR || s.poza.PLN) ? `<p class="hint">Ze swojego zapłaciłeś: ${[s.poza.EUR && money(s.poza.EUR, 'EUR'), s.poza.PLN && money(s.poza.PLN, 'PLN')].filter(Boolean).join(' + ')} — to nie schodzi z kasy szefa.</p>` : ''}
      ${monthChipsHTML(all, 'kasa')}
    `;
    if (!filtered.length) {
      html += `<div class="empty">Brak wpisów.<br>Dotknij <b>+</b> na dole.</div>`;
    } else {
      html += listByMonthHTML(filtered, ruchItemHTML);
    }
    $view.innerHTML = html;
  }

  function renderWyplata() {
    $title.textContent = 'Moja wypłata';
    const all = wyplataList();
    const filtered = sortDesc(applyMonth(all, 'wyplata'));
    const s = sums(filtered);
    const m = monthFilter.wyplata;
    const label = m === 'all' ? 'Razem' : monthLabelFull(m);

    let html = `
      <div class="cards">
        <div class="card">
          <div class="label">${label} €</div>
          <div class="value">${money(s.in.EUR, 'EUR')}</div>
        </div>
        <div class="card">
          <div class="label">${label} zł</div>
          <div class="value">${money(s.in.PLN, 'PLN')}</div>
        </div>
      </div>
      ${monthChipsHTML(all, 'wyplata')}
    `;
    if (!filtered.length) {
      html += `<div class="empty">Brak wypłat.<br>Dotknij <b>+</b>, żeby dodać wypłatę od szefa i wpisać, za co.</div>`;
    } else {
      html += listByMonthHTML(filtered, (e) => `<button class="item" data-edit="ruch" data-id="${esc(e.id)}">
        <div class="date"><b>${e.date.slice(8, 10)}</b>${MONTHS[+e.date.slice(5, 7) - 1]}</div>
        <div class="note">${esc(e.note) || 'Wypłata'}<small>od szefa</small></div>
        ${amtHTML(e)}
      </button>`);
    }
    $view.innerHTML = html;
  }

  function renderPrace() {
    $title.textContent = 'Dodatkowe prace';
    const all = state.prace || [];
    const s = saldoPrace();
    const filtered = sortDesc(applyMonth(all, 'prace'));
    const dueNeg = s.netDueEur < 0;
    const dueCls = s.netDueEur > 0 ? 'pos' : (dueNeg ? 'neg' : '');
    let html = `
      <div class="cards single">
        <div class="card">
          <div class="label">${s.netDueEur > 0 ? 'Jeszcze mi wiszą' : (dueNeg ? 'Dostałem za dużo' : 'Wszystko wypłacone')}</div>
          <div class="value ${dueCls}">${money(s.netDueEur, 'EUR')}</div>
          <div class="sub">zarobione ${money(s.netEarnedEur, 'EUR')} · dostałem ${money(s.netPaidEur, 'EUR')}${s.waiting ? ` · czeka ${s.waiting}` : ''}<br>osobno od zwykłej wypłaty · kurs ${rateText()}</div>
        </div>
      </div>
      ${monthChipsHTML(all, 'prace')}
    `;
    if (!filtered.length) {
      html += `<div class="empty">Brak dodatkowych robót.<br>Dotknij <b>+</b>, zapisz kiedy była i za ile, a później odhacz, że dostałeś kasę.</div>`;
    } else {
      html += listByMonthHTML(filtered, (e) => {
        const amt = extraAmount(e);
        const rateLine = extraRateLine(e);
        const sub = e.paid
          ? `${rateLine} · dostałem ${e.paidDate ? fmtDate(e.paidDate) : ''}`
          : `${rateLine} · czekam na kasę`;
        return `<button class="item" data-edit="extra" data-id="${esc(e.id)}">
          <div class="date"><b>${e.date.slice(8, 10)}</b>${MONTHS[+e.date.slice(5, 7) - 1]}</div>
          <div class="note">${esc(e.note) || 'Dodatkowa robota'}<small>${esc(sub)}</small></div>
          <div class="amt ${e.paid ? 'plus' : 'wait'}">${e.paid ? '+' : ''}${money(amt, e.currency)}</div>
        </button>`;
      });
    }
    $view.innerHTML = html;
  }

  function renderPati() {
    $title.textContent = 'Pati u Svena';
    const s = saldoPati();
    const items = [
      ...state.praca.map((e) => ({ ...e, _t: 'praca' })),
      ...patiList().map((e) => ({ ...e, _t: 'ruch' })),
    ];
    const filtered = sortDesc(applyMonth(items, 'pati'));

    let html = `
      <div class="cards single">
        <div class="card">
          <div class="label">Sven jeszcze wisi Pati</div>
          <div class="value ${s.due > 0 ? 'pos' : (s.due < 0 ? 'neg' : '')}">${money(s.due, 'EUR')}</div>
          <div class="sub">zarobione ${money(s.earned, 'EUR')} · dostała ${money(s.paid, 'EUR')} · dni pracy: ${state.praca.length}</div>
        </div>
      </div>
      ${monthChipsHTML(items, 'pati')}
    `;
    if (!filtered.length) {
      html += `<div class="empty">Brak wpisów.<br>Dotknij <b>+</b>, żeby dodać dzień pracy albo kasę dla Pati.</div>`;
    } else {
      html += listByMonthHTML(filtered, (e) => {
        if (e._t === 'praca') {
          return `<button class="item" data-edit="praca" data-id="${esc(e.id)}">
            <div class="date"><b>${e.date.slice(8, 10)}</b>${MONTHS[+e.date.slice(5, 7) - 1]}</div>
            <div class="note">Praca u Svena<small>${e.note ? esc(e.note) : 'zarobione'}</small></div>
            <div class="amt plus">+${money(e.amount, 'EUR')}</div>
          </button>`;
        }
        return `<button class="item" data-edit="ruch" data-id="${esc(e.id)}">
          <div class="date"><b>${e.date.slice(8, 10)}</b>${MONTHS[+e.date.slice(5, 7) - 1]}</div>
          <div class="note">Pati dostała kasę<small>${e.note ? esc(e.note) : 'od szefa'}</small></div>
          <div class="amt minus">−${money(e.amount, e.currency)}</div>
        </button>`;
      });
    }
    $view.innerHTML = html;
  }

  function listByMonthHTML(sorted, itemFn) {
    let html = '';
    let curMonth = null;
    let open = false;
    for (const e of sorted) {
      const m = monthKey(e.date);
      if (m !== curMonth) {
        if (open) html += '</div>';
        html += `<div class="section-title"><span>${monthLabelFull(m)}</span></div><div class="list">`;
        curMonth = m; open = true;
      }
      html += itemFn(e);
    }
    if (open) html += '</div>';
    return html;
  }

  function renderWiecej() {
    $title.textContent = 'Więcej';
    const canShare = !!navigator.share;
    const connected = syncOn();
    const syncStatus = !connected
      ? 'Wyłączona – dane tylko na tym urządzeniu'
      : lastSyncError
        ? `Problem: ${lastSyncError}`
        : lastSyncAt
          ? `Połączono · ${fmtDate(todayISO())} ${new Date(lastSyncAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}`
          : 'Połączono · czekam na sieć';
    $view.innerHTML = `
      <div class="section-title"><span>Wszystkie urządzenia</span></div>
      <p class="hint">${connected ? 'To samo hasło wpisz na telefonie, komputerze i tablecie – wpisy same się zsynchronizują.' : 'Włącz, żeby mieć te same rozliczenia na telefonie i komputerze.'}</p>
      <div class="menu">
        ${connected
          ? `<button class="btn block" data-action="sync-now"><span>${esc(syncStatus)}</span><span>🔄</span></button>
             <button class="btn block danger" data-action="sync-off"><span>Wyłącz synchronizację na tym urządzeniu</span></button>`
          : `<button class="btn block" data-action="sync-on"><span>Włącz synchronizację</span><span>☁️</span></button>`}
      </div>

      <div class="section-title"><span>Ustawienia</span></div>
      <div class="list">
        <label class="item setting">
          <div class="note">Kurs euro<small>ile złotych za 1 €</small></div>
          <input type="number" id="rate-input" inputmode="decimal" step="0.01" min="0.01" value="${rate()}">
          <span class="muted">zł</span>
        </label>
      </div>
      <p class="hint">Używany tylko do podglądu „≈ … €” przy kwotach w złotówkach.</p>

      <div class="section-title"><span>Podsumowanie</span></div>
      <pre class="summary">${esc(summaryText())}</pre>
      <div class="menu">
        <button class="btn block" data-action="copy"><span>Kopiuj podsumowanie</span><span>📋</span></button>
        ${canShare ? `<button class="btn block" data-action="share"><span>Wyślij podsumowanie…</span><span>📤</span></button>` : ''}
      </div>

      <div class="section-title"><span>Aktualizacja</span></div>
      <p class="hint">Jeśli na ekranie Kasa nadal widać osobno „Zostało €” i „Zostało zł”, telefon trzyma starą wersję.</p>
      <div class="menu">
        <button class="btn block" data-action="reload"><span>Pobierz nową wersję</span><span>🔄</span></button>
      </div>

      <div class="section-title"><span>Kopia zapasowa</span></div>
      <p class="hint">${connected ? 'Kopia w chmurze jest zaszyfrowana hasłem. Na wszelki wypadek możesz też zapisać plik u siebie.' : 'Bez synchronizacji dane są tylko na tym urządzeniu. Co jakiś czas zrób eksport.'}</p>
      <div class="menu">
        <button class="btn block" data-action="export"><span>Eksportuj dane (plik JSON)</span><span>💾</span></button>
        <button class="btn block" data-action="import"><span>Wczytaj dane z pliku</span><span>📂</span></button>
        <button class="btn block danger" data-action="reset"><span>Wyczyść wszystkie dane</span><span>🗑️</span></button>
      </div>

      <div class="section-title"><span>Instalacja na iPhonie</span></div>
      <p class="hint">W Safari dotknij przycisku <b>Udostępnij</b> (kwadrat ze strzałką) → <b>Do ekranu początkowego</b>. Aplikacja będzie działać jak zwykła apka, także bez internetu.</p>
    `;
  }

  // ---------- Podsumowanie tekstowe ----------
  function pairText(v) {
    const parts = [];
    if (v.EUR) parts.push(money(v.EUR, 'EUR'));
    if (v.PLN) parts.push(money(v.PLN, 'PLN'));
    return parts.length ? parts.join(' + ') : '—';
  }
  function summaryText() {
    const k = sums(kasaList());
    const w = sums(wyplataList());
    const p = saldoPati();
    const lines = [];
    lines.push(`ROZLICZENIE – stan na ${fmtDate(todayISO())}`);
    lines.push('');
    lines.push('KASA NA WYDATKI');
    lines.push(`Dostałem:  ${money(k.in.EUR, 'EUR')}  |  ${money(k.in.PLN, 'PLN')}`);
    lines.push(`Wydałem:   ${money(k.out.EUR, 'EUR')}  |  ${money(k.out.PLN, 'PLN')}`);
    const kn = netSaldo(k);
    lines.push(`ZOSTAŁO:   ${money(kn.eur, 'EUR')}  ≈  ${money(kn.pln, 'PLN')}  (kurs ${rateText()})`);
    lines.push(`  (osobno: ${money(k.saldo.EUR, 'EUR')}  |  ${money(k.saldo.PLN, 'PLN')})`);
    if (k.poza.EUR || k.poza.PLN) lines.push(`Ze swojego zapłaciłem: ${pairText(k.poza)}`);
    for (const e of sortDesc(kasaList()).reverse()) {
      const sign = e.kind === 'in' ? '+' : '−';
      lines.push(`  ${fmtDate(e.date)}  ${sign}${money(e.amount, e.currency)}${e.poza ? ' (ze swojego)' : ''}${e.note ? '  ' + e.note : ''}`);
    }
    lines.push('');
    lines.push('MOJA WYPŁATA');
    lines.push(`Razem: ${pairText(w.in)}`);
    for (const e of sortDesc(wyplataList()).reverse()) {
      lines.push(`  ${fmtDate(e.date)}  ${money(e.amount, e.currency)}${e.note ? '  ' + e.note : ''}`);
    }
    lines.push('');
    lines.push('PATI U SVENA');
    lines.push(`Zarobione: ${money(p.earned, 'EUR')}, dostała: ${money(p.paid, 'EUR')}, do zapłaty: ${money(p.due, 'EUR')}`);
    for (const e of sortDesc(state.praca).reverse()) {
      lines.push(`  ${fmtDate(e.date)}  praca  ${money(e.amount, 'EUR')}${e.note ? '  ' + e.note : ''}`);
    }
    for (const e of sortDesc(patiList()).reverse()) {
      lines.push(`  ${fmtDate(e.date)}  dostała  ${money(e.amount, e.currency)}${e.note ? '  ' + e.note : ''}`);
    }
    lines.push('');
    lines.push('DODATKOWE PRACE');
    const x = saldoPrace();
    lines.push(`Zarobione: ${money(x.netEarnedEur, 'EUR')}, dostałem: ${money(x.netPaidEur, 'EUR')}, jeszcze wiszą: ${money(x.netDueEur, 'EUR')}`);
    for (const e of sortDesc(state.prace || []).reverse()) {
      const status = e.paid ? `dostałem${e.paidDate ? ' ' + fmtDate(e.paidDate) : ''}` : 'czekam';
      lines.push(`  ${fmtDate(e.date)}  ${extraRateLine(e)}  ${money(extraAmount(e), e.currency)}  ${status}${e.note ? '  ' + e.note : ''}`);
    }
    return lines.join('\n');
  }

  // ---------- Toast ----------
  const $toast = document.getElementById('toast');
  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, 2200);
  }

  // ---------- Dialogi ----------
  const dlgRuch = document.getElementById('dlg-ruch');
  const formRuch = document.getElementById('form-ruch');
  const dlgPraca = document.getElementById('dlg-praca');
  const formPraca = document.getElementById('form-praca');
  const dlgExtra = document.getElementById('dlg-extra');
  const formExtra = document.getElementById('form-extra');
  const dlgKasaWybor = document.getElementById('dlg-kasa-wybor');
  const dlgPatiWybor = document.getElementById('dlg-pati-wybor');
  const dlgSync = document.getElementById('dlg-sync');
  const formSync = document.getElementById('form-sync');

  const NOTE_PLACEHOLDER = {
    out: 'np. paliwo, materiały…',
    wydatki: 'np. zaliczka na materiały…',
    wyplata: 'np. za wrzesień, premia…',
    pati: 'np. za sierpień…',
  };

  function syncRuchForm() {
    const isIn = formRuch.kind.value === 'in';
    formRuch.classList.toggle('is-in', isIn);
    formRuch.classList.toggle('is-out', !isIn);
    const key = isIn ? formRuch.cel.value : 'out';
    formRuch.note.placeholder = NOTE_PLACEHOLDER[key] || '';
    document.getElementById('note-label').textContent = isIn ? 'Opis (opcjonalnie)' : 'Na co';
    const hints = {
      wydatki: 'Ta kasa zostaje tu. Potem wpisujesz, na co ją wydałeś.',
      wyplata: 'To Twoje pieniądze. Widać je na karcie Wypłata, nie odejmuje się od „Zostało”.',
      pati: 'To kasa dla Pati. Widać ją na karcie Pati, nie odejmuje się od „Zostało”.',
    };
    const $hint = document.getElementById('cel-hint');
    if ($hint) $hint.textContent = isIn ? (hints[formRuch.cel.value] || '') : '';
  }

  // preset: { kind, cel }
  function openRuch(entry, preset = {}) {
    formRuch.reset();
    formRuch.id.value = entry ? entry.id : '';
    formRuch.kind.value = entry ? entry.kind : (preset.kind || 'out');
    formRuch.cel.value = entry ? (entry.cel || 'wydatki') : (preset.cel || 'wydatki');
    formRuch.date.value = entry ? entry.date : todayISO();
    formRuch.amount.value = entry ? entry.amount : '';
    formRuch.currency.value = entry ? entry.currency : 'EUR';
    formRuch.note.value = entry ? entry.note : '';
    formRuch.poza.checked = !!(entry && entry.poza);
    document.getElementById('dlg-ruch-title').textContent = entry ? 'Edytuj wpis' : 'Nowy wpis';
    document.getElementById('btn-ruch-delete').hidden = !entry;
    syncRuchForm();
    dlgRuch.showModal();
    if (!entry) setTimeout(() => formRuch.amount.focus(), 50);
  }

  function openPraca(entry) {
    formPraca.reset();
    formPraca.id.value = entry ? entry.id : '';
    formPraca.date.value = entry ? entry.date : todayISO();
    formPraca.amount.value = entry ? entry.amount : 100;
    formPraca.note.value = entry ? entry.note : '';
    document.getElementById('dlg-praca-title').textContent = entry ? 'Edytuj dzień pracy' : 'Praca u Svena';
    document.getElementById('btn-praca-delete').hidden = !entry;
    dlgPraca.showModal();
  }

  function extraTotalFromForm() {
    const stawka = parseFloat(String(formExtra.stawka.value).replace(',', '.'));
    const hours = parseFloat(String(formExtra.hours.value).replace(',', '.'));
    if (!(stawka >= 0)) return null;
    const total = hours > 0 ? stawka * hours : stawka;
    return { stawka, hours: hours > 0 ? hours : 0, total: Math.round(total * 100) / 100 };
  }
  function syncExtraForm() {
    const paid = formExtra.paid.checked;
    formExtra.classList.toggle('is-paid', paid);
    if (paid && !formExtra.paidDate.value) formExtra.paidDate.value = todayISO();
    const cur = formExtra.currency.value;
    const t = extraTotalFromForm();
    const $hint = document.getElementById('extra-total-hint');
    if (!t) {
      $hint.textContent = 'Zostaw godziny puste, jeśli stawka to cała kwota. Jak podasz godziny, apka policzy stawkę × godziny.';
      return;
    }
    if (t.hours > 0) {
      $hint.textContent = `${money(t.stawka, cur)}/h × ${extraHoursLabel(t.hours)} h = ${money(t.total, cur)}`;
    } else {
      $hint.textContent = `Do zapisania: ${money(t.total, cur)} (cała robota)`;
    }
  }
  function openExtra(entry) {
    formExtra.reset();
    formExtra.id.value = entry ? entry.id : '';
    formExtra.date.value = entry ? entry.date : todayISO();
    formExtra.note.value = entry ? (entry.note || '') : '';
    formExtra.stawka.value = entry ? (entry.stawka != null ? entry.stawka : entry.amount) : '';
    formExtra.currency.value = entry ? (entry.currency || 'EUR') : 'EUR';
    formExtra.hours.value = entry && entry.hours > 0 ? entry.hours : '';
    formExtra.paid.checked = !!(entry && entry.paid);
    formExtra.paidDate.value = entry && entry.paidDate ? entry.paidDate : '';
    document.getElementById('dlg-extra-title').textContent = entry ? 'Edytuj robotę' : 'Dodatkowa robota';
    document.getElementById('btn-extra-delete').hidden = !entry;
    syncExtraForm();
    dlgExtra.showModal();
    if (!entry) setTimeout(() => formExtra.note.focus(), 50);
  }

  formRuch.addEventListener('change', (ev) => {
    if (ev.target.name === 'kind' || ev.target.name === 'cel') syncRuchForm();
  });

  formRuch.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const amount = parseFloat(String(formRuch.amount.value).replace(',', '.'));
    if (!(amount >= 0)) return;
    const kind = formRuch.kind.value;
    const entry = {
      id: formRuch.id.value || uid(),
      kind,
      date: formRuch.date.value,
      amount: Math.round(amount * 100) / 100,
      currency: formRuch.currency.value,
      note: formRuch.note.value.trim(),
    };
    if (kind === 'in') entry.cel = formRuch.cel.value;
    else if (formRuch.poza.checked) entry.poza = true;
    upsert(state.ruchy, entry);
    save(); dlgRuch.close(); render();
    toast('Zapisano');
  });

  let syncNeedToken = false;
  function openSyncDlg() {
    formSync.reset();
    syncNeedToken = false;
    document.getElementById('sync-token-wrap').hidden = true;
    document.getElementById('sync-password2-wrap').hidden = false;
    document.getElementById('dlg-sync-ok').textContent = 'Dalej';
    dlgSync.showModal();
    setTimeout(() => formSync.password.focus(), 50);
  }
  formSync.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const p = formSync.password.value;
    if (p.length < 6) { toast('Hasło min. 6 znaków'); return; }
    if (!syncNeedToken && p !== formSync.password2.value) { toast('Hasła nie są takie same'); return; }
    const okBtn = document.getElementById('dlg-sync-ok');
    okBtn.disabled = true;
    try {
      if (!syncNeedToken) {
        syncInfo = { password: p, token: syncInfo.token || '' };
        try {
          await cloudPull();
          if (syncInfo.token) {
            saveSync();
            cloudReady = true;
            dlgSync.close();
            render();
            toast('Połączono – dane jak na innych urządzeniach');
            cloudPush().catch(() => {});
            return;
          }
        } catch (e) {
          if (/złe hasło/.test(e.message || '')) { toast('Złe hasło'); return; }
        }
        syncNeedToken = true;
        document.getElementById('sync-token-wrap').hidden = false;
        document.getElementById('sync-password2-wrap').hidden = true;
        okBtn.textContent = 'Połącz';
        toast('Jeszcze jeden krok, tylko na tym urządzeniu');
        return;
      }
      const token = formSync.token.value.trim();
      if (!/^(ghp_|gho_|github_pat_)/.test(token)) {
        toast('Wklej klucz z GitHuba (zaczyna się od ghp_)');
        return;
      }
      syncInfo = { password: p, token };
      saveSync();
      cloudReady = true;
      await cloudPull();
      await cloudPush();
      dlgSync.close();
      render();
      toast('Synchronizacja włączona');
    } catch (e) {
      toast(e.message || 'Nie udało się połączyć');
    } finally {
      okBtn.disabled = false;
    }
  });

  formExtra.addEventListener('change', syncExtraForm);
  formExtra.addEventListener('input', (ev) => {
    if (ev.target.name === 'stawka' || ev.target.name === 'hours' || ev.target.name === 'currency') syncExtraForm();
  });
  formExtra.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const t = extraTotalFromForm();
    if (!t || !(t.total >= 0)) return;
    const paid = formExtra.paid.checked;
    const entry = {
      id: formExtra.id.value || uid(),
      date: formExtra.date.value,
      stawka: t.stawka,
      hours: t.hours,
      amount: t.total,
      currency: formExtra.currency.value,
      note: formExtra.note.value.trim(),
      paid,
      paidDate: paid ? (formExtra.paidDate.value || todayISO()) : '',
    };
    if (!state.prace) state.prace = [];
    upsert(state.prace, entry);
    save(); dlgExtra.close(); render();
    toast(paid ? 'Zapisano – kasa otrzymana' : 'Zapisano – czekam na kasę');
  });

  formPraca.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const amount = parseFloat(String(formPraca.amount.value).replace(',', '.'));
    if (!(amount >= 0)) return;
    const entry = {
      id: formPraca.id.value || uid(),
      date: formPraca.date.value,
      amount: Math.round(amount * 100) / 100,
      note: formPraca.note.value.trim(),
    };
    upsert(state.praca, entry);
    save(); dlgPraca.close(); render();
    toast('Zapisano');
  });

  document.getElementById('btn-ruch-delete').addEventListener('click', () => {
    if (!confirm('Usunąć ten wpis?')) return;
    removeEntry('ruchy', formRuch.id.value);
    save(); dlgRuch.close(); render();
    toast('Usunięto');
  });
  document.getElementById('btn-praca-delete').addEventListener('click', () => {
    if (!confirm('Usunąć ten dzień pracy?')) return;
    removeEntry('praca', formPraca.id.value);
    save(); dlgPraca.close(); render();
    toast('Usunięto');
  });
  document.getElementById('btn-extra-delete').addEventListener('click', () => {
    if (!confirm('Usunąć tę robotę?')) return;
    removeEntry('prace', formExtra.id.value);
    save(); dlgExtra.close(); render();
    toast('Usunięto');
  });

  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => b.closest('dialog').close());
  });
  [dlgRuch, dlgPraca, dlgExtra, dlgKasaWybor, dlgPatiWybor, dlgSync].forEach((d) => {
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
  });
  dlgKasaWybor.querySelectorAll('[data-kasa-add]').forEach((b) => {
    b.addEventListener('click', () => {
      dlgKasaWybor.close();
      if (b.dataset.kasaAdd === 'in') openRuch(null, { kind: 'in', cel: 'wydatki' });
      else openRuch(null, { kind: 'out' });
    });
  });
  dlgPatiWybor.querySelectorAll('[data-pati-add]').forEach((b) => {
    b.addEventListener('click', () => {
      dlgPatiWybor.close();
      if (b.dataset.patiAdd === 'praca') openPraca(null);
      else openRuch(null, { kind: 'in', cel: 'pati' });
    });
  });

  function upsert(list, entry) {
    entry.updatedAt = Date.now();
    const i = list.findIndex((e) => e.id === entry.id);
    if (i >= 0) list[i] = entry; else list.push(entry);
  }
  function removeEntry(kind, id) {
    state.removed = state.removed || {};
    state.removed[id] = Date.now();
    state[kind] = state[kind].filter((e) => e.id !== id);
  }

  // ---------- Zdarzenia ----------
  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => { tab = b.dataset.tab; render(); });
  });

  $fab.addEventListener('click', () => {
    if (tab === 'kasa') dlgKasaWybor.showModal();
    else if (tab === 'wyplata') openRuch(null, { kind: 'in', cel: 'wyplata' });
    else if (tab === 'prace') openExtra(null);
    else if (tab === 'pati') dlgPatiWybor.showModal();
  });

  $view.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (chip) {
      if (chip.dataset.month) monthFilter[tab] = chip.dataset.month;
      render();
      return;
    }
    const item = ev.target.closest('[data-edit]');
    if (item) {
      if (item.dataset.edit === 'ruch') {
        const entry = state.ruchy.find((e) => e.id === item.dataset.id);
        if (entry) openRuch(entry);
      } else if (item.dataset.edit === 'extra') {
        const entry = (state.prace || []).find((e) => e.id === item.dataset.id);
        if (entry) openExtra(entry);
      } else {
        const entry = state.praca.find((e) => e.id === item.dataset.id);
        if (entry) openPraca(entry);
      }
      return;
    }
    const act = ev.target.closest('[data-action]');
    if (act) handleAction(act.dataset.action);
  });

  $view.addEventListener('change', (ev) => {
    if (ev.target.id !== 'rate-input') return;
    const v = parseFloat(String(ev.target.value).replace(',', '.'));
    if (!(v > 0)) { ev.target.value = rate(); toast('Podaj kurs większy od zera'); return; }
    state.settings = { ...(state.settings || {}), rate: Math.round(v * 10000) / 10000 };
    save(); render();
    toast(`Kurs: ${rateText()}`);
  });

  async function handleAction(action) {
    if (action === 'rate') {
      const v = prompt('Kurs euro – ile złotych za 1 €?', String(rate()).replace('.', ','));
      if (v === null) return;
      const n = parseFloat(String(v).replace(',', '.'));
      if (!(n > 0)) { toast('Podaj kurs większy od zera'); return; }
      state.settings = { ...(state.settings || {}), rate: Math.round(n * 10000) / 10000 };
      save(); render();
      toast(`Kurs: ${rateText()}`);
    } else if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(summaryText());
        toast('Skopiowano do schowka');
      } catch (e) {
        toast('Nie udało się skopiować');
      }
    } else if (action === 'share') {
      try {
        await navigator.share({ title: 'Rozliczenie', text: summaryText() });
      } catch (e) { /* anulowane */ }
    } else if (action === 'export') {
      exportJSON();
    } else if (action === 'import') {
      document.getElementById('file-import').click();
    } else if (action === 'sync-on') {
      openSyncDlg();
    } else if (action === 'sync-off') {
      if (!confirm('Wyłączyć synchronizację na TYM urządzeniu? Dane zostaną tu lokalnie. Inne urządzenia dalej będą zsynchronizowane.')) return;
      syncInfo = { password: '', token: '' };
      saveSync();
      render();
      toast('Synchronizacja wyłączona tutaj');
    } else if (action === 'sync-now') {
      toast('Odświeżam…');
      try {
        await cloudPull();
        await cloudPush();
        render();
        toast('Zsynchronizowano');
      } catch (e) {
        lastSyncError = e.message || 'błąd';
        render();
        toast(lastSyncError);
      }
    } else if (action === 'reload') {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (e) { /* iOS czasem rzuca – i tak przeładowujemy */ }
      location.reload();
    } else if (action === 'reset') {
      if (!confirm('Na pewno usunąć WSZYSTKIE dane? Tej operacji nie da się cofnąć.')) return;
      if (!confirm('Ostatni raz: usunąć wszystko?')) return;
      state = { version: VERSION, settings: { rate: rate() }, ruchy: [], praca: [], prace: [], removed: {} };
      save(); render();
      toast('Dane wyczyszczone');
    }
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rozliczenia-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    toast('Plik zapisany');
  }

  document.getElementById('file-import').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const migrated = migrate(JSON.parse(await file.text()));
      if (!migrated) throw new Error('zły format');
      if (!confirm(`Wczytać ${migrated.ruchy.length} wpisów, ${migrated.praca.length} dni Pati i ${(migrated.prace || []).length} dodatkowych robót? Obecne dane zostaną zastąpione.`)) return;
      state = migrated;
      save(); render();
      toast('Dane wczytane');
    } catch (e) {
      toast('Nie udało się wczytać pliku');
    }
  });

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.update().catch(() => {});
        if (reg.waiting) reg.waiting.postMessage('skipWaiting');
      }).catch(() => {});
    });
  }

  render();
  startCloud();
})();
