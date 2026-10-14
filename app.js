/* Rozliczenia – prosta PWA, dane trzymane w localStorage telefonu.
 *
 * Model (wersja 2):
 *   ruchy: [{ id, date, amount, currency, kind: 'in' | 'out', cat: 'wydatek'|'wyplata'|'pati'|null, note, poza }]
 *     kind 'in'  = pieniądze od szefa (jedna pula)
 *     kind 'out' = na co poszły (kategoria), poza=true → nie z kasy szefa (nie odejmuje od salda)
 *   praca: [{ id, date, amount, note }]  – dni pracy Pati u Svena (zarobione €)
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'rozliczenia.v1';
  const VERSION = 2;
  const DEFAULT_RATE = 4.2; // ile zł za 1 € (1429 zł → 340,24 € w arkuszu)

  const CATS = {
    wydatek: { label: 'Wydatki', one: 'Wydatek', icon: '🧾' },
    wyplata: { label: 'Wypłata', one: 'Wypłata', icon: '💰' },
    pati:    { label: 'Pati',    one: 'Dla Pati', icon: '👩‍🔧' },
  };

  // ---------- Dane startowe (z arkusza) ----------
  const SEED = {
    version: VERSION,
    settings: { rate: DEFAULT_RATE },
    ruchy: [
      { id: 's1', kind: 'in',  date: '2026-09-23', amount: 650, currency: 'EUR', cat: null, note: '' },
      { id: 's2', kind: 'out', date: '2026-09-30', amount: 340, currency: 'EUR', cat: 'wydatek', note: 'Zakupy 1429 zł (598+264+290+68+66+97+46) ≈ 340 €' },
      { id: 's3', kind: 'out', date: '2026-09-30', amount: 270, currency: 'EUR', cat: 'wydatek', note: 'Pozostałe wydatki do 01.10' },
      { id: 's4', kind: 'out', date: '2026-10-12', amount: 285, currency: 'PLN', cat: 'wydatek', note: '' },
      { id: 's5', kind: 'in',  date: '2026-10-13', amount: 300, currency: 'PLN', cat: null, note: '' },
      { id: 's6', kind: 'in',  date: '2026-10-13', amount: 100, currency: 'EUR', cat: null, note: '' },
      { id: 's7', kind: 'out', date: '2026-10-13', amount: 100, currency: 'EUR', cat: 'pati', note: 'Wypłata dla Pati' },
      { id: 'p3', kind: 'out', date: '2026-09-01', amount: 100, currency: 'EUR', cat: 'pati', note: 'Wypłata dla Pati (przed 23.09 – sprawdź)', poza: true },
    ],
    praca: [
      { id: 'p1', date: '2026-08-12', amount: 100, note: '' },
      { id: 'p2', date: '2026-08-26', amount: 200, note: '' },
      { id: 'p4', date: '2026-09-09', amount: 100, note: '' },
      { id: 'p5', date: '2026-10-07', amount: 100, note: '' },
    ],
  };

  // ---------- Stan ----------
  let state = load();
  let tab = 'kasa';
  let monthFilter = { kasa: 'all', wyplata: 'all', pati: 'all' };
  let catFilter = 'all'; // kasa: all | in | wydatek | wyplata | pati

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const migrated = migrate(parsed);
        if (migrated) { save(migrated); return migrated; }
      }
    } catch (e) { /* ignorujemy, zaczynamy od seeda */ }
    const copy = JSON.parse(JSON.stringify(SEED));
    save(copy);
    return copy;
  }

  // Migracja ze starego modelu (szef / wyplata / pati) do nowego (ruchy / praca).
  function migrate(p) {
    if (!p || typeof p !== 'object') return null;
    const rate = p.settings && p.settings.rate > 0 ? p.settings.rate : DEFAULT_RATE;

    if (Array.isArray(p.ruchy) && Array.isArray(p.praca)) {
      p.version = VERSION;
      p.settings = { rate };
      return p;
    }
    if (!Array.isArray(p.szef) || !Array.isArray(p.pati)) return null;

    const ruchy = [];
    const praca = [];
    let hadS7 = false;

    for (const e of p.szef) {
      if (e.type === 'wplata') {
        ruchy.push({ id: e.id, kind: 'in', date: e.date, amount: +e.amount, currency: e.currency || 'EUR', cat: null, note: e.note === 'Od szefa' ? '' : (e.note || '') });
      } else if (e.id === 's7' && /DO SPRAWDZENIA/.test(e.note || '')) {
        // niewyjaśnione 100 € z 13.10 = wypłata dla Pati tego samego dnia
        hadS7 = true;
        ruchy.push({ id: 's7', kind: 'out', date: e.date, amount: +e.amount, currency: 'EUR', cat: 'pati', note: 'Wypłata dla Pati' });
      } else {
        ruchy.push({ id: e.id, kind: 'out', date: e.date, amount: +e.amount, currency: e.currency || 'EUR', cat: 'wydatek', note: e.note || '' });
      }
    }
    for (const e of (Array.isArray(p.wyplata) ? p.wyplata : [])) {
      ruchy.push({ id: e.id, kind: 'out', date: e.date, amount: +e.amount, currency: e.currency || 'EUR', cat: 'wyplata', note: e.note || '' });
    }
    const firstIn = ruchy.filter((r) => r.kind === 'in').map((r) => r.date).sort()[0];
    for (const e of p.pati) {
      if (e.type === 'praca') {
        praca.push({ id: e.id, date: e.date, amount: +e.amount, note: e.note || '' });
      } else {
        if (hadS7 && e.id === 'p6') continue; // już scalone z s7
        const poza = !!firstIn && e.date < firstIn; // wypłata zanim była jakakolwiek kasa od szefa
        ruchy.push({
          id: e.id, kind: 'out', date: e.date, amount: +e.amount, currency: 'EUR', cat: 'pati',
          note: e.note || (poza ? `Wypłata dla Pati (przed ${fmtDate(firstIn)} – sprawdź)` : 'Wypłata dla Pati'),
          poza,
        });
      }
    }
    return { version: VERSION, settings: { rate }, ruchy, praca };
  }

  function save(s = state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
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

  // ---------- Obliczenia ----------
  // Zwraca { in: {EUR,PLN}, out: {EUR,PLN}, cats: { wydatek:{EUR,PLN}, ... }, saldo: {EUR,PLN} }
  function kasa(list = state.ruchy) {
    const z = () => ({ EUR: 0, PLN: 0 });
    const r = { in: z(), out: z(), poza: z(), cats: { wydatek: z(), wyplata: z(), pati: z() }, saldo: z() };
    for (const e of list) {
      const c = e.currency === 'PLN' ? 'PLN' : 'EUR';
      if (e.kind === 'in') { r.in[c] += +e.amount; continue; }
      const cat = r.cats[e.cat] || (r.cats[e.cat] = z());
      cat[c] += +e.amount;
      if (e.poza) r.poza[c] += +e.amount; else r.out[c] += +e.amount;
    }
    r.saldo.EUR = r.in.EUR - r.out.EUR;
    r.saldo.PLN = r.in.PLN - r.out.PLN;
    return r;
  }
  const patiPayments = () => state.ruchy.filter((e) => e.kind === 'out' && e.cat === 'pati');
  function saldoPati() {
    const earned = state.praca.reduce((s, e) => s + +e.amount, 0);
    const paid = patiPayments().reduce((s, e) => s + (e.currency === 'PLN' ? plnToEur(+e.amount) : +e.amount), 0);
    return { earned, paid, due: earned - paid };
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
    const sign = plus ? '+' : '−';
    const cls = plus ? 'plus' : (e.poza ? 'neutral' : 'minus');
    return `<div class="amt ${cls}">${sign}${money(e.amount, e.currency)}${e.currency === 'PLN' ? `<small>≈ ${money(plnToEur(e.amount), 'EUR')}</small>` : ''}</div>`;
  }

  function ruchItemHTML(e) {
    const plus = e.kind === 'in';
    const cat = CATS[e.cat] || CATS.wydatek;
    const title = e.note || (plus ? 'Od szefa' : cat.one);
    const sub = plus ? 'dostałem od szefa' : `${cat.icon} ${cat.label}${e.poza ? ' · nie z kasy szefa' : ''}`;
    return `<button class="item" data-edit="ruch" data-id="${esc(e.id)}">
      <div class="date"><b>${e.date.slice(8, 10)}</b>${MONTHS[+e.date.slice(5, 7) - 1]}</div>
      <div class="note">${esc(title)}<small>${sub}</small></div>
      ${amtHTML(e)}
    </button>`;
  }

  function pair(v, cls = '') {
    const parts = [];
    if (v.EUR) parts.push(money(v.EUR, 'EUR'));
    if (v.PLN) parts.push(money(v.PLN, 'PLN'));
    if (!parts.length) return `<span class="muted">—</span>`;
    return `<span class="${cls}">${parts.join(' + ')}</span>`;
  }

  function renderKasa() {
    $title.textContent = 'Kasa od szefa';
    const all = state.ruchy;
    const k = kasa(all);
    const total = k.saldo.EUR + plnToEur(k.saldo.PLN);

    let list = applyMonth(all, 'kasa');
    if (catFilter === 'in') list = list.filter((e) => e.kind === 'in');
    else if (catFilter !== 'all') list = list.filter((e) => e.kind === 'out' && e.cat === catFilter);
    const filtered = sortDesc(list);

    let html = `
      <div class="cards">
        <div class="card">
          <div class="label">Zostało €</div>
          <div class="value ${k.saldo.EUR < 0 ? 'neg' : ''}">${money(k.saldo.EUR, 'EUR')}</div>
        </div>
        <div class="card">
          <div class="label">Zostało zł</div>
          <div class="value ${k.saldo.PLN < 0 ? 'neg' : ''}">${money(k.saldo.PLN, 'PLN')}</div>
        </div>
      </div>
      <div class="cards single">
        <button class="card card-btn" data-action="rate">
          <div class="label">Razem w € <span class="muted">(kurs ${rateText()} · dotknij, żeby zmienić)</span></div>
          <div class="value ${total < 0 ? 'neg' : ''}">${money(total, 'EUR')}</div>
        </button>
      </div>
      <div class="cards single">
        <div class="card breakdown">
          <div class="brow"><span>Dostałem od szefa</span>${pair(k.in, 'plus')}</div>
          <div class="brow"><span>${CATS.wydatek.icon} Wydatki</span>${pair(k.cats.wydatek, 'minus')}</div>
          <div class="brow"><span>${CATS.wyplata.icon} Wypłata</span>${pair(k.cats.wyplata, 'minus')}</div>
          <div class="brow"><span>${CATS.pati.icon} Pati</span>${pair(k.cats.pati, 'minus')}</div>
          ${(k.poza.EUR || k.poza.PLN) ? `<div class="brow muted"><span>w tym nie z kasy szefa</span>${pair(k.poza)}</div>` : ''}
          <div class="brow total"><span>Zostało</span>${pair(k.saldo, k.saldo.EUR < 0 || k.saldo.PLN < 0 ? 'minus' : '')}</div>
        </div>
      </div>
      <div class="chips">
        ${[['all', 'Wszystko'], ['in', 'Dostałem'], ['wydatek', 'Wydatki'], ['wyplata', 'Wypłata'], ['pati', 'Pati']]
          .map(([v, l]) => `<button class="chip ${catFilter === v ? 'active' : ''}" data-cat="${v}">${l}</button>`).join('')}
      </div>
      ${monthChipsHTML(all, 'kasa')}
    `;

    if (!filtered.length) {
      html += `<div class="empty">Brak wpisów.<br>Dotknij <b>+</b>, żeby dodać kasę od szefa albo wpisać, na co poszła.</div>`;
    } else {
      html += listByMonthHTML(filtered, ruchItemHTML);
    }
    $view.innerHTML = html;
  }

  function renderWyplata() {
    $title.textContent = 'Wypłata';
    const all = state.ruchy.filter((e) => e.kind === 'out' && e.cat === 'wyplata');
    const filtered = sortDesc(applyMonth(all, 'wyplata'));
    const k = kasa(filtered).cats.wyplata;
    const m = monthFilter.wyplata;
    const label = m === 'all' ? 'Razem' : monthLabelFull(m);

    let html = `
      <div class="cards">
        <div class="card">
          <div class="label">${label} €</div>
          <div class="value">${money(k.EUR, 'EUR')}</div>
        </div>
        <div class="card">
          <div class="label">${label} zł</div>
          <div class="value">${money(k.PLN, 'PLN')}</div>
        </div>
      </div>
      <div class="cards single">
        <div class="card">
          <div class="label">Razem w € <span class="muted">(kurs ${rateText()})</span></div>
          <div class="value">${money(k.EUR + plnToEur(k.PLN), 'EUR')}</div>
          <div class="sub">wypłat: ${filtered.length} · wypłaty schodzą z kasy od szefa</div>
        </div>
      </div>
      ${monthChipsHTML(all, 'wyplata')}
    `;
    if (!filtered.length) {
      html += `<div class="empty">Brak wypłat.<br>Dotknij <b>+</b>, żeby dodać wypłatę i wpisać, za co.</div>`;
    } else {
      html += listByMonthHTML(filtered, ruchItemHTML);
    }
    $view.innerHTML = html;
  }

  function renderPati() {
    $title.textContent = 'Pati u Svena';
    const s = saldoPati();
    const items = [
      ...state.praca.map((e) => ({ ...e, _t: 'praca' })),
      ...patiPayments().map((e) => ({ ...e, _t: 'ruch' })),
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
      html += `<div class="empty">Brak wpisów.<br>Dotknij <b>+</b>, żeby dodać dzień pracy albo wypłatę dla Pati.</div>`;
    } else {
      html += listByMonthHTML(filtered, (e) => {
        if (e._t === 'praca') {
          return `<button class="item" data-edit="praca" data-id="${esc(e.id)}">
            <div class="date"><b>${e.date.slice(8, 10)}</b>${MONTHS[+e.date.slice(5, 7) - 1]}</div>
            <div class="note">Praca u Svena${e.note ? `<small>${esc(e.note)}</small>` : '<small>zarobione</small>'}</div>
            <div class="amt plus">+${money(e.amount, 'EUR')}</div>
          </button>`;
        }
        return `<button class="item" data-edit="ruch" data-id="${esc(e.id)}">
          <div class="date"><b>${e.date.slice(8, 10)}</b>${MONTHS[+e.date.slice(5, 7) - 1]}</div>
          <div class="note">Pati dostała kasę<small>${e.poza ? 'nie z kasy szefa' : 'z kasy szefa'}${e.note && e.note !== 'Wypłata dla Pati' ? ' · ' + esc(e.note) : ''}</small></div>
          ${amtHTML(e)}
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
    $view.innerHTML = `
      <div class="section-title"><span>Ustawienia</span></div>
      <div class="list">
        <label class="item setting">
          <div class="note">Kurs euro<small>ile złotych za 1 €</small></div>
          <input type="number" id="rate-input" inputmode="decimal" step="0.01" min="0.01" value="${rate()}">
          <span class="muted">zł</span>
        </label>
      </div>
      <p class="hint">Po tym kursie przeliczane są złotówki na euro w karcie „Razem w €” i w podsumowaniu.</p>

      <div class="section-title"><span>Podsumowanie</span></div>
      <pre class="summary">${esc(summaryText())}</pre>
      <div class="menu">
        <button class="btn block" data-action="copy"><span>Kopiuj podsumowanie</span><span>📋</span></button>
        ${canShare ? `<button class="btn block" data-action="share"><span>Wyślij podsumowanie…</span><span>📤</span></button>` : ''}
      </div>

      <div class="section-title"><span>Kopia zapasowa</span></div>
      <p class="hint">Dane są zapisane tylko na tym telefonie. Co jakiś czas zrób eksport i zapisz plik np. w iCloud / Plikach.</p>
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
    const k = kasa();
    const p = saldoPati();
    const lines = [];
    lines.push(`ROZLICZENIE – stan na ${fmtDate(todayISO())}`);
    lines.push('');
    lines.push(`Dostałem od szefa:  ${pairText(k.in)}`);
    lines.push(`  Wydatki:          ${pairText(k.cats.wydatek)}`);
    lines.push(`  Wypłata:          ${pairText(k.cats.wyplata)}`);
    lines.push(`  Pati:             ${pairText(k.cats.pati)}`);
    if (k.poza.EUR || k.poza.PLN) lines.push(`  (w tym nie z kasy szefa: ${pairText(k.poza)})`);
    lines.push(`ZOSTAŁO:            ${money(k.saldo.EUR, 'EUR')}  |  ${money(k.saldo.PLN, 'PLN')}`);
    lines.push(`Razem ≈ ${money(k.saldo.EUR + plnToEur(k.saldo.PLN), 'EUR')}  (kurs ${rateText()})`);
    lines.push('');
    lines.push('Wpisy:');
    for (const e of sortDesc(state.ruchy).reverse()) {
      const sign = e.kind === 'in' ? '+' : '−';
      const tag = e.kind === 'in' ? 'od szefa' : (CATS[e.cat] ? CATS[e.cat].label : e.cat) + (e.poza ? ' (nie z kasy)' : '');
      lines.push(`${fmtDate(e.date)}  ${sign}${money(e.amount, e.currency)}  ${tag}${e.note ? '  ' + e.note : ''}`);
    }
    lines.push('');
    lines.push('PATI U SVENA');
    lines.push(`Zarobione: ${money(p.earned, 'EUR')}, dostała: ${money(p.paid, 'EUR')}, do zapłaty: ${money(p.due, 'EUR')}`);
    for (const e of sortDesc(state.praca).reverse()) {
      lines.push(`${fmtDate(e.date)}  praca  ${money(e.amount, 'EUR')}${e.note ? '  ' + e.note : ''}`);
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
  const dlgPatiWybor = document.getElementById('dlg-pati-wybor');

  const NOTE_PLACEHOLDER = {
    in: 'np. zaliczka, na materiały…',
    wydatek: 'np. paliwo, materiały…',
    wyplata: 'np. wypłata za wrzesień, premia…',
    pati: 'np. za sierpień…',
  };

  function syncRuchForm() {
    const out = formRuch.kind.value === 'out';
    formRuch.classList.toggle('is-in', !out);
    const key = out ? formRuch.cat.value : 'in';
    formRuch.note.placeholder = NOTE_PLACEHOLDER[key] || '';
    document.getElementById('note-label').textContent = out ? (key === 'wydatek' ? 'Na co dokładnie' : 'Za co / opis') : 'Opis (opcjonalnie)';
  }

  // preset: { kind, cat }
  function openRuch(entry, preset = {}) {
    formRuch.reset();
    formRuch.id.value = entry ? entry.id : '';
    formRuch.kind.value = entry ? entry.kind : (preset.kind || 'out');
    formRuch.cat.value = entry ? (entry.cat || 'wydatek') : (preset.cat || 'wydatek');
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

  formRuch.addEventListener('change', (ev) => {
    if (ev.target.name === 'kind' || ev.target.name === 'cat') syncRuchForm();
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
      cat: kind === 'out' ? formRuch.cat.value : null,
      note: formRuch.note.value.trim(),
    };
    if (kind === 'out' && formRuch.poza.checked) entry.poza = true;
    upsert(state.ruchy, entry);
    save(); dlgRuch.close(); render();
    toast('Zapisano');
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
    state.ruchy = state.ruchy.filter((e) => e.id !== formRuch.id.value);
    save(); dlgRuch.close(); render();
    toast('Usunięto');
  });
  document.getElementById('btn-praca-delete').addEventListener('click', () => {
    if (!confirm('Usunąć ten dzień pracy?')) return;
    state.praca = state.praca.filter((e) => e.id !== formPraca.id.value);
    save(); dlgPraca.close(); render();
    toast('Usunięto');
  });

  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => b.closest('dialog').close());
  });
  [dlgRuch, dlgPraca, dlgPatiWybor].forEach((d) => {
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
  });
  dlgPatiWybor.querySelectorAll('[data-pati-add]').forEach((b) => {
    b.addEventListener('click', () => {
      dlgPatiWybor.close();
      if (b.dataset.patiAdd === 'praca') openPraca(null);
      else openRuch(null, { kind: 'out', cat: 'pati' });
    });
  });

  function upsert(list, entry) {
    const i = list.findIndex((e) => e.id === entry.id);
    if (i >= 0) list[i] = entry; else list.push(entry);
  }

  // ---------- Zdarzenia ----------
  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => { tab = b.dataset.tab; render(); });
  });

  $fab.addEventListener('click', () => {
    if (tab === 'kasa') openRuch(null, { kind: catFilter === 'in' ? 'in' : 'out', cat: ['wydatek', 'wyplata', 'pati'].includes(catFilter) ? catFilter : 'wydatek' });
    else if (tab === 'wyplata') openRuch(null, { kind: 'out', cat: 'wyplata' });
    else if (tab === 'pati') dlgPatiWybor.showModal();
  });

  $view.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (chip) {
      if (chip.dataset.month) monthFilter[tab] = chip.dataset.month;
      if (chip.dataset.cat) catFilter = chip.dataset.cat;
      render();
      return;
    }

    const item = ev.target.closest('[data-edit]');
    if (item) {
      const which = item.dataset.edit;
      if (which === 'ruch') {
        const entry = state.ruchy.find((e) => e.id === item.dataset.id);
        if (entry) openRuch(entry);
      } else if (which === 'praca') {
        const entry = state.praca.find((e) => e.id === item.dataset.id);
        if (entry) openPraca(entry);
      }
      return;
    }

    const act = ev.target.closest('[data-action]');
    if (act) handleAction(act.dataset.action);
  });

  // zmiana kursu w ustawieniach
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
    } else if (action === 'reset') {
      if (!confirm('Na pewno usunąć WSZYSTKIE dane? Tej operacji nie da się cofnąć.')) return;
      if (!confirm('Ostatni raz: usunąć wszystko?')) return;
      state = { version: VERSION, settings: { rate: rate() }, ruchy: [], praca: [] };
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
      const parsed = JSON.parse(await file.text());
      const migrated = migrate(parsed);
      if (!migrated) throw new Error('zły format');
      if (!confirm(`Wczytać ${migrated.ruchy.length} wpisów kasy i ${migrated.praca.length} dni pracy Pati? Obecne dane zostaną zastąpione.`)) return;
      state = migrated;
      save(); render();
      toast('Dane wczytane');
    } catch (e) {
      toast('Nie udało się wczytać pliku');
    }
  });

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  render();
})();
