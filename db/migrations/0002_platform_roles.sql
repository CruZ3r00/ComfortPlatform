-- 0002 - Utenti Postgres della piattaforma (ADR-0014 §14.1, §14.2, §14.3 «Utenti Postgres e password»).
--
-- Utenti creati NOLOGIN e SENZA password: su Supabase `log_statement = ddl` scriverebbe nei log il testo
-- di CREATE/ALTER ROLE ... PASSWORD. LOGIN e password si impostano con il runner
-- (`npm run db:role-login`), che invia solo il verificatore SCRAM.
--
-- Eseguibile da un amministratore NON superutente con CREATEROLE (come `postgres` su Supabase):
-- chi crea un ruolo ne riceve l'ADMIN OPTION, e con quella puo' concedersi l'appartenenza a
-- `platform_admin` che serve per cedergli la proprieta' di `platform` e, in 0003, di `bus`.
--
-- Idempotente: un ruolo gia' presente non viene ricreato e il suo LOGIN non cambia (converge anche dopo
-- `db:role-login`); un ruolo gia' presente con attributi da amministratore ferma la migrazione.

do $$
declare
  v_role text;
  v_attrs text;
begin
  foreach v_role in array array['platform_admin', 'ct_app', 'cs_site', 'cs_account', 'cl_app'] loop
    select concat_ws(', ',
             case when rolsuper then 'SUPERUSER' end,
             case when rolcreaterole then 'CREATEROLE' end,
             case when rolcreatedb then 'CREATEDB' end,
             case when rolreplication then 'REPLICATION' end,
             case when rolbypassrls then 'BYPASSRLS' end)
      into v_attrs
      from pg_roles
     where rolname = v_role;

    if not found then
      execute format('create role %I nologin', v_role);
    elsif v_attrs <> '' then
      raise exception 'Il ruolo % esiste gia'' con attributi da amministratore (%): migrazione fermata.', v_role, v_attrs
        using errcode = 'object_not_in_prerequisite_state',
              hint = 'Un utente applicativo o platform_admin non deve avere questi attributi: verifica chi lo ha creato.';
    end if;
  end loop;
end
$$;

-- L'amministratore che applica le migrazioni agisce come platform_admin: SET per creare oggetti a suo
-- nome (`set local role`), INHERIT per leggere e scrivere il registro dopo il passaggio di proprieta'.
do $$
begin
  execute format('grant platform_admin to %I with inherit true, set true', current_user);
end
$$;

-- Schema predefinito per utente (§14.2): vale per ogni connessione, anche sul pooler in modalita'
-- transazione. `public` non entra nel percorso degli altri utenti.
alter role ct_app set search_path = tables, extensions;
alter role cs_site set search_path = public, extensions;
alter role cs_account set search_path = account, extensions;
alter role cl_app set search_path = logistics, extensions;

-- Limite iniziale per utente (§14.2), da tarare in Fase 1.
alter role ct_app set statement_timeout = '60s';
alter role cs_site set statement_timeout = '60s';
alter role cs_account set statement_timeout = '60s';
alter role cl_app set statement_timeout = '60s';

-- Proprieta' dell'infrastruttura di piattaforma (§14.1): schema prima, tabella dopo (il nuovo
-- proprietario della tabella deve avere CREATE sullo schema).
alter schema platform owner to platform_admin;
alter table platform.migrations owner to platform_admin;
alter table platform.migrations enable row level security;

-- Le funzioni nuove di platform_admin non sono eseguibili da PUBLIC: i permessi si danno uno per uno.
alter default privileges for role platform_admin revoke execute on functions from public;

comment on role platform_admin is
  'Proprietario degli schemi platform e bus (ADR-0014 §14.1). NOLOGIN: vi si accede solo con SET ROLE.';
comment on role ct_app is 'ComforTables, schema tables (ADR-0014 §14.1).';
comment on role cs_site is 'Sito ComfortService, schema public (ADR-0014 §14.1).';
comment on role cs_account is 'Account ComfortService, schema account (ADR-0014 §14.1).';
comment on role cl_app is 'ComfortLogistics, schema logistics (ADR-0014 §14.1).';
