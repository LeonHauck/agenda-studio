'use strict';

/* ============================================================
   Código compartilhado entre a página pública e o painel da dona
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const BRL_SHORT = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const money = v => BRL.format(Number(v) || 0);
const moneyShort = v => BRL_SHORT.format(Math.round(Number(v) || 0));
const pad = n => String(n).padStart(2, '0');
const toMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const fromMin = min => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const todayKey = () => dateKey(new Date());
const nowMinutes = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const digits = s => String(s || '').replace(/\D/g, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';
const initials = name => String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('') || '?';
const sum = (list, fn) => list.reduce((t, x) => t + (Number(fn(x)) || 0), 0);

const DOW_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const DOW_LONG = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const PALETTE = ['#e07a9b', '#b4537a', '#8b7cf6', '#5b8def', '#4fb3a9', '#6bab5a', '#e9b44c', '#f0a35e', '#d9644a', '#8a8580'];
const ACCENTS = ['#b4537a', '#c2566b', '#7c5cc4', '#2f6fdb', '#1f8a78', '#b7791f'];
const STATUS = {
  agendado: { label: 'Agendado' },
  confirmado: { label: 'Confirmado' },
  concluido: { label: 'Concluído' },
  cancelado: { label: 'Cancelado' },
};
const PAYMENTS = {
  pix: 'Pix',
  dinheiro: 'Dinheiro',
  credito: 'Cartão de crédito',
  debito: 'Cartão de débito',
  outro: 'Outro',
};

function fmtDuration(min) {
  min = Math.round(Number(min) || 0);
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m}min`;
  return m ? `${h}h${pad(m)}` : `${h}h`;
}
function fmtDateLong(k) {
  const d = parseKey(k);
  return `${DOW_LONG[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
}
function fmtDateShort(k) {
  const d = parseKey(k);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function formatPhone(v) {
  const d = digits(v).slice(0, 11);
  if (!d) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
function waLink(phone, text) {
  let d = digits(phone);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

/**
 * Horários livres (em minutos) para uma data, considerando o expediente, os
 * agendamentos e os bloqueios. `appts` aceita agendamentos completos ou apenas
 * { date, start, duration, kind } (horários ocupados vindos da página pública).
 * O intervalo de limpeza (settings.bufferMinutes) é reservado entre atendimentos;
 * não é somado antes de bloqueios nem do horário de fechamento.
 */
function computeSlots(settings, appts, date, duration, excludeId = null) {
  const open = toMin(settings.openTime), close = toMin(settings.closeTime), step = settings.slotInterval;
  const buffer = Number(settings.bufferMinutes) || 0;
  const busy = appts
    .filter(a => a.date === date && a.status !== 'cancelado' && (excludeId == null || a.id !== excludeId))
    .map(a => {
      const extra = a.kind === 'block' ? 0 : buffer;
      return [toMin(a.start), toMin(a.start) + a.duration + extra, extra];
    });
  const minStart = date === todayKey() ? nowMinutes() : -1;
  const slots = [];
  for (let t = open; t + duration <= close; t += step) {
    if (t < minStart) continue;
    if (busy.some(([b, e, extra]) => t < e && t + duration + extra > b)) continue;
    slots.push(t);
  }
  return slots;
}

/* ---------- Ícones ---------- */
const ICONS = {
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevRight: '<path d="M9 5l7 7-7 7"/>',
  chevDown: '<path d="M6 9l6 6 6-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20.5l1.6-5.2A8.5 8.5 0 1 1 21 11.5z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
  chart: '<path d="M3 20.5h18"/><rect x="5" y="11" width="3.5" height="7" rx="1"/><rect x="10.25" y="5" width="3.5" height="13" rx="1"/><rect x="15.5" y="13.5" width="3.5" height="4.5" rx="1"/>',
  alert: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  logout: '<path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
};
const icon = name => `<span class="i" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[name] || ''}</svg></span>`;

/* ---------- Interface ---------- */
const CREDIT_URL = 'https://www.linkedin.com/in/leon-hauck/';
const creditHtml = () =>
  `<footer class="credit">Desenvolvido por <a href="${CREDIT_URL}" target="_blank" rel="noopener">Leon Hauck</a></footer>`;

function applyAccent(color) {
  if (color) document.documentElement.style.setProperty('--accent', color);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function bindPhoneMask(input) {
  input.addEventListener('input', () => { input.value = formatPhone(input.value); });
}

/** Desabilita o botão enquanto a ação roda e mostra o erro, se houver. Retorna true se deu certo. */
async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(err);
    toast(err.message || 'Algo deu errado. Tente novamente.');
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}
