'use strict';

/* ============================================================
   Painel da dona — estado
   ============================================================ */
let db = null; // { settings, services, clients, appointments }
const ui = { date: todayKey(), clientQuery: '', finPeriod: 'semana', finAnchor: todayKey() };

const isActive = a => !FREES_SLOT.includes(a.status);
const isWorkDay = k => db.settings.workDays.includes(parseKey(k).getDay());

/* ---------- Bloqueios ---------- */
const NO_END = '2099-12-31'; // "sem data final" nos bloqueios recorrentes
const isRecurring = b => Array.isArray(b.weekdays) && b.weekdays.length > 0;
const blockApplies = (b, k) => k >= b.startDate && k <= b.endDate &&
  (!isRecurring(b) || b.weekdays.includes(parseKey(k).getDay()));
const blocksOn = k => db.blocks.filter(b => blockApplies(b, k));
const fullDayBlock = k => blocksOn(k).find(b => !b.startTime);
const blockMinutes = b => (b.startTime ? [toMin(b.startTime), toMin(b.endTime)] : [0, 1440]);
// Bloqueios no mesmo formato de agendamento, para o cálculo de horários livres
const blockBusy = k => blocksOn(k).map(b => {
  const [s, e] = blockMinutes(b);
  return { date: k, start: fromMin(s), duration: e - s, kind: 'block' };
});
function findBlock(date, start, duration) {
  return blocksOn(date).find(b => {
    const [s, e] = blockMinutes(b);
    return start < e && start + duration > s;
  });
}
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // segunda a domingo
function weekdaysLabel(days) {
  const key = [...days].sort().join(',');
  if (key === '0,1,2,3,4,5,6') return 'todos os dias';
  if (key === '1,2,3,4,5') return 'seg a sex';
  if (key === '1,2,3,4,5,6') return 'seg a sáb';
  return WEEK_ORDER.filter(d => days.includes(d)).map(d => DOW_SHORT[d].toLowerCase()).join(', ');
}
function blockLabel(b) {
  const d = k => fmtDateShort(k).slice(0, 5);
  const time = b.startTime ? `${b.startTime} – ${b.endTime}` : 'dia inteiro';
  if (isRecurring(b)) {
    const days = weekdaysLabel(b.weekdays);
    const range = b.endDate >= NO_END ? `desde ${d(b.startDate)}` : `de ${d(b.startDate)} a ${d(b.endDate)}`;
    return `🔁 ${days.charAt(0).toUpperCase() + days.slice(1)} · ${time} · ${range}`;
  }
  const dates = b.startDate === b.endDate ? d(b.startDate) : `${d(b.startDate)} a ${d(b.endDate)}`;
  return `${dates} · ${time}`;
}

const availableSlots = (date, duration, excludeId) =>
  computeSlots(db.settings, [...db.appointments, ...blockBusy(date)], date, duration, excludeId);
const findClientByName = name => db.clients.find(x => x.name.trim().toLowerCase() === name.trim().toLowerCase());
const publicUrl = () => new URL('../', location.href).href;
const MAX_INTERVAL = 240; // mesmo limite do banco (settings.slot_interval)
const manageUrl = a => (a.manageToken ? `${publicUrl()}?r=${a.manageToken}` : '');
const clientCanManage = () => db.settings.changeNoticeHours >= 0;
// Sinal por Pix: vale quando há percentual e chave cadastrada; "pendente" = a dona ainda não confirmou
const depositActive = () => db.settings.depositPercent > 0 && Boolean(db.settings.pixKey);
const pendingDeposit = a => a.status === 'agendado' && a.depositAmount > 0 && !a.depositPaidAt;
/* ---------- Retorno / manutenção ---------- */
const svcById = id => db.services.find(x => x.id === id);
const addDaysKey = (k, n) => dateKey(addDays(parseKey(k), n));
const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);

// Regra de retorno de um atendimento: a do serviço com o menor prazo.
// Se a cliente tem um prazo próprio, ele substitui a janela do serviço.
function returnRule(appt) {
  const withRule = appt.services.map(x => svcById(x.serviceId)).filter(x => x && x.returnMin);
  if (!withRule.length) return null;
  const from = withRule.sort((a, b) => a.returnMin - b.returnMin)[0];
  const own = db.clients.find(c => c.id === appt.clientId)?.returnDays;
  return {
    from,
    service: svcById(from.returnServiceId) || from,
    min: own || from.returnMin,
    max: own || from.returnMax,
    target: own || Math.round((from.returnMin + from.returnMax) / 2),
  };
}

// Situação de retorno de uma cliente; nulo se não se aplica ou se ela já tem horário marcado
function clientReturn(c) {
  const mine = db.appointments.filter(a => a.clientId === c.id);
  const tk = todayKey();
  if (mine.some(a => isActive(a) && a.status !== 'concluido' && a.date >= tk)) return null;
  const last = mine.filter(a => a.status === 'concluido')
    .sort((x, y) => (y.date + y.start).localeCompare(x.date + x.start))
    .find(a => returnRule(a));
  if (!last) return null;
  const rule = returnRule(last);
  return {
    client: c, last, rule,
    days: daysBetween(last.date, tk),
    opens: addDaysKey(last.date, rule.min),
    closes: addDaysKey(last.date, rule.max),
    target: addDaysKey(last.date, rule.target),
  };
}

// Clientes na época do retorno: de 5 dias antes da janela até 60 dias depois
function dueReturns() {
  return db.clients.map(clientReturn)
    .filter(r => r && r.days >= r.rule.min - 5 && r.days <= r.rule.max + 60)
    .sort((a, b) => b.days - a.days);
}
const remindedRecently = c => c.returnRemindedAt && Date.now() - Date.parse(c.returnRemindedAt) < 7 * 86400000;

// Próximo dia de atendimento a partir de uma data (pula folgas e dias bloqueados)
function nextOpenDay(k) {
  let day = k < todayKey() ? addDaysKey(todayKey(), 1) : k;
  for (let i = 0; i < 21 && (!isWorkDay(day) || fullDayBlock(day)); i++) day = addDaysKey(day, 1);
  return day;
}

function returnWindowText(r) {
  const d = k => fmtDateShort(k).slice(0, 5);
  return r.rule.min === r.rule.max ? `por volta de ${d(r.target)}` : `entre ${d(r.opens)} e ${d(r.closes)}`;
}

function openReturnForm(r) {
  openApptForm(null, { clientId: r.client.id, date: nextOpenDay(r.target), serviceIds: [r.rule.service.id] });
}

async function offerReturn(saved) {
  const c = db.clients.find(x => x.id === saved.clientId);
  const r = c && clientReturn(c);
  if (!r || r.last.id !== saved.id) return;
  const ok = await confirmDialog(
    `Sugestão: ${r.rule.service.name}, ${returnWindowText(r)}. Você escolhe o dia e o horário na próxima tela.`,
    { title: `Agendar o retorno de ${firstName(c.name)}?`, ok: 'Agendar retorno' });
  if (ok) openReturnForm(r);
}

// Sinal retido: a dona confirmou o recebimento e o atendimento não aconteceu (falta ou cancelamento)
const retainedDeposit = a => (FREES_SLOT.includes(a.status) && a.depositPaidAt ? a.depositAmount : 0);
// Sinal já recebido de um atendimento que ainda vai acontecer (desconta do "a receber")
const advanceDeposit = a => (a.depositPaidAt ? Math.min(a.depositAmount, a.price) : 0);
const pendingDeposits = () => db.appointments.filter(pendingDeposit)
  .sort((x, y) => String(x.depositDueAt || '').localeCompare(String(y.depositDueAt || '')));
// Trecho com o link de remarcar/cancelar, para anexar às mensagens de WhatsApp
const manageLine = a => (clientCanManage() && a.manageToken
  ? `

Se precisar remarcar ou cancelar: ${manageUrl(a)}` : '');

function dayAppointments(k) {
  return db.appointments
    .filter(a => a.date === k)
    .sort((a, b) => toMin(a.start) - toMin(b.start));
}

const bufferMin = () => Number(db.settings.bufferMinutes) || 0;

// Agendamento que ocupa o horário, contando o intervalo de limpeza entre atendimentos
function findConflict(date, start, duration, excludeId) {
  const buf = bufferMin();
  return db.appointments.find(a =>
    a.date === date && a.id !== excludeId && isActive(a) &&
    start < toMin(a.start) + a.duration + buf && start + duration + buf > toMin(a.start));
}

/** Substitui (ou adiciona) um item numa lista do estado local, pelo id. */
function putLocal(list, item) {
  const i = db[list].findIndex(x => x.id === item.id);
  if (i >= 0) db[list][i] = item;
  else db[list].push(item);
}

/* ============================================================
   Login
   ============================================================ */
function showAuth(html) {
  $('#app').hidden = true;
  const screen = $('#auth-screen');
  screen.hidden = false;
  screen.innerHTML = `<div class="auth-col"><div class="auth-card card">${html}</div>${creditHtml()}</div>`;
}

function showSetupNeeded() {
  showAuth(`
    <span class="brand-mark">${icon('alert')}</span>
    <h1>Falta configurar o Supabase</h1>
    <p class="muted">Preencha a URL e a chave pública do projeto no arquivo <b>js/config.js</b> e recarregue a página.</p>`);
}

function showLogin(message = '', email = '') {
  showAuth(`
    <span class="brand-mark">${icon('lock')}</span>
    <h1>Área da administração</h1>
    <p class="muted">Entre com seu e-mail e senha para acessar a agenda.</p>
    <form id="login-form" class="form">
      <div class="field"><label for="l-email">E-mail</label><input id="l-email" type="email" autocomplete="username" required></div>
      <div class="field">
        <div class="label-row"><label for="l-pass">Senha</label><button type="button" class="link-btn" data-action="forgot-password">Esqueci minha senha</button></div>
        <div class="pass-wrap">
          <input id="l-pass" type="password" autocomplete="current-password" required>
          <button type="button" class="pass-toggle" data-action="toggle-pass" data-target="l-pass" aria-label="Mostrar senha" aria-pressed="false">${icon('eye')}</button>
        </div>
      </div>
      ${message ? `<p class="hint warn" style="margin:0">${esc(message)}</p>` : ''}
      <button class="btn btn-primary btn-block" type="submit">Entrar</button>
    </form>
    <a class="auth-link" href="../">Ir para a página de agendamento das clientes</a>`);

  $('#l-email').value = email;
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#l-email').value.trim();
    const pass = $('#l-pass').value;
    await withBusy($('#login-form [type=submit]'), async () => {
      const session = await API.signIn(email, pass);
      await enter(session);
    });
  });
  $(email ? '#l-pass' : '#l-email').focus();
}

/* ---------- Recuperação de senha ---------- */
function showForgotPassword(email = '') {
  showAuth(`
    <span class="brand-mark">${icon('mail')}</span>
    <h1>Esqueceu a senha?</h1>
    <p class="muted">Informe o e-mail de acesso. Vamos enviar um link para você criar uma nova senha.</p>
    <form id="forgot-form" class="form">
      <div class="field"><label for="fp-email">E-mail</label><input id="fp-email" type="email" autocomplete="username" required></div>
      <button class="btn btn-primary btn-block" type="submit">Enviar link</button>
    </form>
    <button type="button" class="auth-link link-plain" data-action="back-to-login">Voltar para o login</button>`);

  $('#fp-email').value = email;
  $('#fp-email').focus();
  $('#forgot-form').addEventListener('submit', async e => {
    e.preventDefault();
    const address = $('#fp-email').value.trim();
    if (!address) return toast('Informe o e-mail.');
    await withBusy($('#forgot-form [type=submit]'), async () => {
      await API.sendPasswordReset(address);
      showResetSent(address);
    });
  });
}

function showResetSent(email) {
  showAuth(`
    <span class="brand-mark">${icon('mail')}</span>
    <h1>Verifique seu e-mail</h1>
    <p class="muted">Se <b>${esc(email)}</b> estiver cadastrado, você vai receber em instantes um link para criar uma nova senha.</p>
    <ul class="auth-tips">
      <li>O link vale por <b>1 hora</b> e só pode ser usado uma vez.</li>
      <li>Não chegou? Confira a caixa de <b>spam</b> ou <b>promoções</b>.</li>
    </ul>
    <button type="button" class="btn btn-ghost btn-block" data-action="back-to-login" data-email="${esc(email)}">Voltar para o login</button>
    <button type="button" class="auth-link link-plain" data-action="forgot-password" data-email="${esc(email)}">Enviar de novo</button>`);
}

function showNewPassword(session) {
  showAuth(`
    <span class="brand-mark">${icon('lock')}</span>
    <h1>Crie sua nova senha</h1>
    <p class="muted">Para a conta <b>${esc(session.user.email)}</b>.</p>
    ${passwordFormHtml('np')}`);
  bindPasswordForm('np', async () => {
    toast('Senha alterada com sucesso');
    await enter(session);
  });
}

/** Formulário de nova senha (usado na recuperação e em Ajustes → Alterar senha). */
function passwordFormHtml(prefix) {
  return `<form id="${prefix}-form" class="form" novalidate>
    <div class="field"><label for="${prefix}-pass">Nova senha</label><input id="${prefix}-pass" type="password" autocomplete="new-password" minlength="8"></div>
    <div class="field"><label for="${prefix}-pass2">Repita a nova senha</label><input id="${prefix}-pass2" type="password" autocomplete="new-password" minlength="8"></div>
    <label class="check-row"><input type="checkbox" id="${prefix}-show"> Mostrar senha</label>
    <p class="hint" style="margin:0">Use pelo menos 8 caracteres, misturando letras e números.</p>
    <button class="btn btn-primary btn-block" type="submit">Salvar nova senha</button>
  </form>`;
}

function bindPasswordForm(prefix, onDone) {
  const p1 = $(`#${prefix}-pass`), p2 = $(`#${prefix}-pass2`);
  $(`#${prefix}-show`).addEventListener('change', e => {
    p1.type = p2.type = e.target.checked ? 'text' : 'password';
  });
  p1.focus();
  $(`#${prefix}-form`).addEventListener('submit', async e => {
    e.preventDefault();
    if (p1.value.length < 8) return toast('A senha precisa ter pelo menos 8 caracteres.');
    if (!/[a-zA-Z]/.test(p1.value) || !/\d/.test(p1.value)) return toast('Misture letras e números na senha.');
    if (p1.value !== p2.value) return toast('As duas senhas não são iguais.');
    await withBusy($(`#${prefix}-form [type=submit]`), async () => {
      await API.updatePassword(p1.value);
      await onDone();
    });
  });
}

