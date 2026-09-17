'use strict'

/**
 * Oggetti delle prove tecniche: prefisso `probe_` e nomi FISSI.
 *
 * - `precheck`: se nel database esiste gia' QUALUNQUE oggetto `probe_%` le prove si fermano: non e'
 *   stato creato da questa esecuzione e non si tocca.
 * - `setup`: una transazione con `lock_timeout` breve, per non attendere mai su oggetti altrui.
 * - `cleanup`: elimina SOLO i nomi fissi, schemi senza CASCADE. Idempotente e utilizzabile anche
 *   dopo un crash.
 * - `checkLeftovers`: cerca qualunque `probe_%` rimasto e le sessioni di ruoli eliminati.
 *
 * Le password dei ruoli sono casuali e restano in memoria: al server arriva solo il verificatore
 * SCRAM, cosi' la password in chiaro non finisce nei log delle istruzioni.
 */
const { randomBytes } = require('node:crypto')
const { setTimeout: sleep } = require('node:timers/promises')
const { scramVerifier } = require('../runner/scram')

const ROLE_A = 'probe_user_a'
const ROLE_B = 'probe_user_b'
const ROLES = [ROLE_A, ROLE_B]
const CHANNEL = 'probe_bus_a'

const SESSION_DRAIN_MS = 15000

const LOCAL_TIMEOUTS = `
  set local lock_timeout = '5s';
  set local statement_timeout = '30s';`

const newPassword = () => randomBytes(24).toString('hex')

async function inTransaction(client, sql) {
  await client.query('begin')
  try {
    await client.query(sql)
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }
}

/** Oggetti `probe_%` nel database; con `orphans` anche le sessioni di ruoli non piu' esistenti. */
async function findProbeObjects(client, { orphans }) {
  const { rows } = await client.query(`
    select 'ruolo' as kind, rolname::text as name from pg_roles where rolname like 'probe\\_%'
    union all
    select 'schema', nspname::text from pg_namespace where nspname like 'probe\\_%'
    union all
    select 'relazione', n.nspname || '.' || c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relname like 'probe\\_%'
    union all
    select 'funzione', n.nspname || '.' || p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname like 'probe\\_%'
    union all
    select 'tipo', n.nspname || '.' || t.typname
      from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname like 'probe\\_%'
    union all
    select 'impostazione di ruolo', r.rolname::text
      from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname like 'probe\\_%'
    union all
    select 'sessione', usename::text || ' pid ' || pid from pg_stat_activity where usename like 'probe\\_%'
    union all
    select 'sessione di ruolo eliminato', 'pid ' || pid
      from pg_stat_activity a
     where ${orphans ? 'true' : 'false'}
       and a.usesysid is not null
       and not exists (select 1 from pg_roles r where r.oid = a.usesysid)
    order by 1, 2`)
  return rows
}

const listObjects = (rows) => rows.map((row) => `${row.kind} ${row.name}`).join('; ')

async function precheck(ctx) {
  const { rows: [admin] } = await ctx.admin.query(
    "select rolsuper or pg_has_role(current_user, 'pg_signal_backend', 'USAGE') as can_signal from pg_roles where rolname = current_user"
  )
  if (!admin.can_signal) {
    throw new Error(
      'Prove non avviate: l\'amministratore non ha pg_signal_backend e non potrebbe terminare le ' +
        'connessioni dei ruoli di prova tenute aperte dal pooler.'
    )
  }
  const rows = await findProbeObjects(ctx.admin, { orphans: false })
  if (rows.length) {
    throw new Error(
      `Esistono gia' oggetti probe_ (${listObjects(rows)}). Le prove si fermano senza toccarli. ` +
        'Se sono residui di una prova precedente, usa il comando cleanup.'
    )
  }
  ctx.report.ok('P.1', 'nessun oggetto probe_ presente prima della prova')
}

