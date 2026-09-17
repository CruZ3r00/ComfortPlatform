-- 0003 - Schema bus: tabelle e funzioni del bus di messaggi (ADR-0014 §14.7, §14.9, §4).
--
-- Proprieta': tutto appartiene a platform_admin. Lo schema nasce con AUTHORIZATION (serve CREATE sul
-- database all'amministratore), poi `set local role platform_admin` crea gli oggetti a suo nome; 0002 ha
-- dato all'amministratore l'appartenenza con SET e INHERIT.
--
-- Accesso delle app: solo le funzioni pubbliche, SECURITY DEFINER con search_path fissato, che ricavano
-- l'app chiamante da `session_user` (dentro una funzione SECURITY DEFINER `current_user` e' il
-- proprietario). Agli utenti applicativi USAGE sullo schema, necessario per chiamare le funzioni, ed
-- EXECUTE sulle funzioni pubbliche; nessun permesso su tabelle, sequenze e funzioni interne.
--
-- Consegna conclusa = `done`. Una consegna `dead` non e' conclusa: blocca le successive della stessa
-- entita', conserva il payload sensibile e trattiene il messaggio dalla pulizia finche' non viene
-- rispedita o scartata.
--
-- Versioni del contratto (§14.8): la versione e' un dato. Un argomento ha una o piu' versioni registrate,
-- il produttore pubblica in parallelo tutte quelle in uso, e ogni app e' iscritta a una sola versione per
-- argomento. Produttore, riservatezza e conservazione sono dell'argomento, uguali per tutte le versioni.
--
-- Idempotente: `if not exists`, `create or replace`, `on conflict do nothing`, permessi ripetibili.

create schema if not exists bus authorization platform_admin;

set local role platform_admin;

-- Tabelle -----------------------------------------------------------------------------------------

create table if not exists bus.apps (
  code      text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
  role_name text not null unique
);

