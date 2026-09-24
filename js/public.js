'use strict';

/* ============================================================
   Página pública de agendamento (o link enviado às clientes)
   ============================================================ */
const HORIZON = 30;       // quantos dias à frente a cliente pode escolher
const MAX_SERVICES = 5;
const REMEMBER_KEY = 'agenda-cliente';

const st = { info: null, busy: [], selected: [], date: null, start: null, step: 1, done: null };

const selectedServices = () => st.info.services.filter(s => st.selected.includes(s.id));
const totals = () => {
  const list = selectedServices();
  return { duration: sum(list, s => s.duration), price: sum(list, s => s.price) };
};
// Dia de atendimento e sem bloqueio de dia inteiro (que chega como 00:00 com 1440 minutos)
const isWorkDay = k => st.info.settings.workDays.includes(parseKey(k).getDay()) &&
  !st.busy.some(b => b.date === k && b.duration >= 1440);
const slotsFor = k => (isWorkDay(k) ? computeSlots(st.info.settings, st.busy, k, totals().duration) : []);
const nextDays = () => Array.from({ length: HORIZON }, (_, i) => dateKey(addDays(new Date(), i)));

async function refreshBusy() {
  const days = nextDays();
  st.busy = await API.busySlots(days[0], days[days.length - 1]);
}

function remembered() {
  try { return JSON.parse(localStorage.getItem(REMEMBER_KEY)) || {}; } catch { return {}; }
}

