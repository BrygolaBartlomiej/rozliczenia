/* Rozliczenia – prosta PWA, dane trzymane w localStorage telefonu. */
(() => {
  'use strict';

  const STORAGE_KEY = 'rozliczenia.v1';

  // ---------- Dane startowe (z arkusza) ----------
  const SEED = {
    version: 1,
    szef: [
      { id: 's1', type: 'wplata',  date: '2026-09-23', amount: 650, currency: 'EUR', note: 'Od szefa' },
      { id: 's2', type: 'wydatek', date: '2026-09-30', amount: 340, currency: 'EUR', note: 'Zakupy 1429 zł (598+264+290+68+66+97+46) ≈ 340 €' },
      { id: 's3', type: 'wydatek', date: '2026-09-30', amount: 270, currency: 'EUR', note: 'Pozostałe wydatki do 01.10' },
      { id: 's4', type: 'wydatek', date: '2026-10-12', amount: 285, currency: 'PLN', note: '' },
      { id: 's5', type: 'wplata',  date: '2026-10-13', amount: 300, currency: 'PLN', note: 'Od szefa' },
      { id: 's6', type: 'wplata',  date: '2026-10-13', amount: 100, currency: 'EUR', note: 'Od szefa' },
      { id: 's7', type: 'wydatek', date: '2026-10-13', amount: 100, currency: 'EUR', note: 'DO SPRAWDZENIA – wg arkusza zostało 40 €' },
    ],
    pati: [
      { id: 'p1', type: 'praca',   date: '2026-08-12', amount: 100, note: '' },
      { id: 'p2', type: 'praca',   date: '2026-08-26', amount: 200, note: '' },
      { id: 'p3', type: 'wyplata', date: '2026-09-01', amount: 100, note: '' },
      { id: 'p4', type: 'praca',   date: '2026-09-09', amount: 100, note: '' },
      { id: 'p5', type: 'praca',   date: '2026-10-07', amount: 100, note: '' },
      { id: 'p6', type: 'wyplata', date: '2026-10-13', amount: 100, note: '' },
    ],
  };

  // ---------- Stan ----------
  let state = load();
  let tab = 'szef';
  let monthFilter = { szef: 'all', pati: 'all' };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.szef) && Array.isArray(parsed.pati)) return parsed;
      }
    } catch (e) { /* ignorujemy, zaczynamy od seeda */ }
    const copy = JSON.parse(JSON.stringify(SEED));
    save(copy);
    return copy;
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
  const signed = (v, cur) => (v >= 0 ? '+' : '−') + money(Math.abs(v), cur);
  const MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
  const MONTHS_FULL = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];

  function fmtDate(iso) {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }
  function todayISO() {
    const d = new Date();
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  }
  function monthKey(iso) { return iso.slice(0, 7); }
  function monthLabel(key) {
    const [y, m] = key.split('-');
    return `${MONTHS[+m - 1]} ${y}`;
  }
  function monthLabelFull(key) {
    const [y, m] = key.split('-');
    return `${MONTHS_FULL[+m - 1]} ${y}`;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function sortDesc(list) {
    return [...list].sort((a, b) => (b.date.localeCompare(a.date)) || String(b.id).localeCompare(String(a.id)));
  }

  // ---------- Obliczenia ----------
  function saldoSzef(list) {
    const r = { EUR: { in: 0, out: 0 }, PLN: { in: 0, out: 0 } };
    for (const e of list) {
      const c = r[e.currency] || (r[e.currency] = { in: 0, out: 0 });
      if (e.type === 'wplata') c.in += +e.amount; else c.out += +e.amount;
    }
    return r;
  }
  function saldoPati(list) {
    let earned = 0, paid = 0;
    for (const e of list) {
      if (e.type === 'praca') earned += +e.amount; else paid += +e.amount;
    }
    return { earned, paid, due: earned - paid };
  }

  // ---------- Renderowanie ----------
  const $view = document.getElementById('view');
  const $title = document.getElementById('title');
  const $fab = document.getElementById('fab');

  function render() {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $fab.hidden = tab === 'wiecej';
    if (tab === 'szef') renderSzef();
    else if (tab === 'pati') renderPati();
    else renderWiecej();
    $view.scrollTop = 0;
  }

  function chipsHTML(list, which) {
    const months = [...new Set(list.map((e) => monthKey(e.date)))].sort().reverse();
    if (months.length < 2) return '';
    const cur = monthFilter[which];
    return `<div class="chips">
      <button class="chip ${cur === 'all' ? 'active' : ''}" data-month="all">Wszystko</button>
      ${months.map((m) => `<button class="chip ${cur === m ? 'active' : ''}" data-month="${m}">${monthLabel(m)}</button>`).join('')}
    </div>`;
  }

  function applyFilter(list, which) {
    const m = monthFilter[which];
    return m === 'all' ? list : list.filter((e) => monthKey(e.date) === m);
  }

  function renderSzef() {
    $title.textContent = 'Rozliczenia z szefem';
    const all = state.szef;
    const s = saldoSzef(all);
    const eur = s.EUR.in - s.EUR.out;
    const pln = s.PLN.in - s.PLN.out;
    const filtered = sortDesc(applyFilter(all, 'szef'));

    let html = `
      <div class="cards">
        <div class="card">
          <div class="label">Zostało €</div>
          <div class="value ${eur < 0 ? 'neg' : ''}">${money(eur, 'EUR')}</div>
          <div class="sub">dostałem ${money(s.EUR.in, 'EUR')}<br>wydałem ${money(s.EUR.out, 'EUR')}</div>
        </div>
        <div class="card">
          <div class="label">Zostało zł</div>
          <div class="value ${pln < 0 ? 'neg' : ''}">${money(pln, 'PLN')}</div>
          <div class="sub">dostałem ${money(s.PLN.in, 'PLN')}<br>wydałem ${money(s.PLN.out, 'PLN')}</div>
        </div>
      </div>
      ${chipsHTML(all, 'szef')}
    `;

    if (!filtered.length) {
      html += `<div class="empty">Brak wpisów.<br>Dotknij <b>+</b>, żeby dodać wydatek albo wpłatę.</div>`;
    } else {
      html += listByMonthHTML(filtered, (e) => {
        const plus = e.type === 'wplata';
        return `<button class="item" data-edit="szef" data-id="${esc(e.id)}">
          <div class="date"><b>${e.date.slice(8, 10)}</b>${MONTHS[+e.date.slice(5, 7) - 1]}</div>
          <div class="note">${esc(e.note) || (plus ? 'Dostałem' : 'Wydatek')}<small>${plus ? 'dostałem' : 'wydałem'}</small></div>
          <div class="amt ${plus ? 'plus' : 'minus'}">${signed(plus ? e.amount : -e.amount, e.currency)}</div>
        </button>`;
      });
    }
    $view.innerHTML = html;
  }

  function renderPati() {
    $title.textContent = 'Pati u Svena';
    const all = state.pati;
    const s = saldoPati(all);
    const filtered = sortDesc(applyFilter(all, 'pati'));

    let html = `
      <div class="cards single">
        <div class="card">
          <div class="label">Sven jeszcze wisi</div>
          <div class="value ${s.due > 0 ? 'pos' : ''}">${money(s.due, 'EUR')}</div>
          <div class="sub">zarobione ${money(s.earned, 'EUR')} · zapłacone ${money(s.paid, 'EUR')} · dni pracy: ${all.filter((e) => e.type === 'praca').length}</div>
        </div>
      </div>
      ${chipsHTML(all, 'pati')}
    `;

    if (!filtered.length) {
      html += `<div class="empty">Brak wpisów.<br>Dotknij <b>+</b>, żeby dodać dzień pracy albo wypłatę.</div>`;
    } else {
      html += listByMonthHTML(filtered, (e) => {
        const praca = e.type === 'praca';
        return `<button class="item" data-edit="pati" data-id="${esc(e.id)}">
          <div class="date"><b>${e.date.slice(8, 10)}</b>${MONTHS[+e.date.slice(5, 7) - 1]}</div>
          <div class="note">${praca ? 'Praca u Svena' : 'Sven zapłacił'}${e.note ? `<small>${esc(e.note)}</small>` : ''}</div>
          <div class="amt ${praca ? 'plus' : 'minus'}">${praca ? '+' : '−'}${money(e.amount, 'EUR')}</div>
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
  function summaryText() {
    const s = saldoSzef(state.szef);
    const p = saldoPati(state.pati);
    const lines = [];
    lines.push(`ROZLICZENIE – stan na ${fmtDate(todayISO())}`);
    lines.push('');
    lines.push(`Dostałem:  ${money(s.EUR.in, 'EUR')}  |  ${money(s.PLN.in, 'PLN')}`);
    lines.push(`Wydałem:   ${money(s.EUR.out, 'EUR')}  |  ${money(s.PLN.out, 'PLN')}`);
    lines.push(`ZOSTAŁO:   ${money(s.EUR.in - s.EUR.out, 'EUR')}  |  ${money(s.PLN.in - s.PLN.out, 'PLN')}`);
    lines.push('');
    lines.push('Wpisy:');
    for (const e of sortDesc(state.szef).reverse()) {
      const sign = e.type === 'wplata' ? '+' : '−';
      lines.push(`${fmtDate(e.date)}  ${sign}${money(e.amount, e.currency)}${e.note ? '  ' + e.note : ''}`);
    }
    lines.push('');
    lines.push('PATI U SVENA');
    lines.push(`Zarobione: ${money(p.earned, 'EUR')}, zapłacone: ${money(p.paid, 'EUR')}, do zapłaty: ${money(p.due, 'EUR')}`);
    for (const e of sortDesc(state.pati).reverse()) {
      lines.push(`${fmtDate(e.date)}  ${e.type === 'praca' ? 'praca' : 'zapłacone'}  ${money(e.amount, 'EUR')}${e.note ? '  ' + e.note : ''}`);
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
  const dlgSzef = document.getElementById('dlg-szef');
  const formSzef = document.getElementById('form-szef');
  const dlgPati = document.getElementById('dlg-pati');
  const formPati = document.getElementById('form-pati');

  function openSzef(entry) {
    formSzef.reset();
    formSzef.id.value = entry ? entry.id : '';
    formSzef.type.value = entry ? entry.type : 'wydatek';
    formSzef.date.value = entry ? entry.date : todayISO();
    formSzef.amount.value = entry ? entry.amount : '';
    formSzef.currency.value = entry ? entry.currency : 'EUR';
    formSzef.note.value = entry ? entry.note : '';
    document.getElementById('dlg-szef-title').textContent = entry ? 'Edytuj wpis' : 'Nowy wpis';
    document.getElementById('btn-szef-delete').hidden = !entry;
    dlgSzef.showModal();
    if (!entry) setTimeout(() => formSzef.amount.focus(), 50);
  }

  function openPati(entry) {
    formPati.reset();
    formPati.id.value = entry ? entry.id : '';
    formPati.type.value = entry ? entry.type : 'praca';
    formPati.date.value = entry ? entry.date : todayISO();
    formPati.amount.value = entry ? entry.amount : 100;
    formPati.note.value = entry ? entry.note : '';
    document.getElementById('dlg-pati-title').textContent = entry ? 'Edytuj wpis' : 'Nowy wpis';
    document.getElementById('btn-pati-delete').hidden = !entry;
    dlgPati.showModal();
  }

  formSzef.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const amount = parseFloat(String(formSzef.amount.value).replace(',', '.'));
    if (!(amount >= 0)) return;
    const entry = {
      id: formSzef.id.value || uid(),
      type: formSzef.type.value,
      date: formSzef.date.value,
      amount: Math.round(amount * 100) / 100,
      currency: formSzef.currency.value,
      note: formSzef.note.value.trim(),
    };
    upsert(state.szef, entry);
    save(); dlgSzef.close(); render();
    toast('Zapisano');
  });

  formPati.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const amount = parseFloat(String(formPati.amount.value).replace(',', '.'));
    if (!(amount >= 0)) return;
    const entry = {
      id: formPati.id.value || uid(),
      type: formPati.type.value,
      date: formPati.date.value,
      amount: Math.round(amount * 100) / 100,
      note: formPati.note.value.trim(),
    };
    upsert(state.pati, entry);
    save(); dlgPati.close(); render();
    toast('Zapisano');
  });

  document.getElementById('btn-szef-delete').addEventListener('click', () => {
    if (!confirm('Usunąć ten wpis?')) return;
    state.szef = state.szef.filter((e) => e.id !== formSzef.id.value);
    save(); dlgSzef.close(); render();
    toast('Usunięto');
  });
  document.getElementById('btn-pati-delete').addEventListener('click', () => {
    if (!confirm('Usunąć ten wpis?')) return;
    state.pati = state.pati.filter((e) => e.id !== formPati.id.value);
    save(); dlgPati.close(); render();
    toast('Usunięto');
  });

  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => b.closest('dialog').close());
  });
  // zamykanie po kliknięciu w tło
  [dlgSzef, dlgPati].forEach((d) => {
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
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
    if (tab === 'szef') openSzef(null);
    else if (tab === 'pati') openPati(null);
  });

  $view.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (chip) { monthFilter[tab] = chip.dataset.month; render(); return; }

    const item = ev.target.closest('[data-edit]');
    if (item) {
      const which = item.dataset.edit;
      const entry = state[which].find((e) => e.id === item.dataset.id);
      if (!entry) return;
      if (which === 'szef') openSzef(entry); else openPati(entry);
      return;
    }

    const act = ev.target.closest('[data-action]');
    if (act) handleAction(act.dataset.action);
  });

  async function handleAction(action) {
    if (action === 'copy') {
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
      state = { version: 1, szef: [], pati: [] };
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
      if (!parsed || !Array.isArray(parsed.szef) || !Array.isArray(parsed.pati)) throw new Error('zły format');
      if (!confirm(`Wczytać ${parsed.szef.length} wpisów rozliczeń i ${parsed.pati.length} wpisów Pati? Obecne dane zostaną zastąpione.`)) return;
      state = { version: 1, szef: parsed.szef, pati: parsed.pati };
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
