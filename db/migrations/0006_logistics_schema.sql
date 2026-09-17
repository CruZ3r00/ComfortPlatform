-- 0006 - Schema logistics di ComfortLogistics (ADR-0014 §14.1-14.2, ADR-0015 §15.1).
--
-- Lo schema appartiene a cl_app: le migration di ComfortLogistics, eseguite con il suo utente, creano e
-- modificano le proprie tabelle. La piattaforma crea solo lo schema e fissa i permessi di partenza:
-- - nessun permesso a PUBLIC sullo schema: le altre app non lo vedono;
-- - le funzioni nuove di cl_app non sono eseguibili da PUBLIC. ComfortLogistics non usa il realtime di
--   Supabase ne' policy per `authenticated`, quindi nessuna funzione deve essere pubblica;
-- - RLS sulle tabelle: la attivano le migration di ComfortLogistics (ADR-0014 §14.2), qui non ci sono tabelle.
--
-- L'amministratore riceve cl_app con SET (serve per AUTHORIZATION e per agire come proprietario con
-- `set local role`) ma senza INHERIT: non eredita i permessi sui dati di ComfortLogistics.
--
-- Idempotente; se esiste gia' uno schema logistics di un altro proprietario la migrazione si ferma.

do $$
declare
  v_owner text;
begin
  execute format('grant cl_app to %I with inherit false, set true', current_user);

  select nspowner::regrole::text into v_owner from pg_namespace where nspname = 'logistics';
  if v_owner is not null and v_owner <> 'cl_app' then
    raise exception 'Lo schema logistics esiste gia'' con proprietario %: migrazione fermata.', v_owner
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'Verifica chi lo ha creato prima di assegnarlo a ComfortLogistics.';
  end if;
end
$$;

create schema if not exists logistics authorization cl_app;

-- Permessi, default privileges e commento spettano al proprietario: senza INHERIT l'amministratore li
-- esegue come cl_app.
set local role cl_app;

alter default privileges for role cl_app revoke execute on functions from public;

revoke all on schema logistics from public;

comment on schema logistics is 'ComfortLogistics (ADR-0015): tabelle di proprieta'' di cl_app, create dalle sue migration.';

reset role;