async function enter(session) {
  showAuth(`<div class="auth-loading">${icon('calendar')}<p>Carregando agenda…</p></div>`);
  let allowed;
  try {
    allowed = await API.isAdmin(session.user.id);
    if (allowed) db = await API.loadAll();
  } catch (err) {
    return showLogin(err.message);
  }
  if (!allowed) {
    await API.signOut();
    return showLogin('Este usuário não tem acesso ao painel.');
  }
  ui.email = session.user.email;
  $('#auth-screen').hidden = true;
  $('#app').hidden = false;
  applyAccent(db.settings.accent);
  renderNav();
  render();
  startRealtime();
}

/* ---------- Atualização em tempo real ---------- */
let realtimeOn = false;
let reloadTimer;

function startRealtime() {
  if (realtimeOn) return;
  realtimeOn = true;
  API.subscribe((table, payload) => {
    const row = payload.new;
    if (table === 'appointments' && payload.eventType === 'INSERT' && row?.source === 'online') {
      toast(`Novo agendamento online: ${row.client_name}, ${fmtDateShort(row.date).slice(0, 5)} às ${row.start_time}`);
    }
    if (table === 'appointments' && payload.eventType === 'UPDATE' && row?.client_action && row.client_action_at &&
        Date.now() - Date.parse(row.client_action_at) < 60000) {
      const when = `${fmtDateShort(row.date).slice(0, 5)} às ${row.start_time}`;
      toast(row.client_action === 'cancelou' ? `${row.client_name} cancelou o horário de ${when}`
        : row.client_action === 'expirou' ? `Sinal não pago: o horário de ${row.client_name} (${when}) foi liberado`
        : `${row.client_name} remarcou para ${when}`);
    }
    scheduleReload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleReload();
  });
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      db = await API.loadAll();
      // Não redesenha enquanto a dona digita em algum campo da tela
      const el = document.activeElement;
      if (!($('#view').contains(el) && el.matches('input, textarea, select'))) render();
    } catch (err) {
      console.error(err);
    }
  }, 500);
}

/* ============================================================
   Navegação
   ============================================================ */
const ROUTES = {
  agenda: { label: 'Agenda', icon: 'calendar', render: renderAgenda },
  servicos: { label: 'Serviços', icon: 'sparkle', render: renderServices },
  clientes: { label: 'Clientes', icon: 'users', render: renderClients },
  financas: { label: 'Finanças', icon: 'chart', render: renderFinance },
  ajustes: { label: 'Ajustes', icon: 'sliders', render: renderSettings },
};

function currentRoute() {
  const r = location.hash.slice(1);
  return ROUTES[r] ? r : 'agenda';
}

function renderNav() {
  const items = Object.entries(ROUTES)
    .map(([key, r]) => `<a href="#${key}" data-nav="${key}">${icon(r.icon)}<span>${r.label}</span></a>`)
    .join('');
  $('#sidenav').innerHTML = items;
  $('#tabbar').innerHTML = items;
  $('#brand-mark').innerHTML = icon('sparkle');
  $('#side-new').innerHTML = `${icon('plus')} Novo agendamento`;
  $('#side-logout').innerHTML = `${icon('logout')} Sair`;
  $('#fab').innerHTML = icon('plus');
}

function render() {
  if (!db) return;
  const route = currentRoute();
  $('#view').innerHTML = ROUTES[route].render() + creditHtml();
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === route));
  $('#brand-name').textContent = db.settings.businessName;
  document.title = `${ROUTES[route].label} · ${db.settings.businessName}`;
}

/* ============================================================
   Tela: Agenda
   ============================================================ */
function renderAgenda() {
  const sel = parseKey(ui.date);
  const weekStart = addDays(sel, -sel.getDay());
  const tk = todayKey();

  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).map(d => {
    const k = dateKey(d);
    const count = dayAppointments(k).filter(isActive).length;
    const off = !isWorkDay(k) || fullDayBlock(k);
    const cls = ['day', k === ui.date && 'is-selected', k === tk && 'is-today', off && 'is-off', fullDayBlock(k) && 'is-blocked'].filter(Boolean).join(' ');
    return `<button class="${cls}" data-action="pick-day" data-date="${k}" aria-label="${esc(fmtDateLong(k))}">
      <span class="day-dow">${DOW_SHORT[d.getDay()]}</span>
      <span class="day-num">${d.getDate()}</span>
      <span class="day-dot">${'<i></i>'.repeat(Math.min(count, 3))}</span>
    </button>`;
  }).join('');

  const appts = dayAppointments(ui.date);
  const active = appts.filter(isActive);

  return `<div class="view">
    <header class="page-head">
      <div>
        <p class="eyebrow">${esc(fmtDateLong(tk))}</p>
        <h1>Agenda</h1>
      </div>
      <div class="head-actions">
        ${ui.date !== tk ? `<button class="btn btn-ghost btn-sm" data-action="go-today">Hoje</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-action="new-block" data-date="${ui.date}">${icon('lock')} Bloquear</button>
      </div>
    </header>

    <section class="card week-card">
      <div class="week-head">
        <button class="icon-btn" data-action="week-prev" aria-label="Semana anterior">${icon('chevLeft')}</button>
        <button class="month-btn" data-action="open-date">
          ${MONTHS[sel.getMonth()]} ${sel.getFullYear()} ${icon('chevDown')}
          <input type="date" id="date-jump" class="date-jump" value="${ui.date}" tabindex="-1" aria-hidden="true">
        </button>
        <button class="icon-btn" data-action="week-next" aria-label="Próxima semana">${icon('chevRight')}</button>
      </div>
      <div class="week">${week}</div>
    </section>

    ${depositBanner()}
    ${returnsBanner()}
    ${reminderBanner()}

    <section class="stats">
      <div class="stat"><span>Atendimentos</span><strong>${active.length}</strong></div>
      <div class="stat"><span>Previsto</span><strong>${moneyShort(sum(active, a => a.price))}</strong></div>
      <div class="stat"><span>Ocupado</span><strong>${active.length ? fmtDuration(sum(active, a => a.duration)) : '—'}</strong></div>
    </section>

    <section>
      <div class="section-head"><h2>${esc(fmtDateLong(ui.date))}</h2>${bufferMin() ? `<span class="muted small">${icon('clock')} ${bufferMin()} min de intervalo entre clientes</span>` : ''}</div>
      ${timelineHtml(ui.date, appts)}
    </section>
  </div>`;
}

function timelineHtml(k, appts) {
  const s = db.settings;
  const fullBlock = fullDayBlock(k);
  const partial = blocksOn(k).filter(b => b.startTime);
  const work = isWorkDay(k) && !fullBlock;
  const tk = todayKey();
  const banner = fullBlock ? blockBanner(fullBlock) : '';

  if (!appts.length && !partial.length) {
    if (fullBlock) return banner;
    return `<div class="empty">
      ${icon(work ? 'calendar' : 'moon')}
      <h3>${work ? 'Nenhum agendamento' : 'Dia de folga'}</h3>
      <p>${work ? `Atendimento das ${s.openTime} às ${s.closeTime}.` : 'Este dia está marcado como fechado nos ajustes.'}</p>
      <button class="btn btn-primary" data-action="new-appt" data-date="${k}">${icon('plus')} Agendar</button>
    </div>`;
  }

  // Cartões, bloqueios e intervalos livres, ordenados pelo horário de início
  const items = [
    ...appts.map(a => ({ at: toMin(a.start), order: 1, html: apptCard(a) })),
    ...partial.map(b => ({ at: toMin(b.startTime), order: 1, html: blockCard(b) })),
  ];
  const step = s.slotInterval;
  const pushGap = (from, to) => {
    if (!work || k < tk) return;
    if (k === tk) from = Math.max(from, Math.ceil(nowMinutes() / step) * step);
    if (to - from < Math.max(30, step)) return;
    items.push({ at: from, order: 0, html: `<button class="gap" data-action="new-appt" data-date="${k}" data-start="${fromMin(from)}">
      <span>Livre · <b>${fromMin(from)} – ${fromMin(to)}</b> · ${fmtDuration(to - from)}</span>
      <span class="gap-cta">${icon('plus')} Agendar</span>
    </button>` });
  };

  // Períodos ocupados: agendamentos ativos (com o intervalo depois) + bloqueios parciais.
  // Antes de um agendamento, o tempo livre também desconta o intervalo de limpeza.
  const buf = bufferMin();
  const busy = [
    ...appts.filter(isActive).map(a => [toMin(a.start), toMin(a.start) + a.duration + buf, buf]),
    ...partial.map(b => [...blockMinutes(b), 0]),
  ].sort((x, y) => x[0] - y[0]);

  let cursor = toMin(s.openTime);
  for (const [start, end, before] of busy) {
    pushGap(cursor, start - before);
    cursor = Math.max(cursor, end);
  }
  pushGap(cursor, toMin(s.closeTime));

  items.sort((x, y) => x.at - y.at || x.order - y.order);
  return `${banner}<div class="timeline">${items.map(i => i.html).join('')}</div>`;
}

function blockBanner(b) {
  const range = isRecurring(b) ? ` · 🔁 toda semana (${weekdaysLabel(b.weekdays)})`
    : b.startDate === b.endDate ? '' : ` · de ${fmtDateShort(b.startDate).slice(0, 5)} a ${fmtDateShort(b.endDate).slice(0, 5)}`;
  return `<button class="block-banner" data-action="edit-block" data-id="${b.id}">
    ${icon('lock')}
    <div><b>Dia bloqueado</b><span>${esc(b.reason || 'Sem motivo informado')}${range}</span></div>
    <span class="block-edit">Editar</span>
  </button>`;
}

function blockCard(b) {
  return `<button class="block-card" data-action="edit-block" data-id="${b.id}">
    <div class="appt-time"><strong>${b.startTime}</strong><span>${b.endTime}</span></div>
    ${icon('lock')}
    <div class="appt-body">
      <div class="appt-title"><span>Bloqueado</span></div>
      <div class="appt-sub">${esc(b.reason || 'Sem motivo informado')}${isRecurring(b) ? ' · 🔁 toda semana' : ''}</div>
    </div>
  </button>`;
}

function apptTags(a) {
  if (pendingDeposit(a)) return '<span class="tag tag-deposit">aguardando sinal</span>';
  if (a.clientAction === 'expirou' && a.status === 'cancelado') return '<span class="tag tag-warn">sinal não pago</span>';
  if (a.clientAction === 'cancelou' && a.status === 'cancelado') return '<span class="tag tag-warn">cancelado pela cliente</span>';
  if (a.clientAction === 'remarcou' && isActive(a)) return '<span class="tag tag-info">remarcado pela cliente</span>';
  if (a.source === 'online') return `<span class="tag" title="Agendado pela cliente">${icon('globe')}online</span>`;
  return '';
}

function apptCard(a) {
  const status = STATUS[a.status] ? a.status : 'agendado';
  const color = a.services[0]?.color || 'var(--accent)';
  const names = a.services.map(s => s.name).join(' + ');
  return `<button class="appt st-${status}" data-action="edit-appt" data-id="${a.id}">
    <div class="appt-time"><strong>${a.start}</strong><span>${fromMin(toMin(a.start) + a.duration)}</span></div>
    <span class="appt-bar" style="background:${esc(color)}"></span>
    <div class="appt-body">
      <div class="appt-title"><span>${esc(a.clientName)}</span>${apptTags(a)}</div>
      <div class="appt-sub">${esc(names)} · ${fmtDuration(a.duration)}</div>
    </div>
    <div class="appt-side">
      <div class="appt-price">${money(a.price)}</div>
      <span class="badge st-${status}">${STATUS[status].label}</span>
    </div>
  </button>`;
}

/* ============================================================
   Tela: Serviços
   ============================================================ */
function renderServices() {
  const list = db.services.length
    ? `<div class="card list">${db.services.map(s => `
        <button class="list-item" data-action="edit-service" data-id="${s.id}">
          <span class="swatch" style="background:${esc(s.color)}"></span>
          <div class="li-body">
            <div class="li-title"><span>${esc(s.name)}</span>${s.active ? '' : '<span class="tag">oculto no link</span>'}</div>
            <div class="li-sub">${icon('clock')} ${fmtDuration(s.duration)}</div>
          </div>
          <div class="li-side"><strong>${money(s.price)}</strong>${icon('chevRight')}</div>
        </button>`).join('')}</div>`
    : `<div class="empty">${icon('sparkle')}<h3>Nenhum serviço cadastrado</h3>
        <p>Cadastre os serviços que você oferece, com valor e duração.</p>
        <button class="btn btn-primary" data-action="new-service">${icon('plus')} Novo serviço</button></div>`;

  return `<div class="view">
    <header class="page-head">
      <div><p class="eyebrow">${db.services.length} ${db.services.length === 1 ? 'serviço' : 'serviços'}</p><h1>Serviços</h1></div>
      <button class="btn btn-primary btn-sm" data-action="new-service">${icon('plus')} Novo</button>
    </header>
    <p class="lead">Toque em um serviço para editar nome, valor e tempo de duração.</p>
    ${list}
  </div>`;
}

function openServiceForm(svc) {
  const isEdit = !!svc;
  const s = svc ? { ...svc } : { name: '', price: '', duration: 60, color: PALETTE[db.services.length % PALETTE.length], active: true, sort: db.services.length + 1 };
  const quick = [15, 30, 45, 60, 90, 120, 180];

  openSheet({
    title: isEdit ? 'Editar serviço' : 'Novo serviço',
    body: `<form id="svc-form" class="form" autocomplete="off" novalidate>
      <div class="field">
        <label for="s-name">Nome do serviço</label>
        <input id="s-name" maxlength="60" placeholder="Ex.: Manicure">
      </div>
      <div class="row">
        <div class="field">
          <label for="s-price">Valor (R$)</label>
          <input id="s-price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0,00">
        </div>
        <div class="field">
          <label for="s-dur">Duração (minutos)</label>
          <input id="s-dur" type="number" inputmode="numeric" min="5" max="720" step="5">
        </div>
      </div>
      <div class="quick" id="s-quick">${quick.map(m => `<button type="button" data-min="${m}">${fmtDuration(m)}</button>`).join('')}</div>
      <div class="field">
        <span class="label">Cor na agenda</span>
        <div class="swatches">${PALETTE.map(c => `<label><input type="radio" name="color" value="${c}"><span style="background:${c}"></span></label>`).join('')}</div>
      </div>
      <div class="field">
        <span class="label">Retorno / manutenção <span class="muted">(opcional)</span></span>
        <div class="row">
          <div class="field"><label for="s-ret-min" class="sub-label">A partir de (dias)</label><input id="s-ret-min" type="number" inputmode="numeric" min="1" max="365" placeholder="Ex.: 20"></div>
          <div class="field"><label for="s-ret-max" class="sub-label">Até (dias)</label><input id="s-ret-max" type="number" inputmode="numeric" min="1" max="365" placeholder="Ex.: 40"></div>
        </div>
        <label for="s-ret-svc" class="sub-label" style="margin-top:6px">Serviço do retorno</label>
        <select id="s-ret-svc">
          <option value="">Este mesmo serviço</option>
          ${db.services.filter(x => x.id !== s.id).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}
        </select>
        <small class="muted small">Ex.: alongamento em gel, com retorno entre 20 e 40 dias para manutenção. O painel sugere o retorno ao concluir o atendimento e avisa quando a cliente está na época de voltar.</small>
      </div>
      <label class="switch">
        <span><b>Disponível no agendamento online</b><small>Se desligado, só você pode agendar este serviço.</small></span>
        <input type="checkbox" id="s-active">
        <span class="track"></span>
      </label>
    </form>`,
    footer: `${isEdit ? `<button type="button" class="btn btn-danger-ghost btn-icon" id="s-del" aria-label="Excluir serviço">${icon('trash')}</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn btn-ghost" data-action="close-sheet">Cancelar</button>
      <button type="submit" form="svc-form" class="btn btn-primary">Salvar</button>`,
    onMount() {
      const f = $('#svc-form');
      const dur = $('#s-dur');
      $('#s-name').value = s.name;
      $('#s-price').value = s.price === '' ? '' : Number(s.price).toFixed(2);
      $('#s-active').checked = s.active !== false;
      $('#s-ret-min').value = s.returnMin || '';
      $('#s-ret-max').value = s.returnMax || '';
      $('#s-ret-svc').value = s.returnServiceId || '';
      dur.value = s.duration;
      const colorInput = $(`input[name=color][value="${s.color}"]`, f) || $('input[name=color]', f);
      colorInput.checked = true;

      const markQuick = () => $$('#s-quick button').forEach(b => b.classList.toggle('on', Number(b.dataset.min) === Number(dur.value)));
      markQuick();
      dur.addEventListener('input', markQuick);
      $('#s-quick').addEventListener('click', e => {
        const b = e.target.closest('button[data-min]');
        if (!b) return;
        dur.value = b.dataset.min;
        markQuick();
      });

      f.addEventListener('submit', async e => {
        e.preventDefault();
        const name = $('#s-name').value.trim();
        const price = Number($('#s-price').value);
        const duration = Math.round(Number(dur.value));
        if (!name) return toast('Informe o nome do serviço.');
        if (!Number.isFinite(price) || price < 0 || $('#s-price').value === '') return toast('Informe um valor válido.');
        if (!duration || duration < 5) return toast('A duração mínima é de 5 minutos.');
        const retMin = Math.round(Number($('#s-ret-min').value)) || null;
        const retMax = Math.round(Number($('#s-ret-max').value)) || retMin;
        if (retMin && (retMin < 1 || retMax > 365 || retMax < retMin)) return toast('No retorno, o "até" deve ser maior ou igual ao "a partir de" (máximo 365 dias).');
        if (!retMin && $('#s-ret-max').value) return toast('Informe também o "a partir de" do retorno.');
        const record = {
          ...s, name, price, duration, color: $('input[name=color]:checked', f).value, active: $('#s-active').checked,
          returnMin: retMin, returnMax: retMin ? retMax : null, returnServiceId: retMin ? $('#s-ret-svc').value || null : null,
        };
        await withBusy($('.sheet-foot [type=submit]'), async () => {
          putLocal('services', await API.saveService(record));
          closeSheet();
          render();
          toast(isEdit ? 'Serviço atualizado' : 'Serviço criado');
        });
      });

      $('#s-del')?.addEventListener('click', async e => {
        const ok = await confirmDialog('Agendamentos já feitos com este serviço não serão alterados.', { title: `Excluir "${s.name}"?`, ok: 'Excluir', danger: true });
        if (!ok) return;
        await withBusy(e.currentTarget, async () => {
          await API.deleteService(s.id);
          db.services = db.services.filter(x => x.id !== s.id);
          closeSheet();
          render();
          toast('Serviço excluído');
        });
      });
    },
  });
}

