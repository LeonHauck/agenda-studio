'use strict';

/* ============================================================
   Página pública (o link enviado às clientes)
   - Sem parâmetro: agendamento em 3 passos
   - ?r=<código>: a cliente vê, remarca ou cancela o próprio horário
   ============================================================ */
const HORIZON = 30;       // quantos dias à frente a cliente pode escolher
const MAX_SERVICES = 5;
const REMEMBER_KEY = 'agenda-cliente';   // nome e WhatsApp, para não digitar de novo
const BOOKINGS_KEY = 'agenda-reservas';  // horários marcados neste aparelho

const st = {
  mode: 'book', info: null, busy: [],
  // agendamento
  selected: [], date: null, start: null, step: 1, done: null,
  // gerenciamento pelo link
  token: null, booking: null, view: 'view', confirmCancel: false,
};

const selectedServices = () => st.info.services.filter(s => st.selected.includes(s.id));
const totals = () => {
  const list = selectedServices();
  return { duration: sum(list, s => s.duration), price: sum(list, s => s.price) };
};
// Duração usada para calcular horários: serviços escolhidos ou, ao remarcar, a do próprio horário
const needDuration = () => (st.mode === 'manage' ? st.booking.duration : totals().duration);
// Dia de atendimento e sem bloqueio de dia inteiro (que chega como 00:00 com 1440 minutos)
const isWorkDay = k => st.info.settings.workDays.includes(parseKey(k).getDay()) &&
  !st.busy.some(b => b.date === k && b.duration >= 1440);
const slotsFor = k => (isWorkDay(k) ? computeSlots(st.info.settings, st.busy, k, needDuration()) : []);
const nextDays = () => Array.from({ length: HORIZON }, (_, i) => dateKey(addDays(new Date(), i)));
const manageUrl = token => `${location.origin}${location.pathname}?r=${token}`;

async function refreshBusy() {
  const days = nextDays();
  st.busy = await API.busySlots(days[0], days[days.length - 1], st.mode === 'manage' ? st.token : null);
}

/* ---------- Dados guardados no aparelho da cliente ---------- */
function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* opcional */ }
}
function rememberBooking(token, date, start) {
  const list = readStore(BOOKINGS_KEY, []).filter(b => b.token !== token && b.date >= todayKey());
  list.push({ token, date, start });
  writeStore(BOOKINGS_KEY, list);
}
function forgetBooking(token) {
  writeStore(BOOKINGS_KEY, readStore(BOOKINGS_KEY, []).filter(b => b.token !== token));
}
const upcomingBookings = () => readStore(BOOKINGS_KEY, [])
  .filter(b => b.date >= todayKey())
  .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

/* ============================================================
   Estrutura da página
   ============================================================ */
