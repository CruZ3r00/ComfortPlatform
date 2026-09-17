-- 0007 - Schema account dell'account ComfortService (ADR-0014 §14.1-14.2, ADR-0013 §13.1-13.2).
--
-- Lo schema appartiene a cs_account: le migration dell'account (ComfortService, `backend/migrations/account/`),
-- eseguite con il suo utente, creano e modificano le proprie tabelle. La piattaforma crea solo lo schema e fissa i
-- permessi di partenza:
-- - nessun permesso a PUBLIC sullo schema: le altre app, e il sito ComfortService con cs_site, non lo vedono;
-- - le funzioni nuove di cs_account non sono eseguibili da PUBLIC. L'account non usa il realtime di Supabase ne'
--   policy per `authenticated`, quindi nessuna funzione deve essere pubblica;
-- - RLS sulle tabelle e revoca di anon e authenticated: le fanno le migration dell'account (ADR-0014 §14.2), qui non
--   ci sono tabelle.
-- USAGE sullo schema bus ed EXECUTE sulle sue funzioni pubbliche arrivano da 0003; search_path e statement_timeout
-- di cs_account da 0002.
--
-- L'amministratore riceve cs_account con SET (serve per AUTHORIZATION e per agire come proprietario con
-- `set local role`) ma senza INHERIT: non eredita i permessi su credenziali e sessioni.
--
-- Idempotente; se esiste gia' uno schema account di un altro proprietario la migrazione si ferma.

do $$
declare
  v_owner text;
begin
  execute format('grant cs_account to %I with inherit false, set true', current_user);

  select nspowner::regrole::text into v_owner from pg_namespace where nspname = 'account';
  if v_owner is not null and v_owner <> 'cs_account' then
    raise exception 'Lo schema account esiste gia'' con proprietario %: migrazione fermata.', v_owner
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'Verifica chi lo ha creato prima di assegnarlo all''account ComfortService.';
  end if;
end
$$;

create schema if not exists account authorization cs_account;

-- Permessi, default privileges e commento spettano al proprietario: senza INHERIT l'amministratore li
-- esegue come cs_account.
set local role cs_account;

alter default privileges for role cs_account revoke execute on functions from public;

revoke all on schema account from public;

comment on schema account is 'Account ComfortService (ADR-0013): tabelle di proprieta'' di cs_account, create dalle sue migration.';

reset role;