/* ============================================================
   Tela: Clientes
   ============================================================ */
const noShowTag = n => (n ? `<span class="tag tag-noshow">${n} falta${n === 1 ? '' : 's'}</span>` : '');

function clientSummary(c) {
  const mine = db.appointments.filter(a => a.clientId === c.id);
  const appts = mine.filter(isActive);
  const past = appts.filter(a => a.date <= todayKey()).sort((a, b) => b.date.localeCompare(a.date));
  return { count: appts.length, last: past[0]?.date || null, noShows: mine.filter(a => a.status === 'faltou').length };
}

function renderClients() {
  return `<div class="view">
    <header class="page-head">
      <div><p class="eyebrow">${db.clients.length} ${db.clients.length === 1 ? 'cliente' : 'clientes'}</p><h1>Clientes</h1></div>
      <button class="btn btn-primary btn-sm" data-action="new-client">${icon('plus')} Novo</button>
    </header>
    <div class="search">
      ${icon('search')}
      <input id="client-search" type="search" placeholder="Buscar por nome ou telefone" value="${esc(ui.clientQuery)}" autocomplete="off">
    </div>
    <div id="client-list">${clientListHtml()}</div>
  </div>`;
}

function clientListHtml() {
  const q = ui.clientQuery.trim().toLowerCase();
  const qd = digits(q);
  const list = db.clients
    .filter(c => !q || c.name.toLowerCase().includes(q) || (qd && digits(c.phone).includes(qd)))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  if (!db.clients.length) {
    return `<div class="empty">${icon('users')}<h3>Nenhuma cliente ainda</h3>
      <p>As clientes são cadastradas automaticamente quando agendam.</p>
      <button class="btn btn-primary" data-action="new-client">${icon('plus')} Cadastrar cliente</button></div>`;
  }
  if (!list.length) return `<div class="empty flat"><p>Nenhuma cliente encontrada para "${esc(ui.clientQuery)}".</p></div>`;

  return `<div class="card list">${list.map(c => {
    const { count, last } = clientSummary(c);
    const { noShows } = clientSummary(c);
    const sub = [c.phone, count ? `${count} ${count === 1 ? 'atendimento' : 'atendimentos'}` : 'Sem atendimentos', last && `última vez ${fmtDateShort(last)}`].filter(Boolean).join(' · ');
    return `<button class="list-item" data-action="open-client" data-id="${c.id}">
      <span class="avatar">${esc(initials(c.name))}</span>
      <div class="li-body"><div class="li-title"><span>${esc(c.name)}</span>${noShowTag(noShows)}</div><div class="li-sub">${esc(sub)}</div></div>
      <div class="li-side">${icon('chevRight')}</div>
    </button>`;
  }).join('')}</div>`;
}

