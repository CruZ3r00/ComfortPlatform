-- 0009 - Schema public al sito ComfortService (ADR-0014 §14.1, §14.4).
--
-- Dopo 0008 in `public` non resta nulla di ComforTables: lo schema passa a cs_site. Le tabelle del sito le creano le
-- migration del sito eseguite come cs_site (con RLS), le righe arrivano con la copia una tantum (data-migrations/site-copy).
-- - nessun permesso a PUBLIC sullo schema; le funzioni nuove di cs_site non sono eseguibili da PUBLIC;
-- - anon, authenticated e service_role (API REST di Supabase, da spegnere: ADR-0014 §14.2) senza permessi sullo schema.
--
-- L'amministratore riceve cs_site con SET senza INHERIT, come per gli altri utenti applicativi.
-- Si ferma se in public c'e' ancora qualcosa che non e' di cs_site (per esempio ComforTables non spostato, o una
-- tabella di ComforTables nata dopo l'elenco di 0008). Idempotente.
-- Rollback insieme a 0008: db/rollback/0009-0008_comfortables_tables_schema.sql.

do $$
declare
  v_foreign int;
begin
  execute format('grant cs_site to %I with inherit false, set true', current_user);

  select (select count(*) from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relowner <> 'cs_site'::regrole
             and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'))
       + (select count(*) from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proowner <> 'cs_site'::regrole
             and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'))
    into v_foreign;
  if v_foreign > 0 then
    raise exception 'In public ci sono % oggetti che non appartengono a cs_site: migrazione fermata.', v_foreign
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'ComforTables e'' stato spostato in tables (0008)? Controlla che cosa resta in public.';
  end if;

  if (select nspowner from pg_namespace where nspname = 'public') <> 'cs_site'::regrole then
    execute 'alter schema public owner to cs_site';
  end if;
end
$$;

set local role cs_site;

alter default privileges for role cs_site revoke execute on functions from public;
revoke all on schema public from public;

do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on schema public from %I', v_role);
    end if;
  end loop;
end
$$;

comment on schema public is 'Sito ComfortService (ADR-0014 §14.1, §14.4): tabelle di proprieta'' di cs_site.';

reset role;