create table if not exists bus.topics (
  name           text primary key check (name ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  producer       text not null references bus.apps (code),
  sensitive      boolean not null default false,
  retention_days integer not null default 30 check (retention_days > 0)
);

-- Versioni registrate del contratto di ogni argomento (JSON Schema in bus/contract/).
create table if not exists bus.topic_versions (
  topic          text not null references bus.topics (name),
  schema_version integer not null check (schema_version > 0),
  primary key (topic, schema_version)
);

-- Chiave (app, argomento): un'app riceve una sola versione di ogni argomento, cosi' lo stesso evento non
-- viene elaborato due volte. Il passaggio a una nuova versione aggiorna `schema_version`.
create table if not exists bus.subscriptions (
  app            text not null references bus.apps (code),
  topic          text not null,
  schema_version integer not null,
  primary key (app, topic),
  foreign key (topic, schema_version) references bus.topic_versions (topic, schema_version)
);

-- `seq` da' l'ordine di pubblicazione: un uuid v4 non e' ordinabile.
create table if not exists bus.messages (
  id                uuid primary key default gen_random_uuid(),
  seq               bigint generated always as identity unique,
  topic             text not null,
  schema_version    integer not null,
  producer          text not null references bus.apps (code),
  organization_id   uuid,
  entity_ref        text,
  entity_version    bigint,
  request_id        uuid,
  payload           jsonb,
  occurred_at       timestamptz not null,
  published_at      timestamptz not null default now(),
  payload_erased_at timestamptz,
  constraint messages_organization_required check (organization_id is not null or producer = 'platform'),
  constraint messages_payload_or_erased check ((payload is null) = (payload_erased_at is not null)),
  foreign key (topic, schema_version) references bus.topic_versions (topic, schema_version)
);

create index if not exists messages_entity_idx on bus.messages (entity_ref, seq) where entity_ref is not null;
create index if not exists messages_cleanup_idx on bus.messages (topic, published_at);

create table if not exists bus.deliveries (
  message_id      uuid not null references bus.messages (id) on delete cascade,
  app             text not null references bus.apps (code),
  status          text not null default 'pending' check (status in ('pending', 'failed', 'done', 'dead')),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  first_failed_at timestamptz,
  last_error      text,
  done_at         timestamptz,
  primary key (message_id, app),
  constraint deliveries_done_at check ((status = 'done') = (done_at is not null))
);

create index if not exists deliveries_open_idx on bus.deliveries (app, status, next_attempt_at) where status <> 'done';

-- Un solo blocco aperto per app. `waiting_count` e `oldest_waiting_at` sono fotografati all'apertura e
-- aggiornati dai fallimenti dell'app bloccata; `processed_count` alla chiusura.
create table if not exists bus.stalls (
  id                  bigint generated always as identity primary key,
  app                 text not null references bus.apps (code),
  kind                text not null check (kind in ('backlog', 'failing', 'dead')),
  opened_at           timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  waiting_count       integer not null default 0,
  oldest_waiting_at   timestamptz,
  last_error          text,
  opened_claimed_by   text references bus.apps (code),
  opened_claimed_at   timestamptz,
  opened_sent_at      timestamptz,
  banner_at           timestamptz,
  closed_at           timestamptz,
  processed_count     integer,
  resolved_claimed_by text references bus.apps (code),
  resolved_claimed_at timestamptz,
  resolved_sent_at    timestamptz
);

create unique index if not exists stalls_open_app_idx on bus.stalls (app) where closed_at is null;

alter table bus.apps enable row level security;
alter table bus.topics enable row level security;
alter table bus.topic_versions enable row level security;
alter table bus.subscriptions enable row level security;
alter table bus.messages enable row level security;
alter table bus.deliveries enable row level security;
alter table bus.stalls enable row level security;

-- App del bus. `platform` e' l'amministratore che applica le migrazioni: i job pg_cron girano come lui
-- (pg_cron non esegue job di altri utenti ne' di ruoli NOLOGIN), e pubblicano come ogni altra app.
insert into bus.apps (code, role_name) values
  ('comfortables', 'ct_app'),
  ('logistics', 'cl_app'),
  ('account', 'cs_account'),
  ('platform', session_user::text)
on conflict (code) do nothing;

-- Funzioni interne (nessun permesso alle app) -----------------------------------------------------

create or replace function bus.stall_rank(p_kind text)
  returns integer
  language sql immutable
  set search_path = bus, pg_temp
as $$
  select case p_kind when 'backlog' then 1 when 'failing' then 2 when 'dead' then 3 end
$$;

-- Attesa prima del tentativo successivo (§14.7): 10 s, 1 min, 5 min, 30 min, poi ogni ora.
create or replace function bus.backoff(p_attempts integer)
  returns interval
  language sql immutable
  set search_path = bus, pg_temp
as $$
  select case p_attempts
           when 1 then interval '10 seconds'
           when 2 then interval '1 minute'
           when 3 then interval '5 minutes'
           when 4 then interval '30 minutes'
           else interval '1 hour'
         end
$$;

-- Un avviso email e' prendibile se non e' stato inviato e non e' preso, o la presa e' piu' vecchia di
-- 5 minuti (app caduta durante l'invio). `resolved` solo a blocco chiuso e dopo l'email di apertura.
create or replace function bus.notice_claimable(p_stall bus.stalls, p_kind text)
  returns boolean
  language sql stable
  set search_path = bus, pg_temp
as $$
  select case p_kind
           when 'opened' then
             p_stall.opened_sent_at is null
             and (p_stall.opened_claimed_at is null or p_stall.opened_claimed_at < now() - interval '5 minutes')
           when 'resolved' then
             p_stall.closed_at is not null
             and p_stall.opened_sent_at is not null
             and p_stall.resolved_sent_at is null
             and (p_stall.resolved_claimed_at is null or p_stall.resolved_claimed_at < now() - interval '5 minutes')
           else false
         end
$$;

create or replace function bus.caller_app()
  returns text
  language plpgsql stable
  set search_path = bus, pg_temp
as $$
declare
  v_app text;
begin
  select a.code into v_app from bus.apps a where a.role_name = session_user::text;
  if v_app is null then
    raise exception 'bus: l''utente % non e'' un''app registrata nel bus', session_user
      using errcode = 'insufficient_privilege';
  end if;
  return v_app;
end
$$;

-- Apre il blocco di un'app, o se e' gia' aperto non lo duplica (§14.9). Con `p_refresh` (fallimenti
-- dell'app stessa) aggiorna gravita', conteggi e ultimo errore; da `publish` non lo tocca, per non
-- bloccare la riga del blocco di un'altra app nella transazione del produttore.
create or replace function bus.open_stall(p_app text, p_kind text, p_error text, p_refresh boolean)
  returns void
  language plpgsql
  set search_path = bus, pg_temp
as $$
declare
  v_waiting integer;
  v_oldest timestamptz;
  v_sent timestamptz;
begin
  select count(*)::integer, min(m.published_at)
    into v_waiting, v_oldest
    from bus.deliveries d
    join bus.messages m on m.id = d.message_id
   where d.app = p_app
     and d.status <> 'done';

  insert into bus.stalls (app, kind, waiting_count, oldest_waiting_at, last_error)
  values (p_app, p_kind, v_waiting, v_oldest, p_error)
  on conflict (app) where closed_at is null do nothing;
  if found then
    perform pg_notify('bus_stalls', '');
    return;
  end if;

  if p_refresh then
    update bus.stalls s
       set kind = case when bus.stall_rank(p_kind) > bus.stall_rank(s.kind) then p_kind else s.kind end,
           updated_at = now(),
           waiting_count = v_waiting,
           oldest_waiting_at = v_oldest,
           last_error = coalesce(p_error, s.last_error)
     where s.app = p_app
       and s.closed_at is null
    returning s.opened_sent_at into v_sent;
  else
    select s.opened_sent_at into v_sent from bus.stalls s where s.app = p_app and s.closed_at is null;
  end if;

  -- Email di apertura non ancora inviata: nuovo avviso, cosi' una presa in carico abbandonata viene
  -- ripresa alla successiva attivita' del bus, senza controlli periodici.
  if v_sent is null then
    perform pg_notify('bus_stalls', '');
  end if;
end
$$;

-- Banner (§14.9): blocco di ComfortLogistics, o di ComforTables sui messaggi di ComfortLogistics,
-- aperto da 15 minuti. Verificato a ogni publish o fail che riguarda l'app.
create or replace function bus.check_banner(p_app text)
  returns void
  language plpgsql
  set search_path = bus, pg_temp
as $$
begin
  update bus.stalls s
     set banner_at = now(),
         updated_at = now()
   where s.app = p_app
     and s.closed_at is null
     and s.banner_at is null
     and s.opened_at <= now() - interval '15 minutes'
     and (s.app = 'logistics'
          or (s.app = 'comfortables'
              and exists (select 1
                            from bus.deliveries d
                            join bus.messages m on m.id = d.message_id
                            join bus.topics t on t.name = m.topic
                           where d.app = s.app
                             and d.status <> 'done'
                             and t.producer = 'logistics')));
  if found then
    perform pg_notify('bus_stalls', '');
  end if;
end
$$;

-- Chiude il blocco quando per l'app non restano consegne scadute (pending da piu' di 5 minuti) o
-- fallite (failed, dead), e registra quante consegne ha concluso durante il blocco.
create or replace function bus.close_stall_if_resolved(p_app text)
  returns void
  language plpgsql
  set search_path = bus, pg_temp
as $$
begin
  if not exists (select 1 from bus.stalls s where s.app = p_app and s.closed_at is null) then
    return;
  end if;
  if exists (select 1
               from bus.deliveries d
               join bus.messages m on m.id = d.message_id
              where d.app = p_app
                and (d.status in ('failed', 'dead')
                     or (d.status = 'pending' and m.published_at < now() - interval '5 minutes'))) then
    return;
  end if;

  update bus.stalls s
     set closed_at = now(),
         updated_at = now(),
         processed_count = (select count(*)::integer
                              from bus.deliveries d
                             where d.app = s.app
                               and d.status = 'done'
                               and d.done_at >= s.opened_at)
   where s.app = p_app
     and s.closed_at is null;
  if found then
    perform pg_notify('bus_stalls', '');
  end if;
end
$$;

-- Funzioni pubbliche -------------------------------------------------------------------------------

-- Un messaggio senza iscritti alla sua versione non viene salvato e `publish` restituisce null: nessuno
-- lo elaborerebbe mai (un'iscrizione nuova non riceve i messaggi passati), e durante un passaggio di
-- versione raddoppierebbe la crescita della tabella e terrebbe payload sensibili fino alla pulizia.
create or replace function bus.publish(
  p_topic text,
  p_schema_version integer,
  p_organization_id uuid,
  p_entity_ref text,
  p_entity_version bigint,
  p_payload jsonb,
  p_occurred_at timestamptz default now(),
  p_request_id uuid default null
)
  returns uuid
  language plpgsql
  security definer
  set search_path = bus, pg_temp
as $$
declare
  v_app text := bus.caller_app();
  v_producer text;
  v_id uuid;
  v_subscriber text;
begin
  select t.producer into v_producer from bus.topics t where t.name = p_topic;
  if not found then
    raise exception 'bus.publish: argomento % inesistente', p_topic
      using errcode = 'undefined_object';
  end if;
  if v_producer <> v_app then
    raise exception 'bus.publish: l''app % non produce l''argomento % (produttore %)', v_app, p_topic, v_producer
      using errcode = 'insufficient_privilege';
  end if;
  if p_schema_version is null then
    raise exception 'bus.publish: schema_version obbligatoria per %', p_topic
      using errcode = 'not_null_violation';
  end if;
  if not exists (select 1 from bus.topic_versions v where v.topic = p_topic and v.schema_version = p_schema_version) then
    raise exception 'bus.publish: versione % dell''argomento % non registrata', p_schema_version, p_topic
      using errcode = 'undefined_object';
  end if;
  if p_organization_id is null and v_app <> 'platform' then
    raise exception 'bus.publish: organization_id obbligatorio per %', p_topic
      using errcode = 'not_null_violation';
  end if;
  if p_payload is null or p_occurred_at is null then
    raise exception 'bus.publish: payload e occurred_at obbligatori per %', p_topic
      using errcode = 'not_null_violation';
  end if;

  if not exists (select 1 from bus.subscriptions s where s.topic = p_topic and s.schema_version = p_schema_version) then
    return null;
  end if;

  insert into bus.messages (topic, schema_version, producer, organization_id, entity_ref, entity_version, request_id, payload, occurred_at)
  values (p_topic, p_schema_version, v_app, p_organization_id, p_entity_ref, p_entity_version, p_request_id, p_payload, p_occurred_at)
  returning id into v_id;

  for v_subscriber in
    insert into bus.deliveries (message_id, app)
    select v_id, s.app from bus.subscriptions s where s.topic = p_topic and s.schema_version = p_schema_version
    returning app
  loop
    -- Consegnato solo al commit: se la transazione del produttore fallisce nessuno viene svegliato.
    perform pg_notify('bus_' || v_subscriber, '');

    if exists (select 1
                 from bus.deliveries d
                 join bus.messages m on m.id = d.message_id
                where d.app = v_subscriber
                  and d.status = 'pending'
                  and m.published_at < now() - interval '5 minutes') then
      perform bus.open_stall(v_subscriber, 'backlog', null, false);
    end if;
    perform bus.check_banner(v_subscriber);
  end loop;

  return v_id;
end
$$;

-- Prossima consegna dovuta dell'app, bloccata fino alla fine della transazione del chiamante. Esclusa
-- se l'app ha una consegna precedente non conclusa con lo stesso entity_ref (ordine per entita').
create or replace function bus.next()
  returns table (
    message_id uuid,
    topic text,
    schema_version integer,
    producer text,
    organization_id uuid,
    entity_ref text,
    entity_version bigint,
    request_id uuid,
    payload jsonb,
    occurred_at timestamptz,
    published_at timestamptz,
    attempts integer
  )
  language plpgsql
  security definer
  set search_path = bus, pg_temp
as $$
declare
  v_app text := bus.caller_app();
begin
  return query
  select m.id, m.topic, m.schema_version, m.producer, m.organization_id, m.entity_ref, m.entity_version, m.request_id,
         m.payload, m.occurred_at, m.published_at, d.attempts
    from bus.deliveries d
    join bus.messages m on m.id = d.message_id
   where d.app = v_app
     and d.status in ('pending', 'failed')
     and d.next_attempt_at <= now()
     and not exists (select 1
                       from bus.deliveries pd
                       join bus.messages pm on pm.id = pd.message_id
                      where pd.app = d.app
                        and pd.status <> 'done'
                        and pm.entity_ref = m.entity_ref
                        and pm.seq < m.seq)
   order by m.seq
   limit 1
     for update of d skip locked;
end
$$;

create or replace function bus.ack(p_message_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = bus, pg_temp
as $$
declare
  v_app text := bus.caller_app();
  v_status text;
begin
  -- Le conferme dello stesso messaggio si serializzano: altrimenti due app che confermano insieme le
  -- ultime consegne non vedrebbero l'una la conferma dell'altra e il payload sensibile resterebbe.
  perform 1 from bus.messages m where m.id = p_message_id for no key update;

  update bus.deliveries d
     set status = 'done',
         done_at = now()
   where d.message_id = p_message_id
     and d.app = v_app
     and d.status in ('pending', 'failed');
  if not found then
    select d.status into v_status from bus.deliveries d where d.message_id = p_message_id and d.app = v_app;
    if not found then
      raise exception 'bus.ack: nessuna consegna del messaggio % per l''app %', p_message_id, v_app
        using errcode = 'no_data_found';
    end if;
    raise exception 'bus.ack: la consegna del messaggio % per l''app % e'' gia'' %', p_message_id, v_app, v_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Argomento sensibile: contenuto cancellato quando tutte le consegne sono concluse (§14.7).
  update bus.messages m
     set payload = null,
         payload_erased_at = now()
   where m.id = p_message_id
     and m.payload is not null
     and exists (select 1 from bus.topics t where t.name = m.topic and t.sensitive)
     and not exists (select 1 from bus.deliveries d where d.message_id = m.id and d.status <> 'done');

  perform bus.close_stall_if_resolved(v_app);
end
$$;

-- Fallimento dell'handler, in una transazione separata dopo il rollback. `p_permanent` (messaggio non
-- valido per il contratto) porta subito a `dead`. Su una consegna gia' conclusa o morta non cambia nulla:
-- tra il rollback e questa chiamata un'altra istanza puo' averla gia' elaborata.
create or replace function bus.fail(p_message_id uuid, p_error text, p_permanent boolean default false)
  returns table (status text, attempts integer, next_attempt_at timestamptz)
  language plpgsql
  security definer
  set search_path = bus, pg_temp
as $$
#variable_conflict use_column
declare
  v_app text := bus.caller_app();
  v_error text := left(coalesce(p_error, ''), 2000);
  v_delivery bus.deliveries%rowtype;
begin
  select * into v_delivery
    from bus.deliveries d
   where d.message_id = p_message_id
     and d.app = v_app
     for update;
  if not found then
    raise exception 'bus.fail: nessuna consegna del messaggio % per l''app %', p_message_id, v_app
      using errcode = 'no_data_found';
  end if;

  if v_delivery.status in ('pending', 'failed') then
    update bus.deliveries d
       set attempts = d.attempts + 1,
           status = case when p_permanent or d.attempts + 1 >= 10 then 'dead' else 'failed' end,
           next_attempt_at = now() + bus.backoff(d.attempts + 1),
           first_failed_at = coalesce(d.first_failed_at, now()),
           last_error = v_error
     where d.message_id = p_message_id
       and d.app = v_app
    returning d.* into v_delivery;

    -- Blocchi (§14.9): `dead` subito, `failing` dal terzo tentativo.
    if v_delivery.status = 'dead' then
      perform bus.open_stall(v_app, 'dead', v_error, true);
    elsif v_delivery.attempts >= 3 then
      perform bus.open_stall(v_app, 'failing', v_error, true);
    end if;
    perform bus.check_banner(v_app);
  end if;

  return query
  select v_delivery.status,
         v_delivery.attempts,
         case when v_delivery.status = 'failed' then v_delivery.next_attempt_at end;
end
$$;

-- Stato per app: pagine di stato, test e risveglio della libreria al prossimo retry. `next_retry_at` e' il
-- prossimo tentativo futuro: una consegna gia' dovuta ma non restituita da `next` e' ferma dietro un'altra
-- consegna della stessa entita', o in elaborazione altrove, e non deve svegliare subito la libreria.
create or replace function bus.status()
  returns table (
    app text,
    pending integer,
    failed integer,
    dead integer,
    oldest_pending_at timestamptz,
    oldest_pending_age interval,
    next_retry_at timestamptz,
    stall_id bigint,
    stall_kind text,
    stall_opened_at timestamptz,
    banner_at timestamptz
  )
  language sql
  stable
  security definer
  set search_path = bus, pg_temp
as $$
  select a.code,
         (count(*) filter (where d.status = 'pending'))::integer,
         (count(*) filter (where d.status = 'failed'))::integer,
         (count(*) filter (where d.status = 'dead'))::integer,
         min(m.published_at) filter (where d.status = 'pending'),
         now() - min(m.published_at) filter (where d.status = 'pending'),
         min(d.next_attempt_at) filter (where d.status = 'failed' and d.next_attempt_at > now()),
         s.id,
         s.kind,
         s.opened_at,
         s.banner_at
    from bus.apps a
    left join bus.deliveries d on d.app = a.code and d.status <> 'done'
    left join bus.messages m on m.id = d.message_id
    left join bus.stalls s on s.app = a.code and s.closed_at is null
   group by a.code, s.id
   order by a.code
$$;

-- Avvisi email da inviare, con i dati per il testo (§14.9). Letti all'avvio, a ogni riconnessione e a
-- ogni avviso su `bus_stalls`.
create or replace function bus.stall_notices()
  returns table (
    stall_id bigint,
    kind text,
    app text,
    stall_kind text,
    opened_at timestamptz,
    closed_at timestamptz,
    waiting_count integer,
    oldest_waiting_at timestamptz,
    last_error text,
    processed_count integer
  )
  language sql
  stable
  security definer
  set search_path = bus, pg_temp
as $$
  select s.id, n.kind, s.app, s.kind, s.opened_at, s.closed_at, s.waiting_count, s.oldest_waiting_at,
         s.last_error, s.processed_count
    from bus.stalls s
   cross join (values ('opened'), ('resolved')) as n (kind)
   where (s.closed_at is null or s.resolved_sent_at is null)
     and bus.notice_claimable(s, n.kind)
   order by s.id, n.kind
$$;

-- Presa in carico atomica: una sola app riceve la riga e invia l'email.
create or replace function bus.claim_stall_notice(p_stall_id bigint, p_kind text)
  returns table (
    stall_id bigint,
    kind text,
    app text,
    stall_kind text,
    opened_at timestamptz,
    closed_at timestamptz,
    waiting_count integer,
    oldest_waiting_at timestamptz,
    last_error text,
    processed_count integer
  )
  language plpgsql
  security definer
  set search_path = bus, pg_temp
as $$
#variable_conflict use_column
declare
  v_app text := bus.caller_app();
begin
  if p_kind = 'opened' then
    update bus.stalls s
       set opened_claimed_by = v_app,
           opened_claimed_at = now()
     where s.id = p_stall_id
       and bus.notice_claimable(s, 'opened');
  elsif p_kind = 'resolved' then
    update bus.stalls s
       set resolved_claimed_by = v_app,
           resolved_claimed_at = now()
     where s.id = p_stall_id
       and bus.notice_claimable(s, 'resolved');
  else
    raise exception 'bus.claim_stall_notice: tipo di avviso % non valido (opened, resolved)', p_kind
      using errcode = 'invalid_parameter_value';
  end if;
  if not found then
    return;
  end if;

  return query
  select s.id, p_kind, s.app, s.kind, s.opened_at, s.closed_at, s.waiting_count, s.oldest_waiting_at,
         s.last_error, s.processed_count
    from bus.stalls s
   where s.id = p_stall_id;
end
$$;

create or replace function bus.complete_stall_notice(p_stall_id bigint, p_kind text)
  returns void
  language plpgsql
  security definer
  set search_path = bus, pg_temp
as $$
declare
  v_app text := bus.caller_app();
begin
  if p_kind = 'opened' then
    update bus.stalls s
       set opened_sent_at = now()
     where s.id = p_stall_id
       and s.opened_claimed_by = v_app
       and s.opened_sent_at is null;
  elsif p_kind = 'resolved' then
    update bus.stalls s
       set resolved_sent_at = now()
     where s.id = p_stall_id
       and s.resolved_claimed_by = v_app
       and s.resolved_sent_at is null;
  else
    raise exception 'bus.complete_stall_notice: tipo di avviso % non valido (opened, resolved)', p_kind
      using errcode = 'invalid_parameter_value';
  end if;
  if not found then
    raise exception 'bus.complete_stall_notice: avviso % del blocco % non preso in carico dall''app %', p_kind, p_stall_id, v_app
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$$;

-- Invio fallito: la presa in carico torna libera e le app vengono avvisate.
create or replace function bus.release_stall_notice(p_stall_id bigint, p_kind text)
  returns void
  language plpgsql
  security definer
  set search_path = bus, pg_temp
as $$
declare
  v_app text := bus.caller_app();
begin
  if p_kind = 'opened' then
    update bus.stalls s
       set opened_claimed_by = null,
           opened_claimed_at = null
     where s.id = p_stall_id
       and s.opened_claimed_by = v_app
       and s.opened_sent_at is null;
  elsif p_kind = 'resolved' then
    update bus.stalls s
       set resolved_claimed_by = null,
           resolved_claimed_at = null
     where s.id = p_stall_id
       and s.resolved_claimed_by = v_app
       and s.resolved_sent_at is null;
  else
    raise exception 'bus.release_stall_notice: tipo di avviso % non valido (opened, resolved)', p_kind
      using errcode = 'invalid_parameter_value';
  end if;
  if not found then
    raise exception 'bus.release_stall_notice: avviso % del blocco % non preso in carico dall''app %', p_kind, p_stall_id, v_app
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  perform pg_notify('bus_stalls', '');
end
$$;

-- Pulizia notturna (job pg_cron, 0004): messaggi con tutte le consegne concluse, o senza consegne, piu'
-- vecchi dei giorni di conservazione dell'argomento. Solo per l'amministratore.
create or replace function bus.cleanup()
  returns integer
  language plpgsql
  security definer
  set search_path = bus, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from bus.messages m
   using bus.topics t
   where t.name = m.topic
     and m.published_at < now() - make_interval(days => t.retention_days)
     and not exists (select 1 from bus.deliveries d where d.message_id = m.id and d.status <> 'done');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

-- Permessi ----------------------------------------------------------------------------------------

revoke all on schema bus from public;
revoke all on all tables in schema bus from public;
revoke all on all sequences in schema bus from public;
revoke all on all functions in schema bus from public;

grant usage on schema bus to ct_app, cs_account, cl_app;
grant execute on function
  bus.publish(text, integer, uuid, text, bigint, jsonb, timestamptz, uuid),
  bus.next(),
  bus.ack(uuid),
  bus.fail(uuid, text, boolean),
  bus.status(),
  bus.stall_notices(),
  bus.claim_stall_notice(bigint, text),
  bus.complete_stall_notice(bigint, text),
  bus.release_stall_notice(bigint, text)
to ct_app, cs_account, cl_app;

comment on schema bus is 'Bus di messaggi tra le app ComfortService (ADR-0014 §14.7): solo tramite le funzioni pubbliche.';
comment on function bus.publish(text, integer, uuid, text, bigint, jsonb, timestamptz, uuid) is
  'Pubblica una versione di un argomento nella transazione del chiamante: messaggio e consegne agli iscritti a quella versione (nessun iscritto: nulla, restituisce null), avviso al commit, blocchi di tipo backlog.';
comment on function bus.next() is
  'Prossima consegna dovuta dell''app chiamante con la versione del contratto, bloccata (FOR UPDATE SKIP LOCKED), in ordine per entity_ref.';
comment on function bus.ack(uuid) is
  'Conferma nella transazione dell''effetto; cancella il payload sensibile a consegne concluse; chiude i blocchi risolti.';
comment on function bus.fail(uuid, text, boolean) is
  'Fallimento: retry a 10 s, 1 min, 5 min, 30 min, poi 1 h; dead al decimo tentativo o se permanente; blocchi failing e dead.';
comment on function bus.status() is 'Per app: consegne in attesa, fallite, morte, piu'' vecchia, prossimo retry, blocco aperto.';
comment on function bus.stall_notices() is 'Avvisi email dei blocchi da inviare (opened, resolved).';
comment on function bus.claim_stall_notice(bigint, text) is 'Presa in carico atomica di un avviso email: una sola app riceve la riga.';
comment on function bus.complete_stall_notice(bigint, text) is 'Email inviata dall''app che ha preso in carico l''avviso.';
comment on function bus.release_stall_notice(bigint, text) is 'Invio fallito: rilascia la presa in carico e avvisa le app.';
comment on function bus.cleanup() is 'Pulizia notturna (pg_cron): messaggi conclusi oltre i giorni di conservazione.';

reset role;