async function setup(ctx) {
  const { admin } = ctx
  for (const role of ROLES) ctx.passwords.set(role, newPassword())
  const verifier = (role) => admin.escapeLiteral(scramVerifier(ctx.passwords.get(role)))

  await inTransaction(admin, `${LOCAL_TIMEOUTS}
    create role ${ROLE_A} login password ${verifier(ROLE_A)};
    create role ${ROLE_B} login password ${verifier(ROLE_B)};
    alter role ${ROLE_A} set search_path = probe_a, extensions;
    alter role ${ROLE_B} set search_path = probe_b, extensions;

    create schema probe_a;
    create schema probe_b;
    create table probe_a.probe_marker (name text not null);
    insert into probe_a.probe_marker (name) values ('a');
    create table probe_b.probe_marker (name text not null);
    insert into probe_b.probe_marker (name) values ('b');
    create table probe_a.probe_queue (
      id bigint generated always as identity primary key,
      payload text not null
    );

    create function probe_a.probe_whoami()
      returns table (session_user_name text, current_user_name text)
      language sql stable security definer
      set search_path = probe_a, pg_temp
      as $$ select session_user::text, current_user::text $$;

    -- Stessa forma di bus.publish: riga e avviso nella transazione del chiamante.
    create function probe_a.probe_publish(p_payload text)
      returns bigint
      language plpgsql security definer
      set search_path = probe_a, pg_temp
      as $$
    declare
      v_id bigint;
    begin
      insert into probe_queue (payload) values (p_payload) returning id into v_id;
      perform pg_notify('${CHANNEL}', p_payload);
      return v_id;
    end
    $$;

    revoke all on function probe_a.probe_whoami() from public;
    revoke all on function probe_a.probe_publish(text) from public;
    grant usage on schema probe_a to ${ROLE_A};
    grant select on probe_a.probe_marker to ${ROLE_A};
    grant select, delete on probe_a.probe_queue to ${ROLE_A};
    grant execute on function probe_a.probe_whoami(), probe_a.probe_publish(text) to ${ROLE_A};
    grant usage on schema probe_b to ${ROLE_B};
    grant select on probe_b.probe_marker to ${ROLE_B};`)

  const { rows } = await admin.query('select current_user::text as name')
  ctx.owner = rows[0].name
  ctx.report.ok('P.3', `oggetti di prova creati: ruoli ${ROLES.join(', ')}; schemi probe_a, probe_b; proprietario ${ctx.owner}`)
}

async function sessionCount(admin, role) {
  const { rows } = await admin.query(
    `select count(*)::int as n from pg_stat_activity where usename = ${admin.escapeLiteral(role)}`
  )
  return rows[0].n
}

/**
 * Toglie il login a un ruolo di prova e ne termina le sessioni residue. L'ordine conta: il pooler
 * (Supavisor) riapre subito le connessioni terminate di un utente, quindi prima `NOLOGIN`, poi la
 * terminazione. Serve un amministratore con `pg_signal_backend` (verificato da `precheck`).
 */
async function stopSessions(ctx, role) {
  const { admin, report } = ctx
  const lit = admin.escapeLiteral(role)
  await admin.query(`alter role ${role} nologin`)
  const { rows } = await admin.query(
    `select count(*) filter (where pg_terminate_backend(pid))::int as n from pg_stat_activity where usename = ${lit}`
  )
  if (rows[0].n) report.info('C', `${role}: login disattivato, ${rows[0].n} sessioni residue terminate`)

  const deadline = Date.now() + SESSION_DRAIN_MS
  let left = await sessionCount(admin, role)
  while (left > 0 && Date.now() < deadline) {
    await sleep(500)
    left = await sessionCount(admin, role)
  }
  if (left > 0) throw new Error(`${role}: ${left} sessioni ancora attive dopo ${SESSION_DRAIN_MS} ms`)
}

async function cleanup(ctx) {
  const { admin, report } = ctx
  await ctx.closeClients()
  const { rows } = await admin.query(
    `select rolname::text as name from pg_roles where rolname in (${ROLES.map((r) => admin.escapeLiteral(r)).join(', ')}) order by 1`
  )
  for (const { name } of rows) await stopSessions(ctx, name)

  await inTransaction(admin, `${LOCAL_TIMEOUTS}
    drop function if exists probe_a.probe_publish(text);
    drop function if exists probe_a.probe_whoami();
    drop table if exists probe_a.probe_queue;
    drop table if exists probe_a.probe_marker;
    drop table if exists probe_b.probe_marker;
    drop schema if exists probe_a;
    drop schema if exists probe_b;
    drop role if exists ${ROLE_A};
    drop role if exists ${ROLE_B};`)
  report.ok('C', `pulizia eseguita (ruoli trovati: ${rows.map((r) => r.name).join(', ') || 'nessuno'})`)
}

async function checkLeftovers(ctx) {
  const rows = await findProbeObjects(ctx.admin, { orphans: true })
  ctx.report.check(
    rows.length === 0,
    'R',
    rows.length
      ? `residui: ${listObjects(rows)}`
      : 'nessun residuo: 0 ruoli, schemi, relazioni, funzioni, tipi, impostazioni e sessioni probe_; 0 sessioni di ruoli eliminati'
  )
  return rows
}

module.exports = {
  ROLE_A,
  ROLE_B,
  ROLES,
  CHANNEL,
  scramVerifier,
  findProbeObjects,
  precheck,
  setup,
  cleanup,
  checkLeftovers
}
