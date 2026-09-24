-- 0012 - Rigioco delle consegne scartate (ADR-0014 §14.7, §14.9).
--
-- Una consegna `dead` non e' conclusa: blocca le successive della stessa entita' (`next` salta tutto cio' che ha
-- davanti un messaggio non `done`) e tiene aperto il blocco dell'app. L'intestazione di 0003 lo dice («finche' non
-- viene rispedita o scartata»), ma nessuna funzione la rispediva: serviva SQL a mano. E' successo il 2026-09-23,
-- quando il consumatore di ComforTables riceveva i payload come testo e scartava ogni messaggio.
--
-- `bus.replay` riporta a `pending` le consegne `dead` di un'app, o di un solo messaggio: tentativi a zero, subito
-- dovute, ultimo errore conservato per la storia. L'avviso `bus_<app>` sveglia il consumatore. Il blocco non si
-- tocca: lo chiude il primo `ack` che non lascia consegne scadute, fallite o morte, come sempre.
--
-- Solo l'amministratore: di platform_admin, nessun permesso alle app, niente SECURITY DEFINER. Da usare dopo aver
-- corretto la causa, altrimenti la consegna torna `dead`.

set local role platform_admin;

create or replace function bus.replay(p_app text, p_message_id uuid default null)
  returns table (message_id uuid, topic text, entity_ref text, attempts integer, last_error text)
  language plpgsql
  set search_path = bus, pg_temp
as $$
#variable_conflict use_column
begin
  if not exists (select 1 from bus.apps a where a.code = p_app) then
    raise exception 'bus.replay: app % sconosciuta', p_app using errcode = 'invalid_parameter_value';
  end if;

  return query
  with target as (
    select d.message_id, d.attempts
      from bus.deliveries d
     where d.app = p_app
       and d.status = 'dead'
       and (p_message_id is null or d.message_id = p_message_id)
       for update
  ),
  replayed as (
    update bus.deliveries d
       set status = 'pending',
           attempts = 0,
           next_attempt_at = now()
      from target t
     where d.message_id = t.message_id
       and d.app = p_app
    returning d.message_id, t.attempts, d.last_error
  )
  select r.message_id, m.topic, m.entity_ref, r.attempts, r.last_error
    from replayed r
    join bus.messages m on m.id = r.message_id
   order by m.seq;

  if found then
    perform pg_notify('bus_' || p_app, '');
  end if;
end
$$;

revoke all on function bus.replay(text, uuid) from public;

comment on function bus.replay(text, uuid) is
  'Amministratore: consegne dead di un''app (o di un messaggio) di nuovo pending, tentativi a zero; avviso all''app. Restituisce le consegne rigiocate.';
