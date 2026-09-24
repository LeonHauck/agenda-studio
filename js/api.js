'use strict';

/* ============================================================
   Acesso aos dados (Supabase)
   O app trabalha com objetos em camelCase; o banco usa snake_case.
   ============================================================ */
const API = (() => {
  const cfg = window.AGENDA_CONFIG || {};
  const configured = Boolean(cfg.supabaseUrl && cfg.supabaseKey &&
    !cfg.supabaseUrl.includes('SEU-PROJETO') && !cfg.supabaseKey.includes('SUA-CHAVE'));
  const sb = configured && window.supabase ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey) : null;

  function translate(error) {
    const m = error?.message || String(error);
    if (/Invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    if (/Email not confirmed/i.test(m)) return 'Este e-mail ainda não foi confirmado.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Sem conexão com a internet. Tente novamente.';
    if (/JWT|permission denied|row-level security/i.test(m)) return 'Sem permissão. Entre novamente.';
    if (/invalid input syntax for type uuid/i.test(m)) return 'Link inválido. Confira o endereço recebido.';
    return m;
  }
  function check(error) {
    if (error) {
      console.error(error);
      throw new Error(translate(error));
    }
  }

  /* ---------- Conversões ---------- */
  const settingsFrom = r => ({
    businessName: r.business_name,
    whatsapp: r.whatsapp || '',
    openTime: r.open_time,
    closeTime: r.close_time,
    workDays: (r.work_days || []).map(Number),
    slotInterval: Number(r.slot_interval) || 15,
    accent: r.accent,
    changeNoticeHours: r.change_notice_hours ?? 2,
  });
  const settingsTo = s => ({
    business_name: s.businessName,
    whatsapp: s.whatsapp || '',
    open_time: s.openTime,
    close_time: s.closeTime,
    work_days: s.workDays,
    slot_interval: s.slotInterval,
    accent: s.accent,
    change_notice_hours: s.changeNoticeHours ?? 2,
  });
  const serviceFrom = r => ({
    id: r.id, name: r.name, price: Number(r.price), duration: r.duration, color: r.color, active: r.active, sort: r.sort,
  });
  const serviceTo = s => withId(s, {
    name: s.name, price: s.price, duration: s.duration, color: s.color, active: s.active !== false, sort: s.sort || 0,
  });
  const clientFrom = r => ({ id: r.id, name: r.name, phone: r.phone || '', notes: r.notes || '', createdAt: r.created_at });
  const clientTo = c => withId(c, { name: c.name, phone: c.phone || '', notes: c.notes || '' });
  const apptFrom = r => ({
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    phone: r.phone || '',
    services: r.services || [],
    date: r.date,
    start: r.start_time,
    duration: r.duration,
    price: Number(r.price),
    status: r.status,
    payment: r.payment_method || '',
    notes: r.notes || '',
    source: r.source,
    createdAt: r.created_at,
    manageToken: r.manage_token,
    clientAction: r.client_action || '',
    clientActionAt: r.client_action_at,
    reminderSentAt: r.reminder_sent_at,
  });
  const apptTo = a => withId(a, {
    client_id: a.clientId || null,
    client_name: a.clientName,
    phone: a.phone || '',
    services: a.services,
    date: a.date,
    start_time: a.start,
    duration: a.duration,
    price: a.price,
    status: a.status,
    payment_method: a.payment || null,
    notes: a.notes || '',
    reminder_sent_at: a.reminderSentAt || null,
  });
  const blockFrom = r => ({
    id: r.id, startDate: r.start_date, endDate: r.end_date,
    startTime: r.start_time || '', endTime: r.end_time || '', reason: r.reason || '',
  });
  const blockTo = b => withId(b, {
    start_date: b.startDate, end_date: b.endDate,
    start_time: b.startTime || null, end_time: b.endTime || null, reason: b.reason || '',
  });
  function withId(src, row) {
    if (src.id) row.id = src.id;
    return row;
  }

  /* ---------- Auxiliares ---------- */
  async function fetchAll(table, build) {
    const size = 1000;
    let from = 0, out = [];
    for (;;) {
      const { data, error } = await build(sb.from(table).select('*')).range(from, from + size - 1);
      check(error);
      out = out.concat(data);
      if (data.length < size) return out;
      from += size;
    }
  }
  async function saveRow(table, row) {
    const q = row.id ? sb.from(table).update(row).eq('id', row.id) : sb.from(table).insert(row);
    const { data, error } = await q.select().single();
    check(error);
    return data;
  }
  async function deleteRow(table, id) {
    const { error } = await sb.from(table).delete().eq('id', id);
    check(error);
  }

  return {
    configured,

    /* ---------- Login ---------- */
    async session() {
      const { data } = await sb.auth.getSession();
      return data.session;
    },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      check(error);
      return data.session;
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async isAdmin(userId) {
      const { data, error } = await sb.from('admins').select('user_id').eq('user_id', userId).maybeSingle();
      check(error);
      return Boolean(data);
    },

    /* ---------- Painel da dona ---------- */
    async loadAll() {
      const since = dateKey(addDays(new Date(), -400));
      const [settings, services, clients, appointments, blocks] = await Promise.all([
        sb.from('settings').select('*').eq('id', 1).single().then(({ data, error }) => { check(error); return settingsFrom(data); }),
        fetchAll('services', q => q.order('sort').order('name').order('id')).then(rows => rows.map(serviceFrom)),
        fetchAll('clients', q => q.order('name').order('id')).then(rows => rows.map(clientFrom)),
        fetchAll('appointments', q => q.gte('date', since).order('date').order('start_time').order('id')).then(rows => rows.map(apptFrom)),
        // Tolerante: se a tabela de bloqueios ainda não existir, o painel continua funcionando
        fetchAll('blocks', q => q.gte('end_date', since).order('start_date').order('id'))
          .then(rows => rows.map(blockFrom))
          .catch(err => { console.warn('Bloqueios indisponíveis:', err.message); return []; }),
      ]);
      return { settings, services, clients, appointments, blocks };
    },
    async saveSettings(s) {
      const { error } = await sb.from('settings').update(settingsTo(s)).eq('id', 1);
      check(error);
    },
    saveService: async s => serviceFrom(await saveRow('services', serviceTo(s))),
    deleteService: id => deleteRow('services', id),
    saveClient: async c => clientFrom(await saveRow('clients', clientTo(c))),
    deleteClient: id => deleteRow('clients', id),
    async renameClientAppointments(clientId, name, phone) {
      const { error } = await sb.from('appointments').update({ client_name: name, phone }).eq('client_id', clientId);
      check(error);
    },
    saveAppointment: async a => apptFrom(await saveRow('appointments', apptTo(a))),
    deleteAppointment: id => deleteRow('appointments', id),
    async markReminderSent(id) {
      const { data, error } = await sb.from('appointments')
        .update({ reminder_sent_at: new Date().toISOString() }).eq('id', id).select().single();
      check(error);
      return apptFrom(data);
    },
    saveBlock: async b => blockFrom(await saveRow('blocks', blockTo(b))),
    deleteBlock: id => deleteRow('blocks', id),

    /** Avisa quando algo muda no banco (ex.: cliente agendou pelo link). */
    subscribe(onChange) {
      const channel = sb.channel('agenda-admin');
      ['appointments', 'clients', 'services', 'blocks'].forEach(table => {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, payload => onChange(table, payload));
      });
      channel.subscribe();
      return channel;
    },

    /* ---------- Página pública ---------- */
    async publicInfo() {
      const [settings, services] = await Promise.all([
        sb.from('settings').select('*').eq('id', 1).single().then(({ data, error }) => { check(error); return settingsFrom(data); }),
        sb.from('services').select('*').eq('active', true).order('sort').order('name')
          .then(({ data, error }) => { check(error); return data.map(serviceFrom); }),
      ]);
      return { settings, services };
    },
    async busySlots(from, to, excludeToken = null) {
      const { data, error } = await sb.rpc('busy_slots', { p_from: from, p_to: to, p_exclude_token: excludeToken });
      check(error);
      return data.map(r => ({ date: r.day, start: r.start_time, duration: r.duration }));
    },
    async book({ name, phone, serviceIds, date, start, notes }) {
      const { data, error } = await sb.rpc('book_appointment', {
        p_name: name, p_phone: phone, p_service_ids: serviceIds, p_date: date, p_start: start, p_notes: notes || '',
      });
      check(error);
      return data;
    },

    /* ---------- Link pessoal da cliente (remarcar / cancelar) ---------- */
    async getBooking(token) {
      const { data, error } = await sb.rpc('get_booking', { p_token: token });
      check(error);
      return data;
    },
    async cancelBooking(token) {
      const { error } = await sb.rpc('cancel_booking', { p_token: token });
      check(error);
    },
    async rescheduleBooking(token, date, start) {
      const { data, error } = await sb.rpc('reschedule_booking', { p_token: token, p_date: date, p_start: start });
      check(error);
      return data;
    },
  };
})();