/* ---------- Telas ---------- */
function render() {
  const s = st.info.settings;
  $('#public').innerHTML = `
    <header class="pub-head">
      <span class="brand-mark">${icon('sparkle')}</span>
      <div><h1>${esc(s.businessName)}</h1><p>Agendamento online</p></div>
    </header>
    ${st.step < 4 ? stepper() : ''}
    <main class="pub-main">${[null, stepServices, stepTime, stepDetails, stepDone][st.step]()}</main>
    ${creditHtml()}
    ${bottomBar()}`;

  if (st.step === 2) $('.day-pill.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  if (st.step === 3) mountDetails();
}

function stepper() {
  const steps = ['Serviços', 'Horário', 'Seus dados'];
  return `<ol class="stepper">${steps.map((label, i) => {
    const n = i + 1;
    const cls = n < st.step ? 'is-done' : n === st.step ? 'is-current' : '';
    return `<li class="${cls}"><span>${n < st.step ? icon('check') : n}</span>${label}</li>`;
  }).join('')}</ol>`;
}

function stepServices() {
  const list = st.info.services;
  if (!list.length) return `<div class="empty">${icon('sparkle')}<h3>Nenhum serviço disponível</h3><p>Entre em contato com o estúdio.</p></div>`;
  return `
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

function stepTime() {
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
    <button class="back-link" data-action="go-step" data-step="1">${icon('chevLeft')} Serviços</button>
    <h2 class="pub-title">Escolha o dia e o horário</h2>
    <p class="pub-sub">Duração total: ${fmtDuration(totals().duration)}</p>
    <div class="day-scroll">${pills}</div>
    <div class="slot-area">${slotsHtml}</div>`;
}

function summaryCard() {
  const { duration, price } = totals();
  return `<div class="card pad pub-summary">
    <div class="sum-when">${icon('calendar')}<div><b>${esc(fmtDateLong(st.date))}</b><span>às ${st.start} · ${fmtDuration(duration)}</span></div></div>
    <ul>${selectedServices().map(s => `<li><span>${esc(s.name)}</span><span>${money(s.price)}</span></li>`).join('')}</ul>
    <div class="sum-total"><span>Total</span><strong>${money(price)}</strong></div>
  </div>`;
}

function stepDetails() {
  return `
    <button class="back-link" data-action="go-step" data-step="2">${icon('chevLeft')} Horário</button>
    <h2 class="pub-title">Confirme seus dados</h2>
    ${summaryCard()}
    <form id="book-form" class="form" autocomplete="on" novalidate>
      <div class="field"><label for="b-name">Seu nome</label><input id="b-name" name="name" autocomplete="name" maxlength="80" placeholder="Nome e sobrenome"></div>
      <div class="field"><label for="b-phone">WhatsApp</label><input id="b-phone" name="tel" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="(00) 00000-0000"></div>
      <div class="field"><label for="b-notes">Observação <span class="muted">(opcional)</span></label><textarea id="b-notes" rows="2" maxlength="300" placeholder="Ex.: cor desejada, alguma preferência…"></textarea></div>
    </form>`;
}

function mountDetails() {
  const saved = remembered();
  $('#b-name').value = saved.name || '';
  $('#b-phone').value = saved.phone || '';
  bindPhoneMask($('#b-phone'));
  $('#book-form').addEventListener('submit', submitBooking);
}

function stepDone() {
  const d = st.done;
  const s = st.info.settings;
  const end = toMin(d.start) + d.duration;
  const stamp = t => `${d.date.replace(/-/g, '')}T${fromMin(t).replace(':', '')}00`;
  const gcal = 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    `&text=${encodeURIComponent(`${d.services.map(x => x.name).join(' + ')} · ${s.businessName}`)}` +
    `&dates=${stamp(toMin(d.start))}/${stamp(end)}&ctz=America/Sao_Paulo`;
  const waMsg = `Olá! Acabei de agendar pelo link: ${d.services.map(x => x.name).join(' + ')}, ${fmtDateLong(d.date)} às ${d.start}. Nome: ${d.name}.`;

  return `<div class="done">
    <span class="done-icon">${icon('check')}</span>
    <h2>Horário confirmado!</h2>
    <p class="pub-sub">Te esperamos ${esc(fmtDateLong(d.date))}, às ${d.start}.</p>
    ${summaryCard()}
    <div class="done-actions">
      <a class="btn btn-ghost btn-block" href="${gcal}" target="_blank" rel="noopener">${icon('calendar')} Salvar na minha agenda</a>
      ${s.whatsapp ? `<a class="btn btn-ghost btn-wa btn-block" href="${waLink(s.whatsapp, waMsg)}" target="_blank" rel="noopener">${icon('chat')} Falar com o estúdio</a>` : ''}
      <button class="btn btn-primary btn-block" data-action="restart">Fazer outro agendamento</button>
    </div>
    <p class="muted small">Precisa remarcar ou cancelar? ${s.whatsapp ? 'Fale com o estúdio pelo WhatsApp.' : 'Entre em contato com o estúdio.'}</p>
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
  return `<div class="bottom-bar"><div class="bottom-inner"><div class="bb-info">${info}</div>${button}</div></div>`;
}

/* ---------- Ações ---------- */
async function goStep(step) {
  if (step === 2) {
    try { await refreshBusy(); } catch (err) { return toast(err.message); }
    const valid = nextDays().filter(k => slotsFor(k).length);
    if (!valid.includes(st.date)) st.date = valid[0] || null;
    if (st.start && !slotsFor(st.date).map(fromMin).includes(st.start)) st.start = null;
  }
  st.step = step;
  render();
  window.scrollTo(0, 0);
}

async function submitBooking(e) {
  e.preventDefault();
  const name = $('#b-name').value.trim();
  const phone = $('#b-phone').value.trim();
  const notes = $('#b-notes').value.trim();
  if (name.length < 2) return toast('Informe seu nome.');
  if (![10, 11].includes(digits(phone).length)) return toast('Informe seu WhatsApp com DDD.');

  const services = selectedServices();
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

  try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ name, phone })); } catch { /* opcional */ }
  st.done = { date: result.date, start: result.start, duration: result.duration, services, name };
  st.step = 4;
  render();
  window.scrollTo(0, 0);
}

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
  root.innerHTML = `<div class="pub-loading">${icon('calendar')}<p>Carregando horários…</p></div>`;
  try {
    st.info = await API.publicInfo();
    applyAccent(st.info.settings.accent);
    document.title = `Agendar · ${st.info.settings.businessName}`;
    render();
  } catch (err) {
    root.innerHTML = `<div class="empty">${icon('alert')}<h3>Não foi possível carregar</h3><p>${esc(err.message)}</p>
      <button class="btn btn-primary" onclick="location.reload()">Tentar novamente</button></div>`;
  }
})();