function render() {
  const s = st.info.settings;
  const body = st.mode === 'manage' ? manageBody() : bookBody();
  $('#public').innerHTML = `
    <header class="pub-head">
      <span class="brand-mark">${icon('sparkle')}</span>
      <div><h1>${esc(s.businessName)}</h1><p>${st.mode === 'manage' ? 'Seu agendamento' : 'Agendamento online'}</p></div>
    </header>
    ${body.top || ''}
    <main class="pub-main">${body.main}</main>
    ${creditHtml()}
    ${body.bar || ''}`;

  $('.day-pill.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  if (st.mode === 'book' && st.step === 3) mountDetails();
}

function bookBody() {
  return {
    top: st.step < 4 ? stepper() : '',
    main: [null, stepServices, () => stepTime({ back: 1, backLabel: 'Serviços', title: 'Escolha o dia e o horário' }), stepDetails, stepDone][st.step](),
    bar: bottomBar(),
  };
}

function stepper() {
  const steps = ['Serviços', 'Horário', 'Seus dados'];
  return `<ol class="stepper">${steps.map((label, i) => {
    const n = i + 1;
    const cls = n < st.step ? 'is-done' : n === st.step ? 'is-current' : '';
    return `<li class="${cls}"><span>${n < st.step ? icon('check') : n}</span>${label}</li>`;
  }).join('')}</ol>`;
}

function summaryCard({ date, start, duration, services, price }) {
  return `<div class="card pad pub-summary">
    <div class="sum-when">${icon('calendar')}<div><b>${esc(fmtDateLong(date))}</b><span>às ${start} · ${fmtDuration(duration)}</span></div></div>
    <ul>${services.map(s => `<li><span>${esc(s.name)}</span><span>${money(s.price)}</span></li>`).join('')}</ul>
    <div class="sum-total"><span>Total</span><strong>${money(price)}</strong></div>
  </div>`;
}

function calendarLink({ date, start, duration, services }) {
  const stamp = t => `${date.replace(/-/g, '')}T${fromMin(t).replace(':', '')}00`;
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    `&text=${encodeURIComponent(`${services.map(x => x.name).join(' + ')} · ${st.info.settings.businessName}`)}` +
    `&dates=${stamp(toMin(start))}/${stamp(toMin(start) + duration)}&ctz=America/Sao_Paulo`;
}

/* ============================================================
   Agendamento (3 passos)
   ============================================================ */
function stepServices() {
  const list = st.info.services;
  const mine = upcomingBookings();
  const banner = mine.length ? `<div class="my-bookings">
      <span class="label">Seus horários marcados</span>
      ${mine.slice(0, 3).map(b => `<a class="my-booking" href="?r=${esc(b.token)}">
        ${icon('calendar')}<span><b>${DOW_SHORT[parseKey(b.date).getDay()]}, ${fmtDateShort(b.date).slice(0, 5)} às ${esc(b.start)}</b><small>Ver, remarcar ou cancelar</small></span>${icon('chevRight')}
      </a>`).join('')}
    </div>` : '';

  if (!list.length) return `${banner}<div class="empty">${icon('sparkle')}<h3>Nenhum serviço disponível</h3><p>Entre em contato com o estúdio.</p></div>`;
  return `${banner}
    <h2 class="pub-title">Escolha os serviços</h2>
    <p class="pub-sub">Você pode escolher mais de um.</p>
    <div class="svc-list">${list.map(s => {
      const on = st.selected.includes(s.id);
      return `<button class="svc-pick ${on ? 'on' : ''}" data-action="toggle-svc" data-id="${s.id}" aria-pressed="${on}">
        <span class="svc-check">${icon('check')}</span>
        <span class="svc-info"><b>${esc(s.name)}</b><small>${icon('clock')} ${fmtDuration(s.duration)}</small></span>
        <strong>${money(s.price)}</strong>
      </button>`;
    }).join('')}</div>`;
}

function stepTime({ back, backLabel, title }) {
  const pills = nextDays().map(k => {
    const d = parseKey(k);
    const free = slotsFor(k).length;
    const note = !isWorkDay(k) ? 'Fechado' : free ? `${free} livre${free === 1 ? '' : 's'}` : 'Lotado';
    return `<button class="day-pill ${k === st.date ? 'on' : ''}" data-action="pick-day" data-date="${k}" ${free ? '' : 'disabled'}>
      <span>${DOW_SHORT[d.getDay()]}</span><b>${d.getDate()}</b><small>${MONTHS[d.getMonth()].slice(0, 3)}</small><em>${note}</em>
    </button>`;
  }).join('');

  let slotsHtml = '<p class="pub-sub">Não há horários livres nos próximos dias. Fale com o estúdio.</p>';
  if (st.date) {
    const groups = { Manhã: [], Tarde: [], Noite: [] };
    slotsFor(st.date).forEach(t => groups[t < 720 ? 'Manhã' : t < 1080 ? 'Tarde' : 'Noite'].push(fromMin(t)));
    slotsHtml = `<h3 class="slot-day">${esc(fmtDateLong(st.date))}</h3>` +
      Object.entries(groups).filter(([, list]) => list.length).map(([label, list]) => `
        <div class="slot-group">
          <span class="label">${label}</span>
          <div class="slot-grid">${list.map(t => `<button class="slot ${t === st.start ? 'on' : ''}" data-action="pick-slot" data-start="${t}">${t}</button>`).join('')}</div>
        </div>`).join('');
  }

  return `
    <button class="back-link" data-action="${st.mode === 'manage' ? 'manage-view' : 'go-step'}" data-step="${back}">${icon('chevLeft')} ${backLabel}</button>
    <h2 class="pub-title">${title}</h2>
    <p class="pub-sub">Duração total: ${fmtDuration(needDuration())}</p>
    <div class="day-scroll">${pills}</div>
    <div class="slot-area">${slotsHtml}</div>`;
}

function stepDetails() {
  const { duration, price } = totals();
  return `
    <button class="back-link" data-action="go-step" data-step="2">${icon('chevLeft')} Horário</button>
    <h2 class="pub-title">Confirme seus dados</h2>
    ${summaryCard({ date: st.date, start: st.start, duration, price, services: selectedServices() })}
    <form id="book-form" class="form" autocomplete="on" novalidate>
      <div class="field"><label for="b-name">Seu nome</label><input id="b-name" name="name" autocomplete="name" maxlength="80" placeholder="Nome e sobrenome"></div>
      <div class="field"><label for="b-phone">WhatsApp</label><input id="b-phone" name="tel" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="(00) 00000-0000"></div>
      <div class="field"><label for="b-notes">Observação <span class="muted">(opcional)</span></label><textarea id="b-notes" rows="2" maxlength="300" placeholder="Ex.: cor desejada, alguma preferência…"></textarea></div>
    </form>`;
}

function mountDetails() {
  const saved = readStore(REMEMBER_KEY, {});
  $('#b-name').value = saved.name || '';
  $('#b-phone').value = saved.phone || '';
  bindPhoneMask($('#b-phone'));
  $('#book-form').addEventListener('submit', submitBooking);
}

function stepDone() {
  const d = st.done;
  const s = st.info.settings;
  const waMsg = `Olá! Acabei de agendar pelo link: ${d.services.map(x => x.name).join(' + ')}, ${fmtDateLong(d.date)} às ${d.start}. Nome: ${d.name}.`;
  const canManage = s.changeNoticeHours >= 0 && d.token;

  return `<div class="done">
    <span class="done-icon">${icon('check')}</span>
    <h2>Horário confirmado!</h2>
    <p class="pub-sub">Te esperamos ${esc(fmtDateLong(d.date))}, às ${d.start}.</p>
    ${summaryCard(d)}
    ${canManage ? `<div class="manage-box">
      <b>${icon('link')} Guarde seu link pessoal</b>
      <p>Por ele você pode remarcar ou cancelar${s.changeNoticeHours > 0 ? ` até ${s.changeNoticeHours}h antes` : ''}. Ele também fica salvo neste aparelho.</p>
      <button class="btn btn-ghost btn-block" data-action="copy-manage" data-token="${esc(d.token)}">${icon('copy')} Copiar meu link</button>
    </div>` : ''}
    <div class="done-actions">
      <a class="btn btn-ghost btn-block" href="${calendarLink(d)}" target="_blank" rel="noopener">${icon('calendar')} Salvar na minha agenda</a>
      ${s.whatsapp ? `<a class="btn btn-ghost btn-wa btn-block" href="${waLink(s.whatsapp, waMsg)}" target="_blank" rel="noopener">${icon('chat')} Falar com o estúdio</a>` : ''}
      <button class="btn btn-primary btn-block" data-action="restart">Fazer outro agendamento</button>
    </div>
  </div>`;
}

function bottomBar() {
  if (st.step === 4) return '';
  const { duration, price } = totals();
  const count = st.selected.length;
  let info, button;
  if (st.step === 1) {
    info = count ? `<b>${money(price)}</b><span>${count} serviço${count === 1 ? '' : 's'} · ${fmtDuration(duration)}</span>` : '<span>Nenhum serviço escolhido</span>';
    button = `<button class="btn btn-primary" data-action="go-step" data-step="2" ${count ? '' : 'disabled'}>Continuar</button>`;
  } else if (st.step === 2) {
    info = st.start ? `<b>${DOW_SHORT[parseKey(st.date).getDay()]}, ${fmtDateShort(st.date).slice(0, 5)} às ${st.start}</b><span>${fmtDuration(duration)} · ${money(price)}</span>` : '<span>Escolha um horário</span>';
    button = `<button class="btn btn-primary" data-action="go-step" data-step="3" ${st.start ? '' : 'disabled'}>Continuar</button>`;
  } else {
    info = `<b>${money(price)}</b><span>Pagamento no estúdio</span>`;
    button = '<button class="btn btn-primary" type="submit" form="book-form" id="confirm-btn">Confirmar agendamento</button>';
  }
  return barHtml(info, button);
}

function barHtml(info, button) {
  return `<div class="bottom-bar"><div class="bottom-inner"><div class="bb-info">${info}</div>${button}</div></div>`;
}

async function goStep(step) {
  if (step === 2) {
    try { await refreshBusy(); } catch (err) { return toast(err.message); }
    pickFirstFreeDay();
  }
  st.step = step;
  render();
  window.scrollTo(0, 0);
}

function pickFirstFreeDay() {
  const valid = nextDays().filter(k => slotsFor(k).length);
  if (!valid.includes(st.date)) st.date = valid[0] || null;
  if (st.start && !slotsFor(st.date).map(fromMin).includes(st.start)) st.start = null;
}

async function submitBooking(e) {
  e.preventDefault();
  const name = $('#b-name').value.trim();
  const phone = $('#b-phone').value.trim();
  const notes = $('#b-notes').value.trim();
  if (name.length < 2) return toast('Informe seu nome.');
  if (![10, 11].includes(digits(phone).length)) return toast('Informe seu WhatsApp com DDD.');

  const services = selectedServices();
  const { price } = totals();
  let result;
  const ok = await withBusy($('#confirm-btn'), async () => {
    result = await API.book({ name, phone, serviceIds: st.selected, date: st.date, start: st.start, notes });
  });

  if (!ok) {
    // O horário pode ter sido ocupado por outra pessoa: atualiza e volta à escolha
    try {
      await refreshBusy();
      if (!slotsFor(st.date).map(fromMin).includes(st.start)) {
        st.start = null;
        st.step = 2;
        render();
      }
    } catch { /* mantém a tela */ }
    return;
  }

  writeStore(REMEMBER_KEY, { name, phone });
  if (result.token) rememberBooking(result.token, result.date, result.start);
  st.done = { date: result.date, start: result.start, duration: result.duration, price, services, name, token: result.token };
  st.step = 4;
  render();
  window.scrollTo(0, 0);
}

/* ============================================================
   Gerenciar horário pelo link pessoal (?r=código)
   ============================================================ */
function manageBody() {
  const b = st.booking;
  const s = st.info.settings;

  if (st.view === 'reschedule') {
    return {
      main: stepTime({ back: 'view', backLabel: 'Meu horário', title: 'Escolha o novo horário' }),
      bar: barHtml(
        st.start ? `<b>${DOW_SHORT[parseKey(st.date).getDay()]}, ${fmtDateShort(st.date).slice(0, 5)} às ${st.start}</b><span>Novo horário</span>` : '<span>Escolha o novo horário</span>',
        `<button class="btn btn-primary" data-action="confirm-reschedule" id="resched-btn" ${st.start ? '' : 'disabled'}>Confirmar</button>`),
    };
  }

  if (st.view === 'rescheduled' || st.view === 'cancelled') {
    const cancelled = st.view === 'cancelled';
    return {
      main: `<div class="done">
        <span class="done-icon ${cancelled ? 'is-cancel' : ''}">${icon(cancelled ? 'x' : 'check')}</span>
        <h2>${cancelled ? 'Horário cancelado' : 'Horário remarcado!'}</h2>
        <p class="pub-sub">${cancelled ? 'Tudo certo. Esperamos você numa próxima vez.' : `Te esperamos ${esc(fmtDateLong(b.date))}, às ${b.start}.`}</p>
        ${cancelled ? '' : summaryCard(b)}
        <div class="done-actions">
          ${cancelled ? '' : `<a class="btn btn-ghost btn-block" href="${calendarLink(b)}" target="_blank" rel="noopener">${icon('calendar')} Salvar na minha agenda</a>`}
          <a class="btn btn-primary btn-block" href="${location.pathname}">${cancelled ? 'Agendar outro horário' : 'Voltar ao início'}</a>
        </div>
      </div>`,
    };
  }

  // Visualização do horário
  const status = STATUS[b.status]?.label || '';
  const past = b.date < todayKey() || b.status === 'concluido';
  let actions;
  if (b.status === 'cancelado') {
    actions = `<p class="pub-sub">Este horário foi cancelado.</p>
      <a class="btn btn-primary btn-block" href="${location.pathname}">Agendar novo horário</a>`;
  } else if (past) {
    actions = `<p class="pub-sub">Este atendimento já aconteceu. Obrigada pela visita!</p>
      <a class="btn btn-primary btn-block" href="${location.pathname}">Agendar novo horário</a>`;
  } else if (b.canChange && st.confirmCancel) {
    actions = `<div class="confirm-box">
      <b>Cancelar este horário?</b>
      <p>O horário será liberado para outras clientes.</p>
      <div class="confirm-actions">
        <button class="btn btn-ghost" data-action="cancel-no">Voltar</button>
        <button class="btn btn-danger" data-action="cancel-yes" id="cancel-btn">Sim, cancelar</button>
      </div>
    </div>`;
  } else if (b.canChange) {
    actions = `<div class="done-actions">
      <button class="btn btn-primary btn-block" data-action="start-reschedule">${icon('calendar')} Remarcar</button>
      <button class="btn btn-danger-ghost btn-block" data-action="ask-cancel">${icon('x')} Cancelar horário</button>
    </div>
    ${b.noticeHours > 0 ? `<p class="muted small center">Alterações pelo link até ${b.noticeHours}h antes do horário.</p>` : ''}`;
  } else {
    const msg = `Olá! Preciso falar sobre meu horário de ${fmtDateLong(b.date)} às ${b.start}. Nome: ${b.name}.`;
    actions = `<div class="notice">${icon('alert')}<p>${b.noticeHours < 0
      ? 'Para remarcar ou cancelar, fale com o estúdio pelo WhatsApp.'
      : `O prazo para alterar pelo link (${b.noticeHours}h antes) já passou. Fale com o estúdio pelo WhatsApp.`}</p></div>
      ${s.whatsapp ? `<a class="btn btn-ghost btn-wa btn-block" style="margin-top:10px" href="${waLink(s.whatsapp, msg)}" target="_blank" rel="noopener">${icon('chat')} Falar com o estúdio</a>` : ''}`;
  }

  return {
    main: `
      <h2 class="pub-title">Olá, ${esc(firstName(b.name))}!</h2>
      <p class="pub-sub">Este é o seu horário${status ? ` · <span class="badge st-${b.status}">${status}</span>` : ''}</p>
      ${summaryCard(b)}
      ${actions}`,
  };
}

async function openManage(token) {
  st.mode = 'manage';
  st.token = token;
  const data = await API.getBooking(token);
  st.booking = { ...data, services: data.services || [], price: Number(data.price) };
  if (['agendado', 'confirmado'].includes(data.status) && data.date >= todayKey()) {
    rememberBooking(token, data.date, data.start);
  } else {
    forgetBooking(token);
  }
}

/* ============================================================
   Ações
   ============================================================ */
const ACTIONS = {
  'toggle-svc': el => {
    const id = el.dataset.id;
    if (st.selected.includes(id)) st.selected = st.selected.filter(x => x !== id);
    else if (st.selected.length >= MAX_SERVICES) return toast(`Escolha até ${MAX_SERVICES} serviços.`);
    else st.selected.push(id);
    st.start = null;
    render();
  },
  'go-step': el => goStep(Number(el.dataset.step)),
  'pick-day': el => { st.date = el.dataset.date; st.start = null; render(); },
  'pick-slot': el => { st.start = el.dataset.start; render(); },
  'restart': () => { st.selected = []; st.date = null; st.start = null; st.done = null; goStep(1); },
  'copy-manage': async el => {
    const url = manageUrl(el.dataset.token);
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copiado');
    } catch {
      window.prompt('Copie seu link:', url);
    }
  },

  // Gerenciamento
  'manage-view': () => { st.view = 'view'; st.start = null; render(); window.scrollTo(0, 0); },
  'start-reschedule': async () => {
    try { await refreshBusy(); } catch (err) { return toast(err.message); }
    st.date = st.booking.date;
    st.start = null;
    pickFirstFreeDay();
    st.view = 'reschedule';
    render();
    window.scrollTo(0, 0);
  },
  'confirm-reschedule': async () => {
    let result;
    const ok = await withBusy($('#resched-btn'), async () => {
      result = await API.rescheduleBooking(st.token, st.date, st.start);
    });
    if (!ok) {
      try { await refreshBusy(); pickFirstFreeDay(); render(); } catch { /* mantém a tela */ }
      return;
    }
    st.booking = { ...st.booking, date: result.date, start: result.start, status: 'confirmado' };
    rememberBooking(st.token, result.date, result.start);
    st.view = 'rescheduled';
    render();
    window.scrollTo(0, 0);
  },
  'ask-cancel': () => { st.confirmCancel = true; render(); },
  'cancel-no': () => { st.confirmCancel = false; render(); },
  'cancel-yes': async () => {
    const ok = await withBusy($('#cancel-btn'), () => API.cancelBooking(st.token));
    if (!ok) return;
    forgetBooking(st.token);
    st.booking.status = 'cancelado';
    st.view = 'cancelled';
    render();
    window.scrollTo(0, 0);
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  fn(el);
});

/* ---------- Início ---------- */
(async function boot() {
  const root = $('#public');
  if (!API.configured) {
    root.innerHTML = `<div class="empty">${icon('alert')}<h3>Agenda ainda não configurada</h3><p>Preencha o arquivo js/config.js com os dados do Supabase.</p></div>`;
    return;
  }
  root.innerHTML = `<div class="pub-loading">${icon('calendar')}<p>Carregando…</p></div>`;
  try {
    st.info = await API.publicInfo();
    applyAccent(st.info.settings.accent);
    document.title = `Agendar · ${st.info.settings.businessName}`;
    const token = new URLSearchParams(location.search).get('r');
    if (token) {
      document.title = `Meu horário · ${st.info.settings.businessName}`;
      await openManage(token);
    }
    render();
  } catch (err) {
    root.innerHTML = `<div class="empty">${icon('alert')}<h3>Não foi possível carregar</h3><p>${esc(err.message)}</p>
      <a class="btn btn-primary" href="${location.pathname}">Ir para o agendamento</a></div>`;
  }
})();