function openClientForm(client) {
  const isEdit = !!client;
  const c = client ? { ...client } : { name: '', phone: '', notes: '' };
  const appts = isEdit
    ? db.appointments.filter(a => a.clientId === c.id).sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start))
    : [];
  const done = appts.filter(a => a.status === 'concluido');
  const { count, last, noShows } = isEdit ? clientSummary(c) : { count: 0, last: null, noShows: 0 };
  const ret = isEdit ? clientReturn(c) : null;

  const header = isEdit ? `
    <div class="quick-actions">
      <button type="button" class="btn btn-primary" data-action="new-appt" data-client="${c.id}">${icon('plus')} Agendar</button>
      ${c.phone
        ? `<a class="btn btn-ghost btn-wa" href="${waLink(c.phone, `Olá, ${firstName(c.name)}!`)}" target="_blank" rel="noopener">${icon('chat')} WhatsApp</a>`
        : `<button type="button" class="btn btn-ghost" disabled>${icon('chat')} Sem telefone</button>`}
    </div>
    ${ret ? `<div class="notice-soft">${icon('repeat')}<span><b>Retorno indicado:</b> ${esc(ret.rule.service.name)}, ${returnWindowText(ret)} (último atendimento há ${ret.days} dia${ret.days === 1 ? '' : 's'}).<br>
      <button type="button" class="link-btn" style="margin-top:6px" data-action="book-return" data-id="${c.id}">Agendar retorno</button></span></div>` : ''}
    <div class="mini-stats">
      <div><span>Atendimentos</span><strong>${count}</strong></div>
      <div><span>Total pago</span><strong>${money(sum(done, a => a.price) + sum(appts, retainedDeposit))}</strong></div>
      <div><span>Última visita</span><strong>${last ? fmtDateShort(last).slice(0, 5) : '—'}</strong></div>
      <div class="${noShows ? 'is-warn' : ''}"><span>Faltas</span><strong>${noShows}</strong></div>
    </div>` : '';

  const history = isEdit ? `
    <div>
      <h3>Histórico</h3>
      ${appts.length ? `<div class="history">${appts.map(a => historyRow(a, true)).join('')}</div>`
      : '<p class="muted small">Nenhum atendimento ainda.</p>'}
    </div>` : '';

  openSheet({
    title: isEdit ? c.name : 'Nova cliente',
    body: `<div class="stack">
      ${header}
      <form id="client-form" class="form" autocomplete="off" novalidate>
        <div class="field"><label for="c-name">Nome</label><input id="c-name" maxlength="80" placeholder="Nome completo"></div>
        <div class="field"><label for="c-phone">WhatsApp / telefone</label><input id="c-phone" type="tel" inputmode="tel" placeholder="(00) 00000-0000"></div>
        <div class="field"><label for="c-notes">Observações</label><textarea id="c-notes" rows="2" placeholder="Preferências, alergias, cores favoritas…"></textarea></div>
        <div class="field">
          <label for="c-return">Retorno a cada (dias) <span class="muted">(opcional)</span></label>
          <input id="c-return" type="number" inputmode="numeric" min="1" max="365" placeholder="Usar o prazo do serviço">
          <small class="muted small">Preencha só se esta cliente precisa voltar num prazo diferente do padrão do serviço.</small>
        </div>
      </form>
      ${history}
    </div>`,
    footer: `${isEdit ? `<button type="button" class="btn btn-danger-ghost btn-icon" id="c-del" aria-label="Excluir cliente">${icon('trash')}</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn btn-ghost" data-action="close-sheet">Cancelar</button>
      <button type="submit" form="client-form" class="btn btn-primary">Salvar</button>`,
    onMount() {
      $('#c-name').value = c.name;
      $('#c-phone').value = c.phone || '';
      $('#c-notes').value = c.notes || '';
      $('#c-return').value = c.returnDays || '';
      bindPhoneMask($('#c-phone'));

      $('#client-form').addEventListener('submit', async e => {
        e.preventDefault();
        const name = $('#c-name').value.trim();
        const phone = $('#c-phone').value.trim();
        if (!name) return toast('Informe o nome da cliente.');
        if (db.clients.some(x => x.id !== c.id && x.name.trim().toLowerCase() === name.toLowerCase())) {
          return toast('Já existe uma cliente com esse nome.');
        }
        await withBusy($('.sheet-foot [type=submit]'), async () => {
          const returnDays = Math.min(Math.max(Math.round(Number($('#c-return').value)) || 0, 0), 365) || null;
          const saved = await API.saveClient({ ...c, name, phone, notes: $('#c-notes').value.trim(), returnDays });
          putLocal('clients', saved);
          if (isEdit && (name !== client.name || phone !== client.phone)) {
            await API.renameClientAppointments(saved.id, name, phone);
            db.appointments.forEach(a => { if (a.clientId === saved.id) { a.clientName = name; a.phone = phone; } });
          }
          closeSheet();
          render();
          toast(isEdit ? 'Cliente atualizada' : 'Cliente cadastrada');
        });
      });

      $('#c-del')?.addEventListener('click', async e => {
        const ok = await confirmDialog('O histórico de agendamentos será mantido na agenda.', { title: `Excluir ${c.name}?`, ok: 'Excluir', danger: true });
        if (!ok) return;
        await withBusy(e.currentTarget, async () => {
          await API.deleteClient(c.id);
          db.clients = db.clients.filter(x => x.id !== c.id);
          db.appointments.forEach(a => { if (a.clientId === c.id) a.clientId = null; });
          closeSheet();
          render();
          toast('Cliente excluída');
        });
      });
    },
  });
}

function historyRow(a, showYear) {
  const date = showYear ? fmtDateShort(a.date) : fmtDateShort(a.date).slice(0, 5);
  const kept = retainedDeposit(a);
  const pay = a.status === 'concluido' && a.payment ? ` · ${PAYMENTS[a.payment]}` : kept ? ' · sinal retido' : '';
  return `<button type="button" data-action="edit-appt" data-id="${a.id}">
    <div class="h-main"><strong>${date} · ${a.start}</strong><span>${esc(a.services.map(s => s.name).join(' + '))}${pay}</span></div>
    <div class="h-side">${money(kept || a.price)}<span class="badge st-${a.status}">${STATUS[a.status]?.label || ''}</span></div>
  </button>`;
}

/* ============================================================
   Formulário de agendamento
   ============================================================ */
function openApptForm(appt, preset = {}) {
  const isEdit = !!appt;
  const presetClient = preset.clientId ? db.clients.find(c => c.id === preset.clientId) : null;
  const a = appt ? JSON.parse(JSON.stringify(appt)) : {
    id: null,
    clientId: presetClient?.id || null,
    clientName: presetClient?.name || '',
    phone: presetClient?.phone || '',
    services: [],
    date: preset.date || ui.date,
    start: preset.start || '',
    duration: 0,
    price: 0,
    status: 'agendado',
    payment: '',
    notes: '',
  };

  // Adicionais: itens não previstos lançados só neste agendamento (ex.: unha quebrada, reaplicação).
  // Ficam junto dos serviços no banco, marcados com extra: true.
  const extras = a.services.filter(x => x.extra).map(x => ({ name: x.name, price: x.price, duration: x.duration || 0 }));
  const booked = a.services.filter(x => !x.extra);
  const extraNames = [...new Set(db.appointments.flatMap(x => x.services).filter(x => x.extra).map(x => x.name))].sort();

  // Serviços atuais + serviços já excluídos que constam neste agendamento
  const options = db.services.map(s => ({ ...s }));
  booked.forEach(s => {
    if (!options.some(o => o.id === s.serviceId)) {
      options.push({ id: s.serviceId, name: s.name, price: s.price, duration: s.duration, color: s.color });
    }
  });
  const selected = new Set([...booked.map(s => s.serviceId), ...(preset.serviceIds || [])]);

  const servicesHtml = options.length
    ? `<div class="chips">${options.map(o => `
        <label class="chip-opt">
          <input type="checkbox" name="svc" value="${o.id}" ${selected.has(o.id) ? 'checked' : ''}>
          <span class="chip-card">
            <b><i style="background:${esc(o.color)}"></i>${esc(o.name)}</b>
            <small>${fmtDuration(o.duration)} · ${money(o.price)}</small>
          </span>
        </label>`).join('')}</div>`
    : `<p class="muted small">Nenhum serviço cadastrado. <a href="#servicos" data-action="close-sheet" style="color:var(--accent);font-weight:600">Cadastrar serviços</a></p>`;

  const statusHtml = isEdit ? `
    <div class="field">
      <span class="label">Status</span>
      <div class="segmented seg-status">${Object.entries(STATUS).map(([k, v]) => `
        <label><input type="radio" name="status" value="${k}" ${a.status === k ? 'checked' : ''}><span>${v.label}</span></label>`).join('')}
      </div>
    </div>` : '';

  const depositNote = !isEdit || !a.depositAmount ? ''
    : pendingDeposit(a)
      ? `<div class="notice">${icon('pix')}<p><b>Aguardando sinal de ${money(a.depositAmount)}</b>${a.depositDueAt ? ` · prazo até ${fmtDateTime(a.depositDueAt)}` : ''}. Sem a confirmação, o horário é cancelado automaticamente.<br>
          <button type="button" class="btn btn-primary btn-sm" style="margin-top:8px" data-action="confirm-deposit" data-id="${a.id}">${icon('check')} Confirmar sinal recebido</button></p></div>`
      : a.depositPaidAt
        ? (FREES_SLOT.includes(a.status)
          ? `<div class="notice-soft">${icon('pix')}<span>Sinal de <b>${money(a.depositAmount)}</b> recebido em ${fmtDateTime(a.depositPaidAt)} e <b>retido</b>: conta como faturado nas Finanças.<br>
              <button type="button" class="link-btn" style="margin-top:6px" data-action="refund-deposit" data-id="${a.id}">Marquei que devolvi o sinal</button></span></div>`
          : `<p class="notice-soft">${icon('pix')}<span>Sinal de <b>${money(a.depositAmount)}</b> recebido em ${fmtDateTime(a.depositPaidAt)}. Restante a receber: <b>${money(Math.max(a.price - a.depositAmount, 0))}</b>.</span></p>`)
        : '';
  const origin = isEdit && a.source === 'online'
    ? `<p class="notice-soft">${icon('globe')} Agendado pela cliente pelo link${a.createdAt ? ` em ${fmtDateShort(a.createdAt.slice(0, 10))}` : ''}. Você pode alterar qualquer informação.</p>`
    : '';

  openSheet({
    title: isEdit ? 'Editar agendamento' : 'Novo agendamento',
    body: `<form id="appt-form" class="form" autocomplete="off" novalidate>
      ${origin}
      ${depositNote}
      <div class="field">
        <label for="f-client">Cliente</label>
        <input id="f-client" list="dl-clients" maxlength="80" placeholder="Nome da cliente">
        <datalist id="dl-clients">${db.clients.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist>
        <p class="hint warn" id="f-noshow" hidden></p>
      </div>
      <div class="field">
        <label for="f-phone">WhatsApp / telefone</label>
        <input id="f-phone" type="tel" inputmode="tel" placeholder="(00) 00000-0000">
      </div>
      <div class="field">
        <span class="label">Serviços</span>
        ${servicesHtml}
      </div>
      <div class="field">
        <span class="label">Adicionais <span class="muted">(serviços não previstos)</span></span>
        <div id="f-extras" class="extras"></div>
        <datalist id="dl-extras">${extraNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
        <button type="button" class="link-btn" id="f-add-extra">${icon('plus')} Adicionar item</button>
      </div>
      <div class="row">
        <div class="field"><label for="f-date">Data</label><input id="f-date" type="date"></div>
        <div class="field"><label for="f-slot">Horário</label><select id="f-slot"></select></div>
      </div>
      <p class="hint" id="f-hint"></p>
      <div class="field" id="f-manual-wrap" hidden>
        <label for="f-manual">Horário do encaixe</label>
        <input id="f-manual" type="time" step="300">
      </div>
      <div class="row">
        <div class="field"><span class="label">Duração</span><div class="readout" id="f-duration">—</div></div>
        <div class="field"><label for="f-price">Valor (R$)</label><input id="f-price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0,00"></div>
      </div>
      <p class="hint" id="f-sum" hidden></p>
      ${statusHtml}
      ${isEdit && a.manageToken && clientCanManage() ? `<button type="button" class="link-btn" data-action="copy-manage" data-id="${a.id}">${icon('link')} Copiar link da cliente para remarcar ou cancelar</button>` : ''}
      <div class="field">
        <label for="f-pay">Forma de pagamento</label>
        <select id="f-pay">
          <option value="">Não informado</option>
          ${Object.entries(PAYMENTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="f-notes">Observações</label>
        <textarea id="f-notes" rows="2" placeholder="Ex.: cor do esmalte, preferências…"></textarea>
      </div>
    </form>`,
    footer: isEdit
      ? `<button type="button" class="btn btn-danger-ghost btn-icon" id="f-del" aria-label="Excluir agendamento">${icon('trash')}</button>
         ${a.phone ? `<a class="btn btn-ghost btn-wa" id="f-wa" target="_blank" rel="noopener">${icon('chat')}Confirmar</a>` : ''}
         <span class="spacer"></span>
         <button type="submit" form="appt-form" class="btn btn-primary">Salvar</button>`
      : `<span class="spacer"></span>
         <button type="button" class="btn btn-ghost" data-action="close-sheet">Cancelar</button>
         <button type="submit" form="appt-form" class="btn btn-primary">Agendar</button>`,
    onMount() {
      const f = $('#appt-form');
      const slotSel = $('#f-slot');
      const priceIn = $('#f-price');
      const manual = $('#f-manual');

      $('#f-client').value = a.clientName;
      // Mostra quantas faltas a cliente já tem (ajuda a decidir se pede sinal)
      const showNoShows = () => {
        const c = findClientByName($('#f-client').value);
        const n = c ? clientSummary(c).noShows : 0;
        $('#f-noshow').hidden = !n;
        $('#f-noshow').textContent = n ? `Atenção: esta cliente tem ${n} falta${n === 1 ? '' : 's'} registrada${n === 1 ? '' : 's'}.` : '';
      };
      showNoShows();
      $('#f-client').addEventListener('input', showNoShows);
      $('#f-phone').value = a.phone || '';
      $('#f-date').value = a.date;
      $('#f-pay').value = a.payment || '';
      $('#f-notes').value = a.notes || '';
      priceIn.value = isEdit ? Number(a.price).toFixed(2) : '';
      bindPhoneMask($('#f-phone'));

      const chosen = () => $$('input[name=svc]:checked', f).map(i => options.find(o => o.id === i.value)).filter(Boolean);
      // Adicionais preenchidos (linhas totalmente vazias são ignoradas)
      const filledExtras = () => extras.filter(x => String(x.name).trim() || Number(x.price) || Number(x.duration));
      const totals = () => {
        const list = chosen(), ex = filledExtras();
        return { duration: sum(list, o => o.duration) + sum(ex, x => x.duration), price: sum(list, o => o.price) + sum(ex, x => x.price) };
      };
      let priceTouched = isEdit && Math.abs(Number(a.price) - totals().price) > 0.009;

      function refresh() {
        const { duration, price } = totals();
        $('#f-duration').textContent = duration ? fmtDuration(duration) : '—';
        if (!priceTouched) priceIn.value = price ? price.toFixed(2) : '';
        // Quando o valor foi alterado à mão (desconto, por exemplo), mostra a soma dos itens para conferência
        const differs = priceTouched && Math.abs(Number(priceIn.value) - price) > 0.009;
        $('#f-sum').hidden = !differs;
        $('#f-sum').textContent = differs ? `Soma dos itens: ${money(price)}. O valor acima foi ajustado manualmente.` : '';

        const date = $('#f-date').value;
        const prev = slotSel.value || a.start;
        const need = Math.max(duration, db.settings.slotInterval);
        const times = date ? availableSlots(date, need, a.id).map(fromMin) : [];
        if (isEdit && date === appt.date && appt.start && !times.includes(appt.start)) {
          times.push(appt.start);
          times.sort();
        }
        slotSel.innerHTML =
          (times.length ? '' : '<option value="">Sem horários livres</option>') +
          times.map(t => `<option value="${t}">${t}</option>`).join('') +
          '<option value="manual">Outro horário (encaixe)…</option>';

        const hint = $('#f-hint');
        hint.classList.remove('warn');
        if (prev === 'manual') slotSel.value = 'manual';
        else if (prev && times.includes(prev)) slotSel.value = prev;
        else if (prev && times.length) {
          hint.classList.add('warn');
          hint.textContent = `O horário ${prev} não está livre para essa duração. Escolha outro ou use um encaixe.`;
        }
        if (!hint.classList.contains('warn')) {
          if (!date) hint.textContent = '';
          else if (fullDayBlock(date)) hint.textContent = 'Este dia está bloqueado. Use "Outro horário" para encaixar mesmo assim.';
          else if (!isWorkDay(date)) hint.textContent = 'Este dia está marcado como fechado. Use "Outro horário" para encaixar.';
          else if (!duration) hint.textContent = 'Selecione os serviços para ver os horários livres.';
          else hint.textContent = `${times.length} ${times.length === 1 ? 'horário livre' : 'horários livres'} para ${fmtDuration(duration)}.`;
        }
        $('#f-manual-wrap').hidden = slotSel.value !== 'manual';
      }

      const extrasBox = $('#f-extras');
      function renderExtras() {
        const head = extras.length ? '<div class="extra-row extra-head"><span>Descrição</span><span>Valor (R$)</span><span>Min.</span><span></span></div>' : '';
        extrasBox.innerHTML = head + extras.map((x, i) => `
          <div class="extra-row" data-i="${i}">
            <input class="x-name" list="dl-extras" maxlength="60" placeholder="Ex.: unha quebrada" value="${esc(x.name)}" aria-label="Descrição do adicional">
            <input class="x-price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="R$" value="${x.price === '' ? '' : x.price}" aria-label="Valor">
            <input class="x-min" type="number" inputmode="numeric" min="0" max="600" step="5" placeholder="min" value="${x.duration || ''}" aria-label="Minutos a mais">
            <button type="button" class="icon-btn x-del" aria-label="Remover adicional">${icon('x')}</button>
          </div>`).join('');
      }
      renderExtras();
      extrasBox.addEventListener('input', e => {
        const row = e.target.closest('.extra-row');
        if (!row) return;
        const x = extras[Number(row.dataset.i)];
        x.name = $('.x-name', row).value;
        x.price = Number($('.x-price', row).value) || 0;
        x.duration = Math.max(0, Math.round(Number($('.x-min', row).value)) || 0);
        refresh();
      });
      extrasBox.addEventListener('click', e => {
        const del = e.target.closest('.x-del');
        if (!del) return;
        extras.splice(Number(del.closest('.extra-row').dataset.i), 1);
        renderExtras();
        refresh();
      });
      $('#f-add-extra').addEventListener('click', () => {
        extras.push({ name: '', price: '', duration: 0 });
        renderExtras();
        $('.extra-row:last-child .x-name', extrasBox).focus();
      });

      refresh();

      f.addEventListener('change', e => {
        if (e.target.name === 'svc' || e.target.id === 'f-date') refresh();
        if (e.target.id === 'f-slot') {
          $('#f-hint').classList.remove('warn');
          $('#f-manual-wrap').hidden = slotSel.value !== 'manual';
          if (slotSel.value === 'manual') manual.focus();
        }
        if (e.target.id === 'f-client') {
          const match = findClientByName(e.target.value);
          if (match?.phone && !$('#f-phone').value) $('#f-phone').value = match.phone;
        }
      });
      priceIn.addEventListener('input', () => { priceTouched = priceIn.value !== ''; });

      const waBtn = $('#f-wa');
      if (waBtn) {
        const names = a.services.map(s => s.name).join(' + ');
        waBtn.href = waLink(a.phone, `Olá, ${firstName(a.clientName)}! Passando para confirmar seu horário no ${db.settings.businessName}: ${fmtDateLong(a.date)}, às ${a.start} (${names}). Posso confirmar?${manageLine(a)}`);
      }

      f.addEventListener('submit', async e => {
        e.preventDefault();
        const name = $('#f-client').value.trim();
        const phone = $('#f-phone').value.trim();
        const list = chosen();
        const date = $('#f-date').value;
        const start = slotSel.value === 'manual' ? manual.value : slotSel.value;
        if (!name) return toast('Informe o nome da cliente.');
        const extraItems = filledExtras();
        if (extraItems.some(x => !String(x.name).trim())) return toast('Descreva cada adicional (ex.: unha quebrada).');
        if (!list.length && !extraItems.length) return toast('Selecione pelo menos um serviço.');
        if (!date) return toast('Escolha a data.');
        if (!start) return toast('Escolha um horário.');

        const duration = totals().duration;
        if (!duration) return toast('Informe a duração: escolha um serviço ou preencha os minutos do adicional.');
        const conflict = findConflict(date, toMin(start), duration, a.id);
        if (conflict) {
          const ok = await confirmDialog(
            `Esse horário coincide com ${conflict.clientName} (${conflict.start} – ${fromMin(toMin(conflict.start) + conflict.duration)}${bufferMin() ? `, mais ${bufferMin()} min de intervalo` : ''}).`,
            { title: 'Horário ocupado', ok: 'Agendar mesmo assim' });
          if (!ok) return;
        }
        const block = findBlock(date, toMin(start), duration);
        if (block) {
          const ok = await confirmDialog(
            `Esse horário está bloqueado (${blockLabel(block)}${block.reason ? ` · ${block.reason}` : ''}).`,
            { title: 'Horário bloqueado', ok: 'Agendar mesmo assim' });
          if (!ok) return;
        }

        const status = $('input[name=status]:checked', f)?.value || a.status || 'agendado';
        let saved;
        const ok = await withBusy($('.sheet-foot [type=submit]'), async () => {
          let client = findClientByName(name);
          if (!client) {
            client = await API.saveClient({ name, phone, notes: '' });
            putLocal('clients', client);
          } else if (phone && phone !== client.phone) {
            client = await API.saveClient({ ...client, phone });
            putLocal('clients', client);
          }
          saved = await API.saveAppointment({
            ...a,
            clientId: client.id,
            clientName: client.name,
            phone,
            services: [
              ...list.map(o => ({ serviceId: o.id, name: o.name, price: Number(o.price), duration: Number(o.duration), color: o.color })),
              ...extraItems.map(x => ({ serviceId: null, name: String(x.name).trim(), price: Number(x.price) || 0, duration: Number(x.duration) || 0, color: '#8a8580', extra: true })),
            ],
            date,
            start,
            duration,
            price: Number(priceIn.value) || 0,
            status,
            payment: $('#f-pay').value,
            notes: $('#f-notes').value.trim(),
            reminderSentAt: isEdit && date === appt.date && start === appt.start ? a.reminderSentAt : null,
          });
          putLocal('appointments', saved);
        });
        if (!ok) return;

        closeSheet();
        ui.date = date;
        render();
        toast(isEdit ? 'Agendamento atualizado' : `Agendado para ${fmtDateShort(date).slice(0, 5)} às ${start}`);
        if (isEdit) {
          await offerChangeNotice(appt, saved);
          if (appt.status !== 'concluido' && saved.status === 'concluido') offerReturn(saved);
        }
      });

      $('#f-del')?.addEventListener('click', async e => {
        const ok = await confirmDialog('Se a cliente apenas desmarcou, você pode mudar o status para "Cancelado" e manter o histórico.', { title: 'Excluir agendamento?', ok: 'Excluir', danger: true });
        if (!ok) return;
        await withBusy(e.currentTarget, async () => {
          await API.deleteAppointment(a.id);
          db.appointments = db.appointments.filter(x => x.id !== a.id);
          closeSheet();
          render();
          toast('Agendamento excluído');
        });
      });
    },
  });
}

/** Depois de remarcar ou cancelar, oferece avisar a cliente pelo WhatsApp. */
async function offerChangeNotice(before, after) {
  if (!after.phone) return;
  const biz = db.settings.businessName;
  const nome = firstName(after.clientName);
  let title, text;
  if (after.status === 'faltou' && before.status !== 'faltou') {
    title = 'Falar com a cliente?';
    text = `Olá, ${nome}! Sentimos sua falta hoje no ${biz} (horário das ${after.start}). Aconteceu alguma coisa? Se quiser, podemos remarcar.`;
  } else if (after.status === 'cancelado' && before.status !== 'cancelado') {
    title = 'Avisar sobre o cancelamento?';
    text = `Olá, ${nome}! Seu horário no ${biz} de ${fmtDateLong(before.date)}, às ${before.start}, foi cancelado. Quer remarcar para outro dia?`;
  } else if (isActive(after) && (before.date !== after.date || before.start !== after.start)) {
    title = 'Avisar a cliente sobre a mudança?';
    text = `Olá, ${nome}! Precisei ajustar seu horário no ${biz}. O novo horário é ${fmtDateLong(after.date)}, às ${after.start}. Pode ser?${manageLine(after)}`;
  } else {
    return;
  }
  const ok = await confirmDialog(`Vamos abrir o WhatsApp com uma mensagem pronta para ${after.clientName}.`, { title, ok: 'Abrir WhatsApp' });
  if (ok) window.open(waLink(after.phone, text), '_blank', 'noopener');
}

/* ============================================================
   Retornos: clientes na época da manutenção, sem horário marcado
   ============================================================ */
function returnsBanner() {
  const list = dueReturns().filter(r => !remindedRecently(r.client));
  if (!list.length) return '';
  return `<button class="reminder-banner is-return" data-action="open-returns">
    ${icon('repeat')}
    <div><b>${list.length} cliente${list.length === 1 ? '' : 's'} na época do retorno</b><span>Sem horário marcado · chame pelo WhatsApp</span></div>
    <span class="block-edit">Ver</span>
  </button>`;
}

function returnMessage(r) {
  const until = r.rule.min === r.rule.max ? `por volta de ${fmtDateLong(r.target)}` : `até ${fmtDateLong(r.closes)}`;
  return `Olá, ${firstName(r.client.name)}! Já faz ${r.days} dias do seu último atendimento (${r.last.services.map(x => x.name).join(' + ')}). ` +
    `O retorno indicado (${r.rule.service.name}) é ${until}. Quer garantir seu horário? É só agendar por aqui: ${publicUrl()}`;
}

function openReturns() {
  const rowHtml = r => {
    const c = r.client;
    const state = r.days > r.rule.max ? `<b class="late">passou ${r.days - r.rule.max} dia${r.days - r.rule.max === 1 ? '' : 's'} do prazo</b>`
      : r.days < r.rule.min ? `janela abre em ${r.rule.min - r.days} dia${r.rule.min - r.days === 1 ? '' : 's'}` : 'dentro da janela';
    return `<div class="rem-row" data-row="${c.id}">
      <div class="h-main"><strong>${esc(c.name)}</strong>
        <span>${esc(r.rule.service.name)} · há ${r.days} dias · ${state}${remindedRecently(c) ? ' · <b class="sent">Avisada ✓</b>' : ''}</span></div>
      <div class="rem-actions">
        ${c.phone ? `<a class="btn btn-sm ${remindedRecently(c) ? 'btn-ghost' : 'btn-primary'}" data-ret="${c.id}" href="${waLink(c.phone, returnMessage(r))}" target="_blank" rel="noopener">${icon('chat')}</a>` : ''}
        <button type="button" class="btn btn-sm btn-ghost" data-action="book-return" data-id="${c.id}">Agendar</button>
      </div>
    </div>`;
  };
  const list = dueReturns();
  openSheet({
    title: 'Clientes na época do retorno',
    body: `<div class="stack">
      <p class="notice-soft">${icon('repeat')}<span>Clientes que fizeram um serviço com retorno e ainda não têm horário marcado. O botão do WhatsApp abre a mensagem pronta, com o link de agendamento.</span></p>
      <div class="rem-list" id="ret-list">${list.length ? list.map(rowHtml).join('') : '<p class="muted small" style="margin:8px 0 0">Nenhuma cliente na época do retorno.</p>'}</div>
    </div>`,
    footer: '<span class="spacer"></span><button type="button" class="btn btn-primary" data-action="close-sheet">Concluir</button>',
    onMount() {
      // O link abre o WhatsApp normalmente; em paralelo, registra que a cliente foi avisada
      $('#ret-list').addEventListener('click', async e => {
        const btn = e.target.closest('[data-ret]');
        if (!btn) return;
        const c = db.clients.find(x => x.id === btn.dataset.ret);
        try {
          putLocal('clients', await API.saveClient({ ...c, returnRemindedAt: new Date().toISOString() }));
          const r = clientReturn(db.clients.find(x => x.id === c.id));
          if (r) $(`[data-row="${c.id}"]`).outerHTML = rowHtml(r);
          render();
        } catch (err) {
          console.error(err);
        }
      });
    },
  });
}

/* ============================================================
   Sinal por Pix: a dona confere o comprovante e confirma
   ============================================================ */
function depositBanner() {
  const list = pendingDeposits();
  if (!list.length) return '';
  return `<button class="reminder-banner is-deposit" data-action="open-deposits">
    ${icon('pix')}
    <div><b>${list.length} sinal${list.length === 1 ? '' : 'is'} aguardando confirmação</b><span>${money(sum(list, a => a.depositAmount))} · confira os comprovantes</span></div>
    <span class="block-edit">Ver</span>
  </button>`;
}

function openDeposits() {
  const list = pendingDeposits();
  openSheet({
    title: 'Sinais aguardando confirmação',
    body: `<div class="stack">
      <p class="notice-soft">${icon('pix')}<span>Confira o Pix no seu banco e toque em <b>Confirmar</b>. Sem a confirmação até o prazo, o horário é cancelado e liberado automaticamente.</span></p>
      <div class="rem-list">${list.length ? list.map(a => `
        <div class="rem-row">
          <div class="h-main"><strong>${esc(a.clientName)} · ${money(a.depositAmount)}</strong>
            <span>${fmtDateShort(a.date).slice(0, 5)} às ${a.start}${a.depositDueAt ? ` · prazo até ${fmtDateTime(a.depositDueAt)}` : ''}</span></div>
          <button type="button" class="btn btn-sm btn-primary" data-action="confirm-deposit" data-id="${a.id}">${icon('check')} Confirmar</button>
        </div>`).join('') : '<p class="muted small" style="margin:8px 0 0">Nenhum sinal pendente.</p>'}
      </div>
    </div>`,
    footer: '<span class="spacer"></span><button type="button" class="btn btn-ghost" data-action="close-sheet">Fechar</button>',
  });
}

async function confirmDeposit(id, btn) {
  const a = db.appointments.find(x => x.id === id);
  if (!a) return;
  let saved;
  const ok = await withBusy(btn, async () => {
    saved = await API.saveAppointment({ ...a, status: 'confirmado', depositPaidAt: new Date().toISOString() });
    putLocal('appointments', saved);
  });
  if (!ok) return;
  closeSheet();
  render();
  toast('Sinal confirmado. Horário garantido.');
  if (!saved.phone) return;
  const send = await confirmDialog(`Vamos abrir o WhatsApp com uma mensagem pronta para ${saved.clientName}.`, { title: 'Avisar que o horário está confirmado?', ok: 'Abrir WhatsApp' });
  if (send) {
    window.open(waLink(saved.phone, `Olá, ${firstName(saved.clientName)}! Recebi seu sinal de ${money(saved.depositAmount)}. Seu horário no ${db.settings.businessName} está confirmado: ${fmtDateLong(saved.date)}, às ${saved.start}. Até lá!${manageLine(saved)}`), '_blank', 'noopener');
  }
}

/* ============================================================
   Lembretes (enviados pelo WhatsApp da dona, com mensagem pronta)
   ============================================================ */
const reminderTargets = k => dayAppointments(k).filter(a => isActive(a) && a.phone);

// Próximo dia (a partir de amanhã) que tem clientes para lembrar
function nextReminderDate() {
  for (let i = 1; i <= 7; i++) {
    const k = dateKey(addDays(new Date(), i));
    if (reminderTargets(k).length) return k;
  }
  return dateKey(addDays(new Date(), 1));
}

function whenLabel(k) {
  return k === dateKey(addDays(new Date(), 1)) ? 'amanhã' : `${DOW_LONG[parseKey(k).getDay()].split('-')[0]}, ${fmtDateShort(k).slice(0, 5)}`;
}

function reminderBanner() {
  const k = nextReminderDate();
  const list = reminderTargets(k);
  const pending = list.filter(a => !a.reminderSentAt).length;
  if (!pending) return '';
  return `<button class="reminder-banner" data-action="open-reminders">
    ${icon('bell')}
    <div><b>${pending} lembrete${pending === 1 ? '' : 's'} para enviar</b><span>Clientes de ${whenLabel(k)}</span></div>
    <span class="block-edit">Enviar</span>
  </button>`;
}

function reminderText(a) {
  const tomorrow = a.date === dateKey(addDays(new Date(), 1));
  const when = tomorrow ? `amanhã (${fmtDateLong(a.date)})` : fmtDateLong(a.date);
  const names = a.services.map(x => x.name).join(' + ');
  // Sem emojis: alguns aparelhos mostram "?" no lugar deles em mensagens abertas por link
  return `Olá, ${firstName(a.clientName)}! Passando para lembrar do seu horário no ${db.settings.businessName}: ` +
    `${when}, às ${a.start} (${names}).

Te espero!${manageLine(a)}`;
}

function openReminders() {
  let target = nextReminderDate();

  const rowHtml = a => `<div class="rem-row" data-row="${a.id}">
    <div class="h-main"><strong>${a.start} · ${esc(a.clientName)}</strong>
      <span>${esc(a.services.map(x => x.name).join(' + '))}${a.reminderSentAt ? ' · <b class="sent">Enviado ✓</b>' : ''}</span></div>
    <a class="btn btn-sm ${a.reminderSentAt ? 'btn-ghost' : 'btn-primary'}" data-rem="${a.id}"
       href="${waLink(a.phone, reminderText(a))}" target="_blank" rel="noopener">${icon('chat')} ${a.reminderSentAt ? 'Reenviar' : 'Enviar'}</a>
  </div>`;

  const listHtml = () => {
    const list = reminderTargets(target);
    return list.length ? list.map(rowHtml).join('')
      : '<p class="muted small" style="margin:8px 0 0">Nenhuma cliente com WhatsApp neste dia.</p>';
  };

  openSheet({
    title: 'Lembretes',
    body: `<div class="stack">
      <p class="notice-soft">${icon('bell')}<span>Toque em <b>Enviar</b>: o WhatsApp abre com a mensagem pronta${clientCanManage() ? ', já com o link para a cliente remarcar ou cancelar' : ''}. É só apertar enviar.</span></p>
      <div class="field"><label for="rem-date">Clientes do dia</label><input id="rem-date" type="date" value="${target}"></div>
      <div class="rem-list" id="rem-list">${listHtml()}</div>
    </div>`,
    footer: '<span class="spacer"></span><button type="button" class="btn btn-primary" data-action="close-sheet">Concluir</button>',
    onMount() {
      $('#rem-date').addEventListener('change', e => {
        if (!e.target.value) return;
        target = e.target.value;
        $('#rem-list').innerHTML = listHtml();
      });
      // O link abre o WhatsApp normalmente; em paralelo, marca como enviado
      $('#rem-list').addEventListener('click', async e => {
        const btn = e.target.closest('[data-rem]');
        if (!btn) return;
        try {
          const saved = await API.markReminderSent(btn.dataset.rem);
          putLocal('appointments', saved);
          $(`[data-row="${saved.id}"]`).outerHTML = rowHtml(saved);
          render();
        } catch (err) {
          console.error(err);
        }
      });
    },
  });
}

/* ============================================================
   Formulário de bloqueio
   ============================================================ */
function openBlockForm(block, preset = {}) {
  const isEdit = !!block;
  const b = block ? { ...block } : {
    startDate: preset.date || ui.date, endDate: preset.date || ui.date, startTime: '', endTime: '', reason: '', weekdays: null,
  };
  const recurring = isRecurring(b);

  openSheet({
    title: isEdit ? (recurring ? 'Editar bloqueio recorrente' : 'Editar bloqueio') : 'Bloquear agenda',
    body: `<form id="blk-form" class="form" autocomplete="off" novalidate>
      <p class="notice-soft">${icon('lock')}<span>As clientes não conseguem agendar no período bloqueado. O motivo fica visível só para você.${recurring ? ' <b>As alterações valem para todos os dias da repetição.</b>' : ''}</span></p>
      <div class="field">
        <span class="label">O que bloquear</span>
        <div class="segmented seg-2">
          <label><input type="radio" name="kind" value="day"><span>Dia inteiro</span></label>
          <label><input type="radio" name="kind" value="period"><span>Período do dia</span></label>
        </div>
      </div>
      <div class="row" id="b-times">
        <div class="field"><label for="b-start">Das</label><input id="b-start" type="time" step="300"></div>
        <div class="field"><label for="b-end">Às</label><input id="b-end" type="time" step="300"></div>
      </div>
      <div class="field">
        <span class="label">Repetir</span>
        <div class="segmented seg-2">
          <label><input type="radio" name="repeat" value="no"><span>Não repete</span></label>
          <label><input type="radio" name="repeat" value="weekly"><span>Toda semana</span></label>
        </div>
      </div>
      <div class="field" id="b-days-wrap">
        <div class="label-row"><span class="label">Nos dias</span><button type="button" class="link-btn" id="b-workdays">Dias de atendimento</button></div>
        <div class="daypills">${WEEK_ORDER.map(d => `
          <label><input type="checkbox" name="wd" value="${d}"><span>${DOW_SHORT[d]}</span></label>`).join('')}
        </div>
      </div>
      <div class="row">
        <div class="field"><label for="b-from" id="b-from-label">De</label><input id="b-from" type="date"></div>
        <div class="field"><label for="b-to">Até</label><input id="b-to" type="date"></div>
      </div>
      <label class="check-row" id="b-noend-wrap"><input type="checkbox" id="b-noend"> Sem data final</label>
      <p class="hint" id="b-hint"></p>
      <div class="field">
        <label for="b-reason">Motivo <span class="muted">(opcional)</span></label>
        <input id="b-reason" maxlength="80" placeholder="Ex.: almoço, folga, feriado, consulta médica">
      </div>
      <div id="b-conflicts"></div>
    </form>`,
    footer: `${isEdit ? `<button type="button" class="btn btn-danger-ghost btn-icon" id="b-del" aria-label="Remover bloqueio">${icon('trash')}</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn btn-ghost" data-action="close-sheet">Cancelar</button>
      <button type="submit" form="blk-form" class="btn btn-primary">${isEdit ? 'Salvar' : 'Bloquear'}</button>`,
    onMount() {
      const f = $('#blk-form');
      const from = $('#b-from'), to = $('#b-to'), start = $('#b-start'), end = $('#b-end'), noEnd = $('#b-noend');
      from.value = b.startDate;
      to.value = b.endDate >= NO_END ? '' : b.endDate;
      noEnd.checked = recurring && b.endDate >= NO_END;
      start.value = b.startTime || '12:00';
      end.value = b.endTime || '13:00';
      $('#b-reason').value = b.reason || '';
      $(`input[name=kind][value=${b.startTime ? 'period' : 'day'}]`, f).checked = true;
      $(`input[name=repeat][value=${recurring ? 'weekly' : 'no'}]`, f).checked = true;
      const initialDays = recurring ? b.weekdays : db.settings.workDays;
      $$('input[name=wd]', f).forEach(i => { i.checked = initialDays.includes(Number(i.value)); });

      const kind = () => $('input[name=kind]:checked', f).value;
      const weekly = () => $('input[name=repeat]:checked', f).value === 'weekly';
      const days = () => $$('input[name=wd]:checked', f).map(i => Number(i.value));
      const endValue = () => (weekly() && noEnd.checked ? NO_END : to.value);

      $('#b-workdays').addEventListener('click', () => {
        $$('input[name=wd]', f).forEach(i => { i.checked = db.settings.workDays.includes(Number(i.value)); });
        refresh();
      });

      // Ajusta os campos ao tipo de bloqueio e mostra agendamentos que já existem no período
      function refresh() {
        const isWeekly = weekly();
        $('#b-times').hidden = kind() !== 'period';
        $('#b-days-wrap').hidden = !isWeekly;
        $('#b-noend-wrap').hidden = !isWeekly;
        $('#b-from-label').textContent = isWeekly ? 'A partir de' : 'De';
        to.disabled = isWeekly && noEnd.checked;
        if (!to.disabled && from.value && (!to.value || to.value < from.value)) to.value = from.value;
        $('#b-hint').textContent = isWeekly
          ? 'Ex.: almoço de segunda a sábado, das 12:00 às 13:00, sem data final.'
          : 'Para um único dia, deixe as duas datas iguais. Para férias, escolha o período todo.';

        const period = kind() === 'period' && start.value && end.value ? [toMin(start.value), toMin(end.value)] : [0, 1440];
        const last = endValue();
        const hits = db.appointments
          .filter(a => isActive(a) && a.date >= from.value && a.date <= last && a.date >= todayKey())
          .filter(a => !isWeekly || days().includes(parseKey(a.date).getDay()))
          .filter(a => toMin(a.start) < period[1] && toMin(a.start) + a.duration > period[0])
          .sort((x, y) => (x.date + x.start).localeCompare(y.date + y.start));
        $('#b-conflicts').innerHTML = hits.length ? `<div class="notice">${icon('alert')}<p>
          <b>${hits.length} agendamento${hits.length === 1 ? '' : 's'} neste período</b> continua${hits.length === 1 ? '' : 'm'} marcado${hits.length === 1 ? '' : 's'}.
          Se precisar, remarque ou cancele pela agenda:<br>
          ${hits.slice(0, 5).map(a => `${fmtDateShort(a.date).slice(0, 5)} às ${a.start} · ${esc(a.clientName)}`).join('<br>')}
          ${hits.length > 5 ? `<br>e mais ${hits.length - 5}…` : ''}</p></div>` : '';
      }
      refresh();
      f.addEventListener('change', refresh);

      f.addEventListener('submit', async e => {
        e.preventDefault();
        const isPeriod = kind() === 'period';
        const isWeekly = weekly();
        const last = endValue();
        if (!from.value || !last) return toast(isWeekly ? 'Escolha a data final ou marque "Sem data final".' : 'Escolha as datas.');
        if (last < from.value) return toast('A data final deve ser depois da inicial.');
        if (isPeriod && (!start.value || !end.value || start.value >= end.value)) return toast('O horário final deve ser depois do inicial.');
        if (isWeekly && !days().length) return toast('Escolha pelo menos um dia da semana.');
        const record = {
          ...b,
          startDate: from.value,
          endDate: last,
          startTime: isPeriod ? start.value : '',
          endTime: isPeriod ? end.value : '',
          weekdays: isWeekly ? days() : null,
          reason: $('#b-reason').value.trim(),
        };
        await withBusy($('.sheet-foot [type=submit]'), async () => {
          putLocal('blocks', await API.saveBlock(record));
          closeSheet();
          render();
          toast(isEdit ? 'Bloqueio atualizado' : 'Agenda bloqueada');
        });
      });

      $('#b-del')?.addEventListener('click', async e => {
        const ok = await confirmDialog(recurring ? 'Todos os dias desta repetição voltam a ficar disponíveis para agendamentos.' : 'O período volta a ficar disponível para agendamentos.', { title: 'Remover bloqueio?', ok: 'Remover', danger: true });
        if (!ok) return;
        await withBusy(e.currentTarget, async () => {
          await API.deleteBlock(b.id);
          db.blocks = db.blocks.filter(x => x.id !== b.id);
          closeSheet();
          render();
          toast('Bloqueio removido');
        });
      });
    },
  });
}

/* ============================================================
   Tela: Finanças
   ============================================================ */
const PERIODS = { dia: 'Dia', semana: 'Semana', mes: 'Mês' };

function periodRange(period, anchorKey) {
  const d = parseKey(anchorKey);
  if (period === 'dia') return { start: d, end: d };
  if (period === 'semana') {
    const start = addDays(d, -d.getDay());
    return { start, end: addDays(start, 6) };
  }
  return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: new Date(d.getFullYear(), d.getMonth() + 1, 0) };
}

function periodLabel(period, { start, end }) {
  if (period === 'dia') return fmtDateLong(dateKey(start));
  if (period === 'mes') return `${MONTHS[start.getMonth()]} de ${start.getFullYear()}`;
  if (start.getMonth() === end.getMonth()) return `${start.getDate()} a ${end.getDate()} de ${MONTHS[end.getMonth()]}`;
  return `${start.getDate()} de ${MONTHS[start.getMonth()].slice(0, 3)} a ${end.getDate()} de ${MONTHS[end.getMonth()].slice(0, 3)}`;
}

function shiftPeriod(dir) {
  const d = parseKey(ui.finAnchor);
  if (ui.finPeriod === 'dia') ui.finAnchor = dateKey(addDays(d, dir));
  else if (ui.finPeriod === 'semana') ui.finAnchor = dateKey(addDays(d, 7 * dir));
  else ui.finAnchor = dateKey(new Date(d.getFullYear(), d.getMonth() + dir, 1));
  render();
}

// Arredonda o topo do eixo para um valor "redondo" (10, 20, 25, 50, 100…)
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function renderFinance() {
  const period = ui.finPeriod;
  const range = periodRange(period, ui.finAnchor);
  const from = dateKey(range.start), to = dateKey(range.end);
  const tk = todayKey();

  const inRange = db.appointments
    .filter(a => a.date >= from && a.date <= to)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const active = inRange.filter(isActive);
  const done = active.filter(a => a.status === 'concluido');
  const pending = active.filter(a => a.status !== 'concluido');
  const cancelled = inRange.filter(a => a.status === 'cancelado');
  const noShows = inRange.filter(a => a.status === 'faltou');
  const lost = [...cancelled, ...noShows];
  const overdue = pending.filter(a => a.date < tk || (a.date === tk && toMin(a.start) + a.duration <= nowMinutes()));
  const retained = sum(lost, retainedDeposit);          // sinais de quem faltou ou cancelou
  const advance = sum(pending, advanceDeposit);          // sinais já pagos de atendimentos futuros
  const billed = sum(done, a => a.price) + retained;
  const isCurrent = tk >= from && tk <= to;

  const tabs = Object.entries(PERIODS)
    .map(([k, label]) => `<button class="${k === period ? 'on' : ''}" data-action="fin-period" data-period="${k}">${label}</button>`)
    .join('');

  return `<div class="view">
    <header class="page-head">
      <div><p class="eyebrow">Visível só para você</p><h1>Finanças</h1></div>
    </header>

    <section class="card pad period-card">
      <div class="tabs" role="tablist">${tabs}</div>
      <div class="period-nav">
        <button class="icon-btn" data-action="fin-prev" aria-label="Período anterior">${icon('chevLeft')}</button>
        <strong class="period-label">${esc(periodLabel(period, range))}</strong>
        <button class="icon-btn" data-action="fin-next" aria-label="Próximo período">${icon('chevRight')}</button>
      </div>
      ${isCurrent ? '' : `<button class="btn btn-ghost btn-sm period-now" data-action="fin-today">Voltar para ${period === 'dia' ? 'hoje' : period === 'semana' ? 'esta semana' : 'este mês'}</button>`}
    </section>

    <section class="stats stats-4">
      <div class="stat"><span>Faturado</span><strong>${moneyShort(billed)}</strong><small>${done.length} concluído${done.length === 1 ? '' : 's'}${retained ? ` + ${moneyShort(retained)} de sinal retido` : ''}</small></div>
      <div class="stat"><span>A receber</span><strong>${moneyShort(sum(pending, a => a.price) - advance)}</strong><small>${pending.length} pendente${pending.length === 1 ? '' : 's'}${advance ? ` · ${moneyShort(advance)} já em sinais` : ''}</small></div>
      <div class="stat"><span>Ticket médio</span><strong>${done.length ? moneyShort(sum(done, a => a.price) / done.length) : '—'}</strong><small>por atendimento</small></div>
      <div class="stat"><span>Faltas · cancelados</span><strong>${noShows.length} · ${cancelled.length}</strong><small>${lost.length ? `${moneyShort(sum(lost, a => a.price) - retained)} perdidos` : 'nenhum'}</small></div>
    </section>

    ${overdue.length ? `<div class="notice">${icon('alert')}<p><b>${overdue.length} atendimento${overdue.length === 1 ? '' : 's'} já passou e não foi marcado como concluído.</b> Eles aparecem em "A receber" até você mudar o status na agenda.</p></div>` : ''}

    ${period === 'dia' ? '' : `<section class="card pad">
      <h2>Faturamento por dia</h2>
      ${financeChart(range, active, lost)}
    </section>`}

    <section class="card pad">
      <h2>Recebido por forma de pagamento</h2>
      ${paymentBreakdown(done, lost)}
    </section>

    <section class="card pad">
      <h2>Por serviço</h2>
      ${serviceBreakdown(active)}
    </section>

    <section class="card pad">
      <h2>Atendimentos <span class="muted">(${inRange.length})</span></h2>
      ${inRange.length ? `<div class="history">${inRange.map(a => historyRow(a, false)).join('')}</div>`
      : '<p class="muted small" style="margin:0">Nenhum atendimento neste período.</p>'}
    </section>
  </div>`;
}

function financeChart(range, appts, lost = []) {
  const tk = todayKey();
  const days = [];
  for (let d = new Date(range.start); d <= range.end; d = addDays(d, 1)) days.push(dateKey(d));
  const isWeek = days.length <= 7;

  const data = days.map(k => {
    const list = appts.filter(a => a.date === k);
    return {
      k,
      // Concluídos + sinais retidos do dia; pendentes já descontam o sinal pago
      done: sum(list.filter(a => a.status === 'concluido'), a => a.price) + sum(lost.filter(a => a.date === k), retainedDeposit),
      pending: sum(list.filter(a => a.status !== 'concluido'), a => a.price - advanceDeposit(a)),
    };
  });
  const max = Math.max(...data.map(x => x.done + x.pending));
  if (!max) return '<p class="muted small" style="margin:0">Nenhum valor neste período.</p>';
  const top = niceMax(max);

  const cols = data.map(x => {
    const d = parseKey(x.k);
    const total = x.done + x.pending;
    const tip = `<b>${DOW_SHORT[d.getDay()]}, ${fmtDateShort(x.k).slice(0, 5)}</b><br>` +
      `Concluído: ${money(x.done)}<br>A receber: ${money(x.pending)}`;
    const segs = [
      x.pending ? `<span class="seg seg-pending" style="flex-grow:${x.pending}"></span>` : '',
      x.done ? `<span class="seg seg-done" style="flex-grow:${x.done}"></span>` : '',
    ].join('');
    return `<button class="bar-col" data-action="fin-day" data-date="${x.k}" data-tip="${esc(tip)}" aria-label="${esc(fmtDateLong(x.k))}: ${esc(money(total))}">
      ${total ? `<span class="bar" style="height:${(total / top) * 100}%">${segs}</span>` : ''}
    </button>`;
  }).join('');

  const labels = data.map(x => {
    const d = parseKey(x.k);
    const show = isWeek || d.getDate() === 1 || d.getDate() % 5 === 0;
    const text = isWeek ? `${DOW_SHORT[d.getDay()]}<br>${d.getDate()}` : (show ? d.getDate() : '');
    return `<span class="${x.k === tk ? 'today' : ''}">${text}</span>`;
  }).join('');

  const grid = [0, 0.5, 1].map(f => `<div style="bottom:${f * 100}%"><span>${moneyShort(top * f)}</span></div>`).join('');

  return `<div class="chart">
    <div class="chart-legend">
      <span><i class="seg-done"></i>Concluído</span>
      <span><i class="seg-pending"></i>A receber</span>
    </div>
    <div class="chart-plot">
      <div class="chart-grid">${grid}</div>
      <div class="chart-cols">${cols}</div>
      <div class="chart-tip" role="tooltip"></div>
    </div>
    <div class="chart-x">${labels}</div>
    <p class="muted small chart-hint">Toque em uma barra para ver os detalhes do dia.</p>
  </div>`;
}

function meterRows(list, note) {
  if (!list.length) return '';
  const max = Math.max(...list.map(r => r.value)) || 1;
  return `<div class="svc-rows">${list.map(r => `
    <div>
      <div class="svc-row-head">
        <span>${r.color ? `<i style="background:${esc(r.color)}"></i>` : ''}<b>${esc(r.name)}</b><small>${r.count}x${r.extra ? ' · adicional' : ''}</small></span>
        <strong>${money(r.value)}</strong>
      </div>
      <div class="meter"><i style="width:${(r.value / max) * 100}%"></i></div>
    </div>`).join('')}
  </div>
  ${note ? `<p class="muted small" style="margin:14px 0 0">${note}</p>` : ''}`;
}

function paymentBreakdown(done, lost = []) {
  const kept = lost.filter(a => retainedDeposit(a) > 0);
  if (!done.length && !kept.length) return '<p class="muted small" style="margin:0">Nenhum atendimento concluído neste período.</p>';
  const rows = {};
  if (kept.length) rows.sinal = { name: 'Sinais retidos (Pix)', count: kept.length, value: sum(kept, retainedDeposit) };
  done.forEach(a => {
    const key = a.payment || 'nao';
    const r = rows[key] || (rows[key] = { name: PAYMENTS[key] || 'Não informado', count: 0, value: 0 });
    r.count++;
    r.value += a.price;
  });
  const missing = rows.nao?.count || 0;
  return meterRows(
    Object.values(rows).sort((x, y) => y.value - x.value),
    missing ? `${missing} atendimento${missing === 1 ? '' : 's'} sem forma de pagamento informada.`
      : kept.length ? 'Considera atendimentos concluídos e sinais retidos de faltas ou cancelamentos.' : 'Considera apenas atendimentos concluídos.',
  );
}

function serviceBreakdown(appts) {
  const rows = {};
  appts.forEach(a => {
    const base = sum(a.services, s => s.price);
    a.services.forEach(s => {
      // Rateia o valor cobrado (que pode ter desconto) proporcionalmente ao preço de cada serviço
      const share = base ? s.price / base : 1 / a.services.length;
      const r = rows[s.name] || (rows[s.name] = { name: s.name, color: s.color, count: 0, value: 0, extra: Boolean(s.extra) });
      r.count++;
      r.value += a.price * share;
    });
  });
  const list = Object.values(rows).sort((x, y) => y.value - x.value);
  if (!list.length) return '<p class="muted small" style="margin:0">Nenhum serviço neste período.</p>';
  return meterRows(list, 'Inclui atendimentos concluídos e a receber.');
}

function showChartTip(col) {
  const plot = col.closest('.chart-plot');
  const tip = plot && $('.chart-tip', plot);
  if (!tip) return;
  tip.innerHTML = col.dataset.tip;
  tip.classList.add('show');
  const bar = $('.bar', col);
  const half = tip.offsetWidth / 2;
  const x = col.offsetLeft + col.offsetWidth / 2;
  tip.style.left = `${Math.min(Math.max(x, half - 40), plot.clientWidth - half)}px`;
  tip.style.top = `${plot.clientHeight - (bar ? bar.offsetHeight : 0)}px`;
}

/* ============================================================
   Tela: Ajustes
   ============================================================ */
function renderSettings() {
  const s = db.settings;
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  const url = publicUrl();

  return `<div class="view">
    <header class="page-head">
      <div><p class="eyebrow">${esc(s.businessName)}</p><h1>Ajustes</h1></div>
    </header>

    <section class="card pad">
      <h2>Link de agendamento</h2>
      <p class="muted small" style="margin:-6px 0 12px">Envie este link para suas clientes. Elas só conseguem ver os serviços e os horários livres, e agendar.</p>
      <div class="link-box">${icon('link')}<input id="public-url" readonly value="${esc(url)}"></div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn btn-primary" data-action="copy-link">${icon('copy')} Copiar link</button>
        <a class="btn btn-ghost btn-wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Agende seu horário no ${s.businessName}: ${url}`)}">${icon('chat')} Enviar no WhatsApp</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${esc(url)}">Abrir</a>
      </div>
    </section>

    <section class="card pad">
      <h2>Estabelecimento</h2>
      <div class="form">
        <div class="field">
          <label for="set-name">Nome do estúdio</label>
          <input id="set-name" data-setting="businessName" maxlength="40" value="${esc(s.businessName)}">
        </div>
        <div class="field">
          <label for="set-wa">WhatsApp do estúdio</label>
          <input id="set-wa" data-setting="whatsapp" type="tel" inputmode="tel" placeholder="(00) 00000-0000" value="${esc(s.whatsapp)}">
          <small class="muted small">Aparece para a cliente depois que ela agenda, para tirar dúvidas.</small>
        </div>
      </div>
    </section>

    <section class="card pad">
      <h2>Horário de atendimento</h2>
      <div class="form">
        <div class="row">
          <div class="field"><label for="set-open">Abre às</label><input id="set-open" type="time" data-setting="openTime" value="${s.openTime}"></div>
          <div class="field"><label for="set-close">Fecha às</label><input id="set-close" type="time" data-setting="closeTime" value="${s.closeTime}"></div>
        </div>
        <div class="field">
          <span class="label">Dias de atendimento</span>
          <div class="daypills">${dayOrder.map(d => `
            <label><input type="checkbox" data-setting="workDays" value="${d}" ${s.workDays.includes(d) ? 'checked' : ''}><span>${DOW_SHORT[d]}</span></label>`).join('')}
          </div>
        </div>
        <div class="field">
          <label for="set-step">Intervalo entre horários (minutos)</label>
          <input id="set-step" type="number" inputmode="numeric" min="5" max="${MAX_INTERVAL}" step="5" data-setting="slotInterval" value="${s.slotInterval}">
          <div class="quick" style="margin-top:4px">${[15, 30, 45, 60, 90, 120].map(m => `
            <button type="button" class="${s.slotInterval === m ? 'on' : ''}" data-action="set-interval" data-min="${m}">${fmtDuration(m)}</button>`).join('')}
          </div>
          <small class="muted small">Os horários oferecidos começam a cada ${fmtDuration(s.slotInterval)} a partir da abertura (${s.openTime}, ${fromMin(toMin(s.openTime) + s.slotInterval)}, ${fromMin(toMin(s.openTime) + 2 * s.slotInterval)}…).</small>
        </div>
        <div class="field">
          <label for="set-buffer">Intervalo entre atendimentos (minutos)</label>
          <input id="set-buffer" type="number" inputmode="numeric" min="0" max="120" step="5" data-setting="bufferMinutes" value="${s.bufferMinutes || 0}">
          <div class="quick" style="margin-top:4px">${[0, 5, 10, 15, 20, 30].map(m => `
            <button type="button" class="${(s.bufferMinutes || 0) === m ? 'on' : ''}" data-action="set-buffer" data-min="${m}">${m ? `${m} min` : 'Sem intervalo'}</button>`).join('')}
          </div>
          <small class="muted small">Tempo reservado depois de cada cliente para limpeza e esterilização. ${s.bufferMinutes ? `Ex.: atendimento das 10:00 às 11:00 → próximo horário a partir das ${fromMin(660 + Number(s.bufferMinutes))}.` : 'Sem intervalo, o próximo horário começa logo que o anterior termina.'}</small>
        </div>
        <div class="field">
          <label for="set-maxdays">A cliente pode agendar com até</label>
          <select id="set-maxdays" data-setting="maxDaysAhead">${[30, 45, 60, 90, 120].map(v =>
            `<option value="${v}" ${s.maxDaysAhead === v ? 'selected' : ''}>${v} dias de antecedência</option>`).join('')}
          </select>
          <small class="muted small">Até onde o calendário do link fica aberto. Útil para serviços marcados com bastante antecedência, como alongamento.</small>
        </div>
        <div class="field">
          <label for="set-lead">Antecedência mínima para a cliente agendar</label>
          <select id="set-lead" data-setting="minLeadMinutes">${LEAD_OPTIONS.map(([v, label]) =>
            `<option value="${v}" ${s.minLeadMinutes === v ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <small class="muted small">Dentro desse prazo, a cliente não agenda sozinha: a página mostra um aviso de <b>encaixe</b> com um botão para falar com você pelo WhatsApp. Pelo painel, você continua podendo marcar a qualquer momento.${s.minLeadMinutes && !s.whatsapp ? ' <b style="color:var(--danger)">Preencha o WhatsApp do estúdio (acima) para o botão de encaixe aparecer.</b>' : ''}</small>
        </div>
      </div>
    </section>

    <section class="card pad">
      <h2>Sinal por Pix</h2>
      <p class="muted small" style="margin:-6px 0 12px">Ao agendar pelo link, a cliente paga um sinal por Pix. Você confere o comprovante e confirma no painel. Sem a confirmação até o prazo, o horário é cancelado e liberado automaticamente.</p>
      <p class="status-line ${depositActive() ? 'is-on' : ''}">${depositActive()
        ? `${icon('check')} Ativo: sinal de ${s.depositPercent}% com prazo de ${s.depositHours}h`
        : `${icon('alert')} Inativo: ${s.depositPercent > 0 ? 'informe a chave Pix para começar a pedir o sinal' : 'o percentual está em "Não pedir sinal"'}`}</p>
      <div class="form">
        <div class="row">
          <div class="field">
            <label for="set-dep">Valor do sinal</label>
            <select id="set-dep" data-setting="depositPercent">${[0, 20, 30, 40, 50, 100].map(v =>
              `<option value="${v}" ${s.depositPercent === v ? 'selected' : ''}>${v ? `${v}% do total` : 'Não pedir sinal'}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="set-dep-hours">Prazo para pagar</label>
            <select id="set-dep-hours" data-setting="depositHours">${[2, 6, 12, 24, 48].map(v =>
              `<option value="${v}" ${s.depositHours === v ? 'selected' : ''}>${v} horas</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label for="set-pix-type">Tipo de chave Pix</label>
            <select id="set-pix-type" data-setting="pixType">${Object.entries(PIX_TYPES).map(([k, label]) =>
              `<option value="${k}" ${pixKeyType(s.pixKey) === k ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="set-pix-key">Chave Pix</label>
            <input id="set-pix-key" data-setting="pixKey" maxlength="80" value="${esc(pixKeyDisplay(s.pixKey))}" placeholder="Sua chave">
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label for="set-pix-name">Nome do recebedor</label>
            <input id="set-pix-name" data-setting="pixName" maxlength="25" value="${esc(s.pixName)}" placeholder="Como aparece no banco">
          </div>
          <div class="field">
            <label for="set-pix-city">Cidade</label>
            <input id="set-pix-city" data-setting="pixCity" maxlength="15" value="${esc(s.pixCity)}" placeholder="Ex.: Sao Paulo">
          </div>
        </div>
        ${s.pixKey ? `<div>
          <button type="button" class="btn btn-ghost btn-sm" data-action="copy-pix-test">${icon('copy')} Copiar código de teste (R$ 1,00)</button>
          <small class="muted small" style="display:block;margin-top:6px">Cole no app do seu banco (Pix copia e cola) e confira se aparecem o seu nome e R$ 1,00. Não precisa concluir o pagamento.</small>
        </div>` : ''}
      </div>
    </section>

    <section class="card pad">
      <h2>Remarcação e cancelamento pela cliente</h2>
      <div class="form">
        <div class="field">
          <label for="set-notice">A cliente pode remarcar ou cancelar pelo link</label>
          <select id="set-notice" data-setting="changeNoticeHours">${NOTICE_OPTIONS.map(([v, label]) =>
            `<option value="${v}" ${s.changeNoticeHours === v ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
          <small class="muted small">Cada agendamento tem um link pessoal, enviado na confirmação e nos lembretes. Depois do prazo, a cliente precisa falar com você pelo WhatsApp.</small>
        </div>
      </div>
    </section>

    <section class="card pad">
      <div class="card-head">
        <h2>Bloqueios de agenda</h2>
        <button class="btn btn-ghost btn-sm" data-action="new-block">${icon('plus')} Novo</button>
      </div>
      <p class="muted small" style="margin:-6px 0 12px">Folgas, feriados, férias ou compromissos. As clientes não conseguem agendar nesses períodos.</p>
      ${upcomingBlocksHtml()}
    </section>

    <section class="card pad">
      <h2>Minha agenda no celular</h2>
      <p class="muted small" style="margin:-6px 0 12px">Veja seus atendimentos no calendário do seu celular, junto com seus compromissos pessoais. Aparecem o serviço, o horário e o primeiro nome da cliente.</p>
      ${calendarCardHtml()}
    </section>

    <section class="card pad">
      <h2>Cor do aplicativo</h2>
      <div class="swatches">${ACCENTS.map(c => `
        <label><input type="radio" name="accent" data-setting="accent" value="${c}" ${s.accent === c ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}
      </div>
    </section>

    <section class="card pad">
      <h2>Conta</h2>
      <p class="muted small" style="margin:-6px 0 14px">Conectada como <b>${esc(ui.email || '')}</b>. Os dados ficam salvos na nuvem (Supabase).</p>
      <div class="btn-row">
        <button class="btn btn-ghost" data-action="change-password">${icon('lock')} Alterar senha</button>
        <button class="btn btn-ghost" data-action="export">${icon('download')} Exportar backup</button>
        <button class="btn btn-danger-ghost" data-action="logout">${icon('logout')} Sair</button>
      </div>
    </section>
  </div>`;
}

const LEAD_OPTIONS = [
  [0, 'Sem antecedência mínima'], [30, '30 minutos antes'], [60, '1 hora antes'], [120, '2 horas antes'],
  [180, '3 horas antes'], [360, '6 horas antes'], [720, '12 horas antes'], [1440, '24 horas antes'], [2880, '48 horas antes'],
];

function calendarCardHtml() {
  if (!db.calendarToken) return '<p class="muted small" style="margin:0">Indisponível no momento. Atualize o banco de dados para ativar.</p>';
  const webcal = API.calendarFeedUrl(db.calendarToken).replace(/^https?:/, 'webcal:');
  return `<div class="btn-row">
      <a class="btn btn-primary" target="_blank" rel="noopener" href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}">${icon('calendar')} Adicionar ao Google Agenda</a>
      <a class="btn btn-ghost" href="${esc(webcal)}">${icon('calendar')} Adicionar no iPhone</a>
      <button type="button" class="btn btn-ghost" data-action="copy-calendar">${icon('copy')} Copiar link</button>
    </div>
    <p class="muted small" style="margin:12px 0 0">A agenda se atualiza sozinha, mas quem decide o momento é o aplicativo de calendário: no <b>iPhone</b>, em minutos ou poucas horas; no <b>Google Agenda</b>, pode levar de 12 a 24 horas. Este link é secreto: quem tiver ele consegue ver a sua agenda.
      <button type="button" class="link-btn" style="display:inline" data-action="reset-calendar">Gerar um novo link</button></p>`;
}

const NOTICE_OPTIONS = [
  [-1, 'Não permitir (somente pelo WhatsApp)'],
  [0, 'Até o horário do atendimento'],
  [1, 'Até 1 hora antes'], [2, 'Até 2 horas antes'], [3, 'Até 3 horas antes'], [6, 'Até 6 horas antes'],
  [12, 'Até 12 horas antes'], [24, 'Até 24 horas antes'], [48, 'Até 48 horas antes'],
];

function upcomingBlocksHtml() {
  const list = db.blocks
    .filter(b => b.endDate >= todayKey())
    .sort((x, y) => (x.startDate + (x.startTime || '')).localeCompare(y.startDate + (y.startTime || '')));
  if (!list.length) return '<p class="muted small" style="margin:0">Nenhum bloqueio programado.</p>';
  return `<div class="history">${list.map(b => `
    <button type="button" data-action="edit-block" data-id="${b.id}">
      <div class="h-main"><strong>${blockLabel(b)}</strong><span>${esc(b.reason || 'Sem motivo informado')}</span></div>
      <div class="h-side">${icon('chevRight')}</div>
    </button>`).join('')}</div>`;
}

async function onSettingChange(el) {
  const key = el.dataset.setting;
  const before = { ...db.settings, workDays: [...db.settings.workDays] };
  const s = db.settings;
  if (key === 'workDays') {
    s.workDays = $$('[data-setting=workDays]:checked').map(i => Number(i.value)).sort();
  } else if (key === 'minLeadMinutes' || key === 'depositPercent' || key === 'depositHours' || key === 'maxDaysAhead') {
    s[key] = Number(el.value);
  } else if (key === 'pixKey' || key === 'pixType') {
    s.pixKey = normalizePixKey($('#set-pix-type').value, $('#set-pix-key').value);
  } else if (key === 'pixName' || key === 'pixCity') {
    s[key] = el.value.trim();
  } else if (key === 'bufferMinutes') {
    const min = Math.round(Number(el.value) / 5) * 5;
    if (el.value === '' || min < 0 || min > 120) {
      el.value = s.bufferMinutes || 0;
      return toast('O intervalo deve ficar entre 0 e 120 minutos.');
    }
    s.bufferMinutes = min;
  } else if (key === 'changeNoticeHours') {
    s.changeNoticeHours = Number(el.value);
  } else if (key === 'slotInterval') {
    const min = Math.round(Number(el.value) / 5) * 5;
    if (!min || min < 5 || min > MAX_INTERVAL) {
      el.value = s.slotInterval;
      return toast(`O intervalo deve ficar entre 5 e ${MAX_INTERVAL} minutos.`);
    }
    s.slotInterval = min;
  } else if (key === 'businessName') {
    s.businessName = el.value.trim() || 'Meu Studio';
  } else if (key === 'whatsapp') {
    s.whatsapp = formatPhone(el.value);
  } else if (key === 'openTime' || key === 'closeTime') {
    if (!el.value) return;
    s[key] = el.value;
  } else if (key === 'accent') {
    s.accent = el.value;
    applyAccent(s.accent);
  }

  const ok = await withBusy(null, () => API.saveSettings(s));
  if (!ok) {
    db.settings = before;
    applyAccent(before.accent);
  }
  render();
  if (!ok) return;
  if (toMin(s.openTime) >= toMin(s.closeTime)) toast('Atenção: o horário de abertura precisa ser antes do fechamento.');
  else toast('Ajustes salvos');
}

function exportData() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `agenda-backup-${todayKey()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast('Backup exportado');
}

/* ============================================================
   Painel, diálogo
   ============================================================ */
function openSheet({ title, body, footer = '', onMount }) {
  const root = $('#sheet-root');
  root.innerHTML = `
    <div class="overlay" data-action="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grip"></div>
      <header class="sheet-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-action="close-sheet" aria-label="Fechar">${icon('x')}</button>
      </header>
      <div class="sheet-body">${body}</div>
      ${footer ? `<footer class="sheet-foot">${footer}</footer>` : ''}
    </div>`;
  root.classList.add('open');
  document.body.classList.add('no-scroll');
  onMount?.();
}

function closeSheet() {
  const root = $('#sheet-root');
  root.classList.remove('open');
  root.innerHTML = '';
  document.body.classList.remove('no-scroll');
}

function confirmDialog(message, { title = 'Tem certeza?', ok = 'Confirmar', danger = false } = {}) {
  return new Promise(resolve => {
    const root = $('#dialog-root');
    root.innerHTML = `
      <div class="overlay" data-r="0"></div>
      <div class="dialog" role="alertdialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <p>${esc(message)}</p>
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" data-r="0">Cancelar</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-r="1">${esc(ok)}</button>
        </div>
      </div>`;
    root.classList.add('open');
    $('[data-r="1"]', root).focus();
    root.onclick = e => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      root.classList.remove('open');
      root.innerHTML = '';
      root.onclick = null;
      resolve(b.dataset.r === '1');
    };
  });
}

/* ============================================================
   Eventos
   ============================================================ */
const ACTIONS = {
  'pick-day': el => { ui.date = el.dataset.date; render(); },
  'week-prev': () => { ui.date = dateKey(addDays(parseKey(ui.date), -7)); render(); },
  'week-next': () => { ui.date = dateKey(addDays(parseKey(ui.date), 7)); render(); },
  'go-today': () => { ui.date = todayKey(); render(); },
  'open-date': () => {
    const input = $('#date-jump');
    try { input.showPicker(); } catch { input.focus(); input.click(); }
  },
  'fin-period': el => { ui.finPeriod = el.dataset.period; render(); },
  'fin-prev': () => shiftPeriod(-1),
  'fin-next': () => shiftPeriod(1),
  'fin-today': () => { ui.finAnchor = todayKey(); render(); },
  'fin-day': el => { ui.finPeriod = 'dia'; ui.finAnchor = el.dataset.date; render(); window.scrollTo(0, 0); },
  'new-appt': el => openApptForm(null, { date: el.dataset.date || ui.date, start: el.dataset.start || '', clientId: el.dataset.client }),
  'edit-appt': el => { const a = db.appointments.find(x => x.id === el.dataset.id); if (a) openApptForm(a); },
  'new-block': el => openBlockForm(null, { date: el.dataset.date || (currentRoute() === 'agenda' ? ui.date : todayKey()) }),
  'edit-block': el => { const b = db.blocks.find(x => x.id === el.dataset.id); if (b) openBlockForm(b); },
  'new-service': () => openServiceForm(null),
  'edit-service': el => { const s = db.services.find(x => x.id === el.dataset.id); if (s) openServiceForm(s); },
  'new-client': () => openClientForm(null),
  'open-client': el => { const c = db.clients.find(x => x.id === el.dataset.id); if (c) openClientForm(c); },
  'close-sheet': el => { closeSheet(); if (el.getAttribute('href')) location.hash = el.getAttribute('href'); },
  'open-reminders': () => openReminders(),
  'open-deposits': () => openDeposits(),
  'open-returns': () => openReturns(),
  'book-return': el => {
    const c = db.clients.find(x => x.id === el.dataset.id);
    const r = c && clientReturn(c);
    if (r) openReturnForm(r);
  },
  'refund-deposit': async el => {
    const a = db.appointments.find(x => x.id === el.dataset.id);
    if (!a) return;
    const ok = await confirmDialog(`O sinal de ${money(a.depositAmount)} deixa de contar como faturado. Use isso depois de devolver o valor para a cliente.`, { title: 'Marcar o sinal como devolvido?', ok: 'Marcar como devolvido' });
    if (!ok) return;
    await withBusy(el, async () => {
      putLocal('appointments', await API.saveAppointment({ ...a, depositPaidAt: null }));
      closeSheet();
      render();
      toast('Sinal marcado como devolvido');
    });
  },
  'confirm-deposit': el => confirmDeposit(el.dataset.id, el),
  'copy-pix-test': () => {
    const st = db.settings;
    copyText(pixPayload({ key: st.pixKey, name: st.pixName || st.businessName, city: st.pixCity, amount: 1 }),
      'Código de teste copiado. Cole no app do seu banco.');
  },
  'copy-calendar': () => copyText(API.calendarFeedUrl(db.calendarToken), 'Link do calendário copiado'),
  'reset-calendar': async () => {
    const ok = await confirmDialog('O link atual para de funcionar. Você precisará adicionar o novo link no seu calendário de novo.', { title: 'Gerar um novo link?', ok: 'Gerar novo link', danger: true });
    if (!ok) return;
    await withBusy(null, async () => {
      db.calendarToken = await API.resetCalendarToken();
      render();
      toast('Novo link gerado');
    });
  },
  'copy-manage': async el => {
    const a = db.appointments.find(x => x.id === el.dataset.id);
    if (!a) return;
    try {
      await navigator.clipboard.writeText(manageUrl(a));
      toast('Link da cliente copiado');
    } catch {
      window.prompt('Copie o link:', manageUrl(a));
    }
  },
  'set-buffer': el => {
    const input = $('#set-buffer');
    input.value = el.dataset.min;
    onSettingChange(input);
  },
  'set-interval': el => {
    const input = $('#set-step');
    input.value = el.dataset.min;
    onSettingChange(input);
  },
  'copy-link': async () => {
    try {
      await navigator.clipboard.writeText(publicUrl());
      toast('Link copiado');
    } catch {
      $('#public-url').select();
      toast('Selecione e copie o link');
    }
  },
  'export': exportData,
  // Mostra ou esconde a senha digitada (ajuda a achar erros de digitação)
  'toggle-pass': el => {
    const input = $(`#${el.dataset.target}`);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.innerHTML = icon(show ? 'eyeOff' : 'eye');
    el.setAttribute('aria-label', show ? 'Esconder senha' : 'Mostrar senha');
    el.setAttribute('aria-pressed', String(show));
    input.focus();
  },
  'forgot-password': el => showForgotPassword(el.dataset.email || $('#l-email')?.value.trim() || ''),
  'back-to-login': el => showLogin('', el.dataset.email || ''),
  'change-password': () => openSheet({
    title: 'Alterar senha',
    body: passwordFormHtml('cp'),
    onMount() {
      bindPasswordForm('cp', () => {
        closeSheet();
        toast('Senha alterada com sucesso');
      });
    },
  }),
  'logout': async () => {
    const ok = await confirmDialog('Você precisará entrar com e-mail e senha novamente.', { title: 'Sair da conta?', ok: 'Sair' });
    if (!ok) return;
    await API.signOut();
    location.reload();
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  fn(el, e);
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'date-jump') { if (el.value) { ui.date = el.value; render(); } return; }
  if (el.dataset.setting) onSettingChange(el);
});

document.addEventListener('input', e => {
  if (e.target.id === 'client-search') {
    ui.clientQuery = e.target.value;
    $('#client-list').innerHTML = clientListHtml();
  }
});

document.addEventListener('mouseover', e => {
  const col = e.target.closest?.('.bar-col');
  if (col) showChartTip(col);
  else $$('.chart-tip.show').forEach(t => t.classList.remove('show'));
});
document.addEventListener('focusin', e => {
  if (e.target.classList?.contains('bar-col')) showChartTip(e.target);
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($('#dialog-root').classList.contains('open')) $('#dialog-root [data-r="0"]').click();
  else if ($('#sheet-root').classList.contains('open')) closeSheet();
});

window.addEventListener('hashchange', () => { closeSheet(); render(); window.scrollTo(0, 0); });

/* ============================================================
   Início
   ============================================================ */
(async function boot() {
  if (!API.configured) return showSetupNeeded();
  try {
    const session = await API.session();
    // Chegou pelo link do e-mail de recuperação: limpa o endereço e pede a nova senha
    if (API.recoveryLink || API.linkError) history.replaceState(null, '', location.pathname);
    if (API.linkError) return showLogin('O link de recuperação expirou ou já foi usado. Peça um novo em "Esqueci minha senha".');
    if (API.recoveryLink && session) return showNewPassword(session);
    if (session) await enter(session);
    else showLogin();
  } catch (err) {
    showLogin(err.message);
  }
})();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
