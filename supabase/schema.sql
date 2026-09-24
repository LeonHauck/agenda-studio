-- ============================================================
-- Agenda Studio — estrutura do banco de dados (Supabase)
-- Como usar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Pode ser executado mais de uma vez sem problema.
-- ============================================================

-- ---------- Tabelas ----------

-- Quem pode acessar o painel (a dona). Preenchido manualmente no passo a passo.
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table if not exists public.settings (
  id            int primary key default 1 check (id = 1),
  business_name text not null default 'Meu Studio',
  whatsapp      text not null default '',
  open_time     text not null default '09:00' check (open_time ~ '^\d{2}:\d{2}$'),
  close_time    text not null default '19:00' check (close_time ~ '^\d{2}:\d{2}$'),
  work_days     int[] not null default '{1,2,3,4,5,6}',
  slot_interval int not null default 15 check (slot_interval between 5 and 240),
  accent        text not null default '#b4537a',
  updated_at    timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- Atualização: intervalo entre horários de até 240 minutos (antes era 120)
alter table public.settings drop constraint if exists settings_slot_interval_check;
alter table public.settings add constraint settings_slot_interval_check check (slot_interval between 5 and 240);

create table if not exists public.services (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 60),
  price      numeric(10, 2) not null check (price >= 0),
  duration   int not null check (duration between 5 and 720),
  color      text not null default '#e07a9b',
  active     boolean not null default true,  -- aparece no agendamento online?
  sort       int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 80),
  phone      text not null default '',
  notes      text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.appointments (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid references public.clients (id) on delete set null,
  client_name    text not null,
  phone          text not null default '',
  services       jsonb not null default '[]',
  date           date not null,
  start_time     text not null check (start_time ~ '^\d{2}:\d{2}$'),
  duration       int not null check (duration > 0),
  price          numeric(10, 2) not null default 0,
  status         text not null default 'agendado'
                 check (status in ('agendado', 'confirmado', 'concluido', 'cancelado')),
  payment_method text check (payment_method in ('pix', 'dinheiro', 'credito', 'debito', 'outro')),
  notes          text not null default '',
  source         text not null default 'admin' check (source in ('admin', 'online')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists appointments_date_idx on public.appointments (date);
create index if not exists appointments_client_idx on public.appointments (client_id);

-- Bloqueios de agenda: um dia, vários dias seguidos ou um período do dia.
-- Sem horário (start_time/end_time nulos) = dia inteiro bloqueado.
create table if not exists public.blocks (
  id         uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date   date not null,
  start_time text check (start_time ~ '^\d{2}:\d{2}$'),
  end_time   text check (end_time ~ '^\d{2}:\d{2}$'),
  reason     text not null default '',  -- visível só para a dona
  created_at timestamptz not null default now(),
  constraint blocks_dates_check check (end_date >= start_date),
  constraint blocks_times_pair check ((start_time is null) = (end_time is null)),
  constraint blocks_times_order check (start_time is null or start_time < end_time)
);
create index if not exists blocks_dates_idx on public.blocks (start_date, end_date);

-- Atualização: link para a cliente remarcar/cancelar e controle de lembretes
alter table public.appointments add column if not exists manage_token uuid not null default gen_random_uuid();
alter table public.appointments add column if not exists client_action text;
alter table public.appointments add column if not exists client_action_at timestamptz;
alter table public.appointments add column if not exists reminder_sent_at timestamptz;
create unique index if not exists appointments_manage_token_idx on public.appointments (manage_token);
alter table public.appointments drop constraint if exists appointments_client_action_check;
alter table public.appointments add constraint appointments_client_action_check
  check (client_action in ('cancelou', 'remarcou'));

-- Atualização: prazo para a cliente alterar pelo link (-1 = não permitir)
alter table public.settings add column if not exists change_notice_hours int not null default 2;
alter table public.settings drop constraint if exists settings_change_notice_check;
alter table public.settings add constraint settings_change_notice_check check (change_notice_hours between -1 and 168);

-- Serviços iniciais (só entram se a tabela estiver vazia)
insert into public.services (name, price, duration, color, sort)
select * from (values
  ('Manicure', 35, 45, '#e07a9b', 1),
  ('Pedicure', 40, 50, '#8b7cf6', 2),
  ('Pé e mão', 70, 90, '#f0a35e', 3),
  ('Esmaltação em gel', 80, 60, '#4fb3a9', 4),
  ('Alongamento em fibra', 180, 150, '#5b8def', 5)
) as v (name, price, duration, color, sort)
where not exists (select 1 from public.services);

-- ---------- Funções auxiliares ----------

create or replace function public.to_min(t text) returns int
language sql immutable as $$
  select split_part(t, ':', 1)::int * 60 + split_part(t, ':', 2)::int
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists appointments_touch on public.appointments;
create trigger appointments_touch before update on public.appointments
  for each row execute function public.touch_updated_at();
drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();

-- ---------- Segurança (Row Level Security) ----------
-- Regra geral: a dona (tabela admins) pode tudo.
-- Visitantes só podem ler as configurações e os serviços ativos.
-- Os agendamentos das clientes entram SOMENTE pela função book_appointment.

alter table public.admins       enable row level security;
alter table public.settings     enable row level security;
alter table public.services     enable row level security;
alter table public.clients      enable row level security;
alter table public.appointments enable row level security;
alter table public.blocks       enable row level security;

drop policy if exists "admin lê o próprio acesso" on public.admins;
create policy "admin lê o próprio acesso" on public.admins
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "todos leem configurações" on public.settings;
create policy "todos leem configurações" on public.settings
  for select to anon, authenticated using (true);
drop policy if exists "admin altera configurações" on public.settings;
create policy "admin altera configurações" on public.settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "todos leem serviços ativos" on public.services;
create policy "todos leem serviços ativos" on public.services
  for select to anon, authenticated using (active or public.is_admin());
drop policy if exists "admin gerencia serviços" on public.services;
create policy "admin gerencia serviços" on public.services
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin gerencia clientes" on public.clients;
create policy "admin gerencia clientes" on public.clients
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin gerencia agendamentos" on public.appointments;
create policy "admin gerencia agendamentos" on public.appointments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin gerencia bloqueios" on public.blocks;
create policy "admin gerencia bloqueios" on public.blocks
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.blocks to authenticated;
grant select on public.settings, public.services to anon;
grant select, insert, update, delete on public.services, public.clients, public.appointments to authenticated;
grant select, update on public.settings to authenticated;
grant select on public.admins to authenticated;
-- As regras acima usam is_admin(), então os papéis precisam poder executá-la
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.to_min(text) to anon, authenticated;

-- ---------- Funções da página pública ----------

-- Horários ocupados: agendamentos + bloqueios (sem nomes nem motivos).
-- Dia inteiro bloqueado aparece como 00:00 com 1440 minutos.
-- p_exclude_token: ao remarcar, o horário atual da própria cliente não conta como ocupado.
drop function if exists public.busy_slots(date, date);
create or replace function public.busy_slots(p_from date, p_to date, p_exclude_token uuid default null)
returns table (day date, start_time text, duration int)
language sql stable security definer set search_path = public as $$
  select a.date, a.start_time, a.duration
    from public.appointments a
   where a.date between p_from and p_to
     and a.status <> 'cancelado'
     and (p_exclude_token is null or a.manage_token <> p_exclude_token)
     and p_to - p_from <= 62
  union all
  select d::date,
         coalesce(b.start_time, '00:00'),
         case when b.start_time is null then 1440
              else public.to_min(b.end_time) - public.to_min(b.start_time) end
    from public.blocks b
   cross join generate_series(greatest(b.start_date, p_from), least(b.end_date, p_to), interval '1 day') as d
   where b.end_date >= p_from and b.start_date <= p_to
     and p_to - p_from <= 62
$$;

-- Regras de um horário para a cliente: dia de atendimento, expediente, bloqueios,
-- não estar no passado, até 60 dias à frente e sem conflito. Uso interno.
create or replace function public.validate_slot(p_date date, p_start text, p_duration int, p_exclude uuid default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  s       public.settings%rowtype;
  v_now   timestamp := now() at time zone 'America/Sao_Paulo';
  v_start int;
begin
  if coalesce(p_start, '') !~ '^\d{2}:\d{2}$' then
    raise exception 'Horário inválido.';
  end if;
  select * into s from public.settings where id = 1;
  v_start := public.to_min(p_start);

  if not (extract(dow from p_date)::int = any (s.work_days)) then
    raise exception 'Não atendemos neste dia.';
  end if;
  if v_start < public.to_min(s.open_time) or v_start + p_duration > public.to_min(s.close_time) then
    raise exception 'Horário fora do expediente.';
  end if;
  if exists (
    select 1 from public.blocks b
     where p_date between b.start_date and b.end_date
       and (b.start_time is null
            or (v_start < public.to_min(b.end_time) and v_start + p_duration > public.to_min(b.start_time)))
  ) then
    raise exception 'Esse horário não está disponível. Escolha outro.';
  end if;
  if p_date + p_start::time < v_now then
    raise exception 'Esse horário já passou.';
  end if;
  if p_date > v_now::date + 60 then
    raise exception 'Só é possível agendar com até 60 dias de antecedência.';
  end if;

  -- Uma reserva por vez para o mesmo dia (evita duas clientes no mesmo horário)
  perform pg_advisory_xact_lock(hashtext('agenda:' || p_date::text));

  if exists (
    select 1 from public.appointments a
     where a.date = p_date and a.status <> 'cancelado'
       and (p_exclude is null or a.id <> p_exclude)
       and v_start < public.to_min(a.start_time) + a.duration
       and v_start + p_duration > public.to_min(a.start_time)
  ) then
    raise exception 'Esse horário acabou de ser ocupado. Escolha outro.';
  end if;
end $$;

-- Pode a cliente alterar este agendamento pelo link? (prazo definido pela dona)
create or replace function public.can_client_change(a public.appointments) returns boolean
language sql stable security definer set search_path = public as $$
  select s.change_notice_hours >= 0
     and a.status in ('agendado', 'confirmado')
     and (a.date + a.start_time::time) - make_interval(hours => s.change_notice_hours)
         > (now() at time zone 'America/Sao_Paulo')
    from public.settings s where s.id = 1
$$;

-- Cria um agendamento feito pela cliente. Valida tudo no servidor.
create or replace function public.book_appointment(
  p_name text, p_phone text, p_service_ids uuid[], p_date date, p_start text, p_notes text default ''
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_name     text := btrim(coalesce(p_name, ''));
  v_phone    text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_fmt      text;
  v_now      timestamp := now() at time zone 'America/Sao_Paulo';
  v_n        int := coalesce(array_length(p_service_ids, 1), 0);
  v_count    int;
  v_duration int;
  v_price    numeric;
  v_services jsonb;
  v_client   uuid;
  v_id       uuid;
  v_token    uuid;
begin
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'Informe seu nome.';
  end if;
  if char_length(v_phone) not between 10 and 11 then
    raise exception 'Informe um WhatsApp válido, com DDD.';
  end if;
  if v_n = 0 or v_n > 5 then
    raise exception 'Escolha de 1 a 5 serviços.';
  end if;

  select count(*), coalesce(sum(duration), 0), coalesce(sum(price), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'serviceId', id, 'name', name, 'price', price, 'duration', duration, 'color', color
         ) order by sort, name), '[]'::jsonb)
    into v_count, v_duration, v_price, v_services
    from public.services
   where id = any (p_service_ids) and active;
  if v_count <> v_n then
    raise exception 'Algum serviço não está mais disponível. Atualize a página.';
  end if;

  perform public.validate_slot(p_date, p_start, v_duration, null);

  if (select count(*) from public.appointments
       where regexp_replace(phone, '\D', '', 'g') = v_phone
         and status <> 'cancelado' and date >= v_now::date) >= 3 then
    raise exception 'Você já tem 3 horários marcados. Para mais, fale com o estúdio pelo WhatsApp.';
  end if;

  v_fmt := '(' || substr(v_phone, 1, 2) || ') ' ||
           case when char_length(v_phone) = 11
                then substr(v_phone, 3, 5) || '-' || substr(v_phone, 8)
                else substr(v_phone, 3, 4) || '-' || substr(v_phone, 7) end;

  select id into v_client from public.clients
   where regexp_replace(phone, '\D', '', 'g') = v_phone
   order by created_at limit 1;
  if v_client is null then
    insert into public.clients (name, phone) values (v_name, v_fmt) returning id into v_client;
  end if;

  insert into public.appointments
    (client_id, client_name, phone, services, date, start_time, duration, price, status, notes, source)
  values
    (v_client, v_name, v_fmt, v_services, p_date, p_start, v_duration, v_price, 'confirmado',
     left(coalesce(p_notes, ''), 300), 'online')
  returning id, manage_token into v_id, v_token;

  return json_build_object('id', v_id, 'token', v_token, 'date', p_date, 'start', p_start,
                           'duration', v_duration, 'price', v_price);
end $$;

-- Consulta um agendamento pelo link pessoal da cliente
create or replace function public.get_booking(p_token uuid) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  a public.appointments%rowtype;
  s public.settings%rowtype;
begin
  select * into a from public.appointments where manage_token = p_token;
  if not found then
    raise exception 'Agendamento não encontrado. Confira o link.';
  end if;
  select * into s from public.settings where id = 1;
  return json_build_object(
    'date', a.date, 'start', a.start_time, 'duration', a.duration, 'price', a.price,
    'services', a.services, 'status', a.status, 'name', a.client_name,
    'canChange', public.can_client_change(a), 'noticeHours', s.change_notice_hours);
end $$;

-- Cancelamento pela cliente
create or replace function public.cancel_booking(p_token uuid) returns json
language plpgsql security definer set search_path = public as $$
declare
  a public.appointments%rowtype;
begin
  select * into a from public.appointments where manage_token = p_token for update;
  if not found then
    raise exception 'Agendamento não encontrado. Confira o link.';
  end if;
  if a.status = 'cancelado' then
    raise exception 'Este horário já está cancelado.';
  end if;
  if not public.can_client_change(a) then
    raise exception 'Não é mais possível cancelar pelo link. Fale com o estúdio pelo WhatsApp.';
  end if;
  update public.appointments
     set status = 'cancelado', client_action = 'cancelou', client_action_at = now()
   where id = a.id;
  return json_build_object('ok', true);
end $$;

-- Remarcação pela cliente (mesmos serviços e duração, novo dia/horário)
create or replace function public.reschedule_booking(p_token uuid, p_date date, p_start text) returns json
language plpgsql security definer set search_path = public as $$
declare
  a public.appointments%rowtype;
begin
  select * into a from public.appointments where manage_token = p_token for update;
  if not found then
    raise exception 'Agendamento não encontrado. Confira o link.';
  end if;
  if not public.can_client_change(a) then
    raise exception 'Não é mais possível remarcar pelo link. Fale com o estúdio pelo WhatsApp.';
  end if;
  perform public.validate_slot(p_date, p_start, a.duration, a.id);
  update public.appointments
     set date = p_date, start_time = p_start, status = 'confirmado',
         client_action = 'remarcou', client_action_at = now(), reminder_sent_at = null
   where id = a.id;
  return json_build_object('date', p_date, 'start', p_start, 'duration', a.duration);
end $$;

-- Permissões: visitantes só executam as funções públicas; validate_slot é interna
revoke all on function public.validate_slot(date, text, int, uuid) from public, anon, authenticated;
revoke all on function public.can_client_change(public.appointments) from public, anon, authenticated;
revoke all on function public.book_appointment(text, text, uuid[], date, text, text) from public;
revoke all on function public.busy_slots(date, date, uuid) from public;
revoke all on function public.get_booking(uuid) from public;
revoke all on function public.cancel_booking(uuid) from public;
revoke all on function public.reschedule_booking(uuid, date, text) from public;
grant execute on function public.book_appointment(text, text, uuid[], date, text, text) to anon, authenticated;
grant execute on function public.busy_slots(date, date, uuid) to anon, authenticated;
grant execute on function public.get_booking(uuid) to anon, authenticated;
grant execute on function public.cancel_booking(uuid) to anon, authenticated;
grant execute on function public.reschedule_booking(uuid, date, text) to anon, authenticated;

-- ---------- Tempo real (o painel atualiza sozinho quando uma cliente agenda) ----------
do $$
declare t text;
begin
  foreach t in array array['appointments', 'clients', 'services', 'blocks'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;  -- já estava na publicação
    end;
  end loop;
end $$;
