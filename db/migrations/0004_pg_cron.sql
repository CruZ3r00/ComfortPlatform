-- 0004 - Pianificazioni pg_cron del bus (ADR-0014 §14.7 «Pianificazioni interne», §4.5).
--
-- - pulizia notturna dei messaggi conclusi (`bus.cleanup()`);
-- - alle 02:00 UTC, pubblicazione di `platform.clock.daily` per i lavori giornalieri delle app.
--
-- Separata da 0003: senza pg_cron il bus funziona comunque, e questa migrazione si ferma con un errore
-- esplicito prima di creare qualsiasi cosa.
--
-- I job girano come l'utente che li pianifica, cioe' l'amministratore che applica le migrazioni
-- (`postgres` su Supabase): pg_cron non consente a un non superutente di pianificare job per altri
-- utenti, e un ruolo NOLOGIN come platform_admin non potrebbe eseguirli. Per questo le istruzioni
-- `cron.schedule` stanno fuori da `set role`. Il job dell'orologio pubblica come app `platform`
-- (0003: `bus.apps` associa `platform` all'amministratore), con identita' da `session_user`.
--
-- Su Supabase `create extension pg_cron` passa da supautils (estensione privilegiata) e l'event trigger
-- `issue_pg_cron_access` concede a `postgres` l'uso dello schema `cron`. Nei test locali l'estensione
-- esiste gia' (harness): qui non fa nulla.
--
-- Idempotente: `cron.schedule` con lo stesso nome aggiorna il job; argomento, versione e iscrizione con
-- `on conflict do nothing` (un'iscrizione gia' passata a un'altra versione non torna indietro).

do $$
declare
  v_preload text;
  v_cron_database text;
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise exception 'pg_cron non disponibile: l''estensione non e'' installata sul server.'
      using errcode = 'feature_not_supported',
            hint = 'Su Supabase e'' sempre disponibile; in locale installa il pacchetto postgresql-17-cron.';
  end if;

  begin
    v_preload := current_setting('shared_preload_libraries');
    v_cron_database := current_setting('cron.database_name', true);
  exception when insufficient_privilege then
    raise exception 'pg_cron non verificabile: l''utente % non puo'' leggere shared_preload_libraries e cron.database_name.', current_user
      using errcode = 'insufficient_privilege',
            hint = 'Serve pg_read_all_settings (su Supabase l''utente postgres lo ha).';
  end;

  if not 'pg_cron' = any (string_to_array(replace(v_preload, ' ', ''), ',')) then
    raise exception 'pg_cron non disponibile: non e'' caricata (shared_preload_libraries = "%").', v_preload
      using errcode = 'feature_not_supported',
            hint = 'Aggiungi pg_cron a shared_preload_libraries e riavvia il server.';
  end if;

  if v_cron_database is distinct from current_database() then
    raise exception 'pg_cron non disponibile in questo database: esegue i job nel database "%", non in "%".',
                    coalesce(v_cron_database, '(non impostato)'), current_database()
      using errcode = 'feature_not_supported',
            hint = 'Applica le migrazioni di piattaforma nel database indicato da cron.database_name.';
  end if;
end
$$;

create extension if not exists pg_cron;

do $$
begin
  if not has_schema_privilege('cron', 'USAGE') then
    raise exception 'pg_cron non utilizzabile: l''utente % non ha USAGE sullo schema cron.', current_user
      using errcode = 'insufficient_privilege',
            hint = 'Su Supabase lo concede l''event trigger issue_pg_cron_access alla creazione dell''estensione.';
  end if;
end
$$;

-- Argomento dell'orologio giornaliero (piano 0007 §3.10.4): pg_cron -> ComfortLogistics, versione 1.
insert into bus.topics (name, producer, sensitive, retention_days)
values ('platform.clock.daily', 'platform', false, 30)
on conflict (name) do nothing;

insert into bus.topic_versions (topic, schema_version)
values ('platform.clock.daily', 1)
on conflict (topic, schema_version) do nothing;

insert into bus.subscriptions (app, topic, schema_version)
values ('logistics', 'platform.clock.daily', 1)
on conflict (app, topic) do nothing;

-- Orari in GMT, il default di pg_cron (`cron.timezone`).
select cron.schedule('bus-cleanup', '30 3 * * *', 'select bus.cleanup()');

select cron.schedule(
  'platform-clock-daily',
  '0 2 * * *',
  $job$select bus.publish('platform.clock.daily', 1, null, null, null, jsonb_build_object('date', (now() at time zone 'UTC')::date), now(), null)$job$
);
