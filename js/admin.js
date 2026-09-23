'use strict';

/* ============================================================
   Painel da dona — estado
   ============================================================ */
let db = null; // { settings, services, clients, appointments }
const ui = { date: todayKey(), clientQuery: '', finPeriod: 'semana', finAnchor: todayKey() };

const isActive = a => a.status !== 'cancelado';
const isWorkDay = k => db.settings.workDays.includes(parseKey(k).getDay());
const availableSlots = (date, duration, excludeId) => computeSlots(db.settings, db.appointments, date, duration, excludeId);
const findClientByName = name => db.clients.find(x => x.name.trim().toLowerCase() === name.trim().toLowerCase());
const publicUrl = () => new URL('../', location.href).href;
const MAX_INTERVAL = 240; // mesmo limite do banco (settings.slot_interval)

function dayAppointments(k) {
  return db.appointments
    .filter(a => a.date === k)
    .sort((a, b) => toMin(a.start) - toMin(b.start));
}

function findConflict(date, start, duration, excludeId) {
  return db.appointments.find(a =>
    a.date === date && a.id !== excludeId && isActive(a) &&
    start < toMin(a.start) + a.duration && start + duration > toMin(a.start));
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

function showLogin(message = '') {
  showAuth(`
    <span class="brand-mark">${icon('lock')}</span>
    <h1>Área da administração</h1>
    <p class="muted">Entre com seu e-mail e senha para acessar a agenda.</p>
    <form id="login-form" class="form">
      <div class="field"><label for="l-email">E-mail</label><input id="l-email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="l-pass">Senha</label><input id="l-pass" type="password" autocomplete="current-password" required></div>
      ${message ? `<p class="hint warn" style="margin:0">${esc(message)}</p>` : ''}
      <button class="btn btn-primary btn-block" type="submit">Entrar</button>
    </form>
    <a class="auth-link" href="../">Ir para a página de agendamento das clientes</a>`);

  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#l-email').value.trim();
    const pass = $('#l-pass').value;
    await withBusy($('#login-form [type=submit]'), async () => {
      const session = await API.signIn(email, pass);
      await enter(session);
    });
  });
  $('#l-email').focus();
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
    const cls = ['day', k === ui.date && 'is-selected', k === tk && 'is-today', !isWorkDay(k) && 'is-off'].filter(Boolean).join(' ');
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

    <section class="stats">
      <div class="stat"><span>Atendimentos</span><strong>${active.length}</strong></div>
      <div class="stat"><span>Previsto</span><strong>${moneyShort(sum(active, a => a.price))}</strong></div>
      <div class="stat"><span>Ocupado</span><strong>${active.length ? fmtDuration(sum(active, a => a.duration)) : '—'}</strong></div>
    </section>

    <section>
      <div class="section-head"><h2>${esc(fmtDateLong(ui.date))}</h2></div>
      ${timelineHtml(ui.date, appts)}
    </section>
  </div>`;
}

function timelineHtml(k, appts) {
  const s = db.settings;
  const work = isWorkDay(k);
  const tk = todayKey();

  if (!appts.length) {
    return `<div class="empty">
      ${icon(work ? 'calendar' : 'moon')}
      <h3>${work ? 'Nenhum agendamento' : 'Dia de folga'}</h3>
      <p>${work ? `Atendimento das ${s.openTime} às ${s.closeTime}.` : 'Este dia está marcado como fechado nos ajustes.'}</p>
      <button class="btn btn-primary" data-action="new-appt" data-date="${k}">${icon('plus')} Agendar</button>
    </div>`;
  }

  // Cartões e intervalos livres, ordenados pelo horário de início
  const items = appts.map(a => ({ at: toMin(a.start), order: 1, html: apptCard(a) }));
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

  let cursor = toMin(s.openTime);
  for (const a of appts.filter(isActive)) {
    pushGap(cursor, toMin(a.start));
    cursor = Math.max(cursor, toMin(a.start) + a.duration);
  }
  pushGap(cursor, toMin(s.closeTime));

  items.sort((x, y) => x.at - y.at || x.order - y.order);
  return `<div class="timeline">${items.map(i => i.html).join('')}</div>`;
}

function apptCard(a) {
  const status = STATUS[a.status] ? a.status : 'agendado';
  const color = a.services[0]?.color || 'var(--accent)';
  const names = a.services.map(s => s.name).join(' + ');
  return `<button class="appt st-${status}" data-action="edit-appt" data-id="${a.id}">
    <div class="appt-time"><strong>${a.start}</strong><span>${fromMin(toMin(a.start) + a.duration)}</span></div>
    <span class="appt-bar" style="background:${esc(color)}"></span>
    <div class="appt-body">
      <div class="appt-title"><span>${esc(a.clientName)}</span>${a.source === 'online' ? `<span class="tag" title="Agendado pela cliente">${icon('globe')}online</span>` : ''}</div>
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
        const record = { ...s, name, price, duration, color: $('input[name=color]:checked', f).value, active: $('#s-active').checked };
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
function clientSummary(c) {
  const appts = db.appointments.filter(a => a.clientId === c.id && isActive(a));
  const past = appts.filter(a => a.date <= todayKey()).sort((a, b) => b.date.localeCompare(a.date));
  return { count: appts.length, last: past[0]?.date || null };
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
    const sub = [c.phone, count ? `${count} ${count === 1 ? 'atendimento' : 'atendimentos'}` : 'Sem atendimentos', last && `última vez ${fmtDateShort(last)}`].filter(Boolean).join(' · ');
    return `<button class="list-item" data-action="open-client" data-id="${c.id}">
      <span class="avatar">${esc(initials(c.name))}</span>
      <div class="li-body"><div class="li-title"><span>${esc(c.name)}</span></div><div class="li-sub">${esc(sub)}</div></div>
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
  const { count, last } = isEdit ? clientSummary(c) : { count: 0, last: null };

  const header = isEdit ? `
    <div class="quick-actions">
      <button type="button" class="btn btn-primary" data-action="new-appt" data-client="${c.id}">${icon('plus')} Agendar</button>
      ${c.phone
        ? `<a class="btn btn-ghost btn-wa" href="${waLink(c.phone, `Olá, ${firstName(c.name)}!`)}" target="_blank" rel="noopener">${icon('chat')} WhatsApp</a>`
        : `<button type="button" class="btn btn-ghost" disabled>${icon('chat')} Sem telefone</button>`}
    </div>
    <div class="mini-stats">
      <div><span>Atendimentos</span><strong>${count}</strong></div>
      <div><span>Total pago</span><strong>${money(sum(done, a => a.price))}</strong></div>
      <div><span>Última visita</span><strong>${last ? fmtDateShort(last).slice(0, 5) : '—'}</strong></div>
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
          const saved = await API.saveClient({ ...c, name, phone, notes: $('#c-notes').value.trim() });
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
  const pay = a.status === 'concluido' && a.payment ? ` · ${PAYMENTS[a.payment]}` : '';
  return `<button type="button" data-action="edit-appt" data-id="${a.id}">
    <div class="h-main"><strong>${date} · ${a.start}</strong><span>${esc(a.services.map(s => s.name).join(' + '))}${pay}</span></div>
    <div class="h-side">${money(a.price)}<span class="badge st-${a.status}">${STATUS[a.status]?.label || ''}</span></div>
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

  // Serviços atuais + serviços já excluídos que constam neste agendamento
  const options = db.services.map(s => ({ ...s }));
  a.services.forEach(s => {
    if (!options.some(o => o.id === s.serviceId)) {
      options.push({ id: s.serviceId, name: s.name, price: s.price, duration: s.duration, color: s.color });
    }
  });
  const selected = new Set(a.services.map(s => s.serviceId));

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
      <div class="segmented">${Object.entries(STATUS).map(([k, v]) => `
        <label><input type="radio" name="status" value="${k}" ${a.status === k ? 'checked' : ''}><span>${v.label}</span></label>`).join('')}
      </div>
    </div>` : '';

  const origin = isEdit && a.source === 'online'
    ? `<p class="notice-soft">${icon('globe')} Agendado pela cliente pelo link${a.createdAt ? ` em ${fmtDateShort(a.createdAt.slice(0, 10))}` : ''}. Você pode alterar qualquer informação.</p>`
    : '';

  openSheet({
    title: isEdit ? 'Editar agendamento' : 'Novo agendamento',
    body: `<form id="appt-form" class="form" autocomplete="off" novalidate>
      ${origin}
      <div class="field">
        <label for="f-client">Cliente</label>
        <input id="f-client" list="dl-clients" maxlength="80" placeholder="Nome da cliente">
        <datalist id="dl-clients">${db.clients.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist>
      </div>
      <div class="field">
        <label for="f-phone">WhatsApp / telefone</label>
        <input id="f-phone" type="tel" inputmode="tel" placeholder="(00) 00000-0000">
      </div>
      <div class="field">
        <span class="label">Serviços</span>
        ${servicesHtml}
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
      ${statusHtml}
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
      $('#f-phone').value = a.phone || '';
      $('#f-date').value = a.date;
      $('#f-pay').value = a.payment || '';
      $('#f-notes').value = a.notes || '';
      priceIn.value = isEdit ? Number(a.price).toFixed(2) : '';
      bindPhoneMask($('#f-phone'));

      const chosen = () => $$('input[name=svc]:checked', f).map(i => options.find(o => o.id === i.value)).filter(Boolean);
      const totals = () => { const list = chosen(); return { duration: sum(list, o => o.duration), price: sum(list, o => o.price) }; };
      let priceTouched = isEdit && Math.abs(Number(a.price) - totals().price) > 0.009;

      function refresh() {
        const { duration, price } = totals();
        $('#f-duration').textContent = duration ? fmtDuration(duration) : '—';
        if (!priceTouched) priceIn.value = price ? price.toFixed(2) : '';

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
          else if (!isWorkDay(date)) hint.textContent = 'Este dia está marcado como fechado. Use "Outro horário" para encaixar.';
          else if (!duration) hint.textContent = 'Selecione os serviços para ver os horários livres.';
          else hint.textContent = `${times.length} ${times.length === 1 ? 'horário livre' : 'horários livres'} para ${fmtDuration(duration)}.`;
        }
        $('#f-manual-wrap').hidden = slotSel.value !== 'manual';
      }

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
        waBtn.href = waLink(a.phone, `Olá, ${firstName(a.clientName)}! Passando para confirmar seu horário no ${db.settings.businessName}: ${fmtDateLong(a.date)}, às ${a.start} (${names}). Posso confirmar?`);
      }

      f.addEventListener('submit', async e => {
        e.preventDefault();
        const name = $('#f-client').value.trim();
        const phone = $('#f-phone').value.trim();
        const list = chosen();
        const date = $('#f-date').value;
        const start = slotSel.value === 'manual' ? manual.value : slotSel.value;
        if (!name) return toast('Informe o nome da cliente.');
        if (!list.length) return toast('Selecione pelo menos um serviço.');
        if (!date) return toast('Escolha a data.');
        if (!start) return toast('Escolha um horário.');

        const duration = sum(list, o => o.duration);
        const conflict = findConflict(date, toMin(start), duration, a.id);
        if (conflict) {
          const ok = await confirmDialog(
            `Esse horário coincide com ${conflict.clientName} (${conflict.start} – ${fromMin(toMin(conflict.start) + conflict.duration)}).`,
            { title: 'Horário ocupado', ok: 'Agendar mesmo assim' });
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
            services: list.map(o => ({ serviceId: o.id, name: o.name, price: Number(o.price), duration: Number(o.duration), color: o.color })),
            date,
            start,
            duration,
            price: Number(priceIn.value) || 0,
            status,
            payment: $('#f-pay').value,
            notes: $('#f-notes').value.trim(),
          });
          putLocal('appointments', saved);
        });
        if (!ok) return;

        closeSheet();
        ui.date = date;
        render();
        toast(isEdit ? 'Agendamento atualizado' : `Agendado para ${fmtDateShort(date).slice(0, 5)} às ${start}`);
        if (isEdit) offerChangeNotice(appt, saved);
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
  if (after.status === 'cancelado' && before.status !== 'cancelado') {
    title = 'Avisar sobre o cancelamento?';
    text = `Olá, ${nome}! Seu horário no ${biz} de ${fmtDateLong(before.date)}, às ${before.start}, foi cancelado. Quer remarcar para outro dia?`;
  } else if (isActive(after) && (before.date !== after.date || before.start !== after.start)) {
    title = 'Avisar a cliente sobre a mudança?';
    text = `Olá, ${nome}! Precisei ajustar seu horário no ${biz}. O novo horário é ${fmtDateLong(after.date)}, às ${after.start}. Pode ser?`;
  } else {
    return;
  }
  const ok = await confirmDialog(`Vamos abrir o WhatsApp com uma mensagem pronta para ${after.clientName}.`, { title, ok: 'Abrir WhatsApp' });
  if (ok) window.open(waLink(after.phone, text), '_blank', 'noopener');
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
  const cancelled = inRange.filter(a => !isActive(a));
  const overdue = pending.filter(a => a.date < tk || (a.date === tk && toMin(a.start) + a.duration <= nowMinutes()));
  const billed = sum(done, a => a.price);
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
      <div class="stat"><span>Faturado</span><strong>${moneyShort(billed)}</strong><small>${done.length} concluído${done.length === 1 ? '' : 's'}</small></div>
      <div class="stat"><span>A receber</span><strong>${moneyShort(sum(pending, a => a.price))}</strong><small>${pending.length} pendente${pending.length === 1 ? '' : 's'}</small></div>
      <div class="stat"><span>Ticket médio</span><strong>${done.length ? moneyShort(billed / done.length) : '—'}</strong><small>por atendimento</small></div>
      <div class="stat"><span>Cancelados</span><strong>${cancelled.length}</strong><small>${cancelled.length ? `${moneyShort(sum(cancelled, a => a.price))} perdidos` : 'nenhum'}</small></div>
    </section>

    ${overdue.length ? `<div class="notice">${icon('alert')}<p><b>${overdue.length} atendimento${overdue.length === 1 ? '' : 's'} já passou e não foi marcado como concluído.</b> Eles aparecem em "A receber" até você mudar o status na agenda.</p></div>` : ''}

    ${period === 'dia' ? '' : `<section class="card pad">
      <h2>Faturamento por dia</h2>
      ${financeChart(range, active)}
    </section>`}

    <section class="card pad">
      <h2>Recebido por forma de pagamento</h2>
      ${paymentBreakdown(done)}
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

function financeChart(range, appts) {
  const tk = todayKey();
  const days = [];
  for (let d = new Date(range.start); d <= range.end; d = addDays(d, 1)) days.push(dateKey(d));
  const isWeek = days.length <= 7;

  const data = days.map(k => {
    const list = appts.filter(a => a.date === k);
    return {
      k,
      done: sum(list.filter(a => a.status === 'concluido'), a => a.price),
      pending: sum(list.filter(a => a.status !== 'concluido'), a => a.price),
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
        <span>${r.color ? `<i style="background:${esc(r.color)}"></i>` : ''}<b>${esc(r.name)}</b><small>${r.count}x</small></span>
        <strong>${money(r.value)}</strong>
      </div>
      <div class="meter"><i style="width:${(r.value / max) * 100}%"></i></div>
    </div>`).join('')}
  </div>
  ${note ? `<p class="muted small" style="margin:14px 0 0">${note}</p>` : ''}`;
}

function paymentBreakdown(done) {
  if (!done.length) return '<p class="muted small" style="margin:0">Nenhum atendimento concluído neste período.</p>';
  const rows = {};
  done.forEach(a => {
    const key = a.payment || 'nao';
    const r = rows[key] || (rows[key] = { name: PAYMENTS[key] || 'Não informado', count: 0, value: 0 });
    r.count++;
    r.value += a.price;
  });
  const missing = rows.nao?.count || 0;
  return meterRows(
    Object.values(rows).sort((x, y) => y.value - x.value),
    missing ? `${missing} atendimento${missing === 1 ? '' : 's'} sem forma de pagamento informada.` : 'Considera apenas atendimentos concluídos.',
  );
}

function serviceBreakdown(appts) {
  const rows = {};
  appts.forEach(a => {
    const base = sum(a.services, s => s.price);
    a.services.forEach(s => {
      // Rateia o valor cobrado (que pode ter desconto) proporcionalmente ao preço de cada serviço
      const share = base ? s.price / base : 1 / a.services.length;
      const r = rows[s.name] || (rows[s.name] = { name: s.name, color: s.color, count: 0, value: 0 });
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
      </div>
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
        <button class="btn btn-ghost" data-action="export">${icon('download')} Exportar backup</button>
        <button class="btn btn-danger-ghost" data-action="logout">${icon('logout')} Sair</button>
      </div>
    </section>
  </div>`;
}

async function onSettingChange(el) {
  const key = el.dataset.setting;
  const before = { ...db.settings, workDays: [...db.settings.workDays] };
  const s = db.settings;
  if (key === 'workDays') {
    s.workDays = $$('[data-setting=workDays]:checked').map(i => Number(i.value)).sort();
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
  'new-service': () => openServiceForm(null),
  'edit-service': el => { const s = db.services.find(x => x.id === el.dataset.id); if (s) openServiceForm(s); },
  'new-client': () => openClientForm(null),
  'open-client': el => { const c = db.clients.find(x => x.id === el.dataset.id); if (c) openClientForm(c); },
  'close-sheet': el => { closeSheet(); if (el.getAttribute('href')) location.hash = el.getAttribute('href'); },
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
    if (session) await enter(session);
    else showLogin();
  } catch (err) {
    showLogin(err.message);
  }
})();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
