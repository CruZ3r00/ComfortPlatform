'use strict'

// 0008-0009 (ADR-0014 §14.1-14.4): ComforTables da public a tables, public al sito, rollback. Sulla struttura reale di
// staging del 2026-09-17 (tests/fixtures), con un amministratore non superutente e i ruoli di Supabase simulati.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { MIGRATIONS_DIR, newPassword, startPostgres } = require('../testing')
const { apply } = require('../db/runner/runner')
const { setLogin } = require('../db/runner/roles')
const { applyRollback } = require('../db/rollback/apply')
const { catalog, migrationsUpTo, stagingBeforePhase1 } = require('./helpers/comfortables')

const ROLLBACK = path.join(__dirname, '..', 'db', 'rollback', '0009-0008_comfortables_tables_schema.sql')
const sql = (name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')
const denied = { code: '42501' }

async function inTransaction(client, text) {
  await client.query('begin')
  try {
    await client.query(text)
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  }
}

/** Utente applicativo con login, per le prove come ComforTables e come le altre app. */
async function connectAs(server, db, admin, role) {
  const password = newPassword()
  await setLogin({ client: admin, role, password })
  return server.connect({ ...server.connection, database: db.name, user: role, password })
}

test('0008-0009 su staging: ComforTables in tables di ct_app, public a cs_site; funzioni, trigger, realtime, permessi', async (t) => {
  const server = await startPostgres()
  t.after(() => server.stop())
  const { db, admin, superuser } = await stagingBeforePhase1(t, server)
  const before = await catalog(superuser, 'public')
  assert.equal(before.relations.filter((r) => r.kind === 'r').length, 160)
  assert.equal(before.functions.length, 21)
  // Permessi residui (su staging oggi non ce ne sono): 0008 toglie quelli dell'API REST, 0009 quelli di PUBLIC.
  await admin.query('grant select on public.up_users to anon, authenticated')
  await admin.query('grant usage on schema public to public')

  assert.deepEqual((await apply({ client: admin, dir: MIGRATIONS_DIR })).applied, ['0008_comfortables_tables_schema.sql', '0009_site_public_schema.sql', '0010_comfortables_bus_subscriptions.sql'])
  const after = await catalog(superuser, 'tables')
  const publicAfter = await catalog(superuser, 'public')

  // public: vuoto, di cs_site, nessun permesso oltre al proprietario.
  assert.deepEqual([publicAfter.relations, publicAfter.functions], [[], []])
  assert.deepEqual(publicAfter.schema, [{ owner: 'cs_site', acl: 'cs_site=UC/cs_site' }])

  // tables: stessi oggetti di prima, tutti di ct_app, RLS ovunque.
  assert.deepEqual(after.schema, [{ owner: 'ct_app', acl: 'authenticated=U/ct_app,ct_app=UC/ct_app' }])
  assert.deepEqual(after.relations.map((r) => [r.name, r.kind]), before.relations.map((r) => [r.name, r.kind]))
  assert.deepEqual([...new Set(after.relations.map((r) => r.owner))], ['ct_app'])
  assert.deepEqual(after.relations.filter((r) => r.kind === 'r' && !r.rls).map((r) => r.name), [])
  assert.deepEqual(after.triggers, before.triggers)
  assert.deepEqual(after.policies.map(({ tablename, policyname, roles, cmd, qual, with_check }) => [tablename, policyname, roles, cmd, qual, with_check]),
    before.policies.map(({ tablename, policyname, roles, cmd, qual, with_check }) => [tablename, policyname, roles, cmd, qual, with_check]))
  assert.deepEqual(after.publication, [{ tablename: 'order_realtime_events' }, { tablename: 'table_order_realtime_events' }])

  // Permessi sulle tabelle: authenticated legge solo i due campanelli, anon nulla.
  const privileged = after.relations.filter((r) => r.kind === 'r' && r.acl !== 'ct_app=arwdDxtm/ct_app')
  assert.deepEqual(privileged.map((r) => [r.name, r.acl]), [
    ['order_realtime_events', 'authenticated=r/ct_app,ct_app=arwdDxtm/ct_app'],
    ['table_order_realtime_events', 'authenticated=r/ct_app,ct_app=arwdDxtm/ct_app']
  ])

  // Funzioni: stesse, stessi corpi con tables al posto di public, search_path fissato, non eseguibili da PUBLIC.
  const bodies = await superuser.query(
    "select proname::text as name, prosrc from pg_proc where pronamespace in ('tables'::regnamespace) order by proname"
  )
  for (const fn of after.functions) {
    assert.equal(fn.owner, 'ct_app', fn.name)
    assert.deepEqual(fn.proconfig, ['search_path=tables, extensions'], fn.name)
    assert.equal(fn.acl, 'ct_app=X/ct_app', fn.name)
    const original = before.functions.find((f) => f.name === fn.name)
    assert.equal(fn.definer, original.definer, fn.name)
    assert.equal(fn.args, original.args.replace('up_users', 'tables.up_users'), fn.name)
  }
  assert.deepEqual(bodies.rows.filter((r) => /public/.test(r.prosrc)).map((r) => r.name), [])

  // ComforTables come ct_app: schema predefinito, funzioni SQL e plpgsql, trigger del realtime.
  const ct = await connectAs(server, db, admin, 'ct_app')
  assert.equal((await ct.query("select classify_staff_role_for_category('Vini e birre') as r")).rows[0].r, 'bar')
  assert.equal((await ct.query("select owner_has_feature(999999, 'production.department_routing') as r")).rows[0].r, false)
  await ct.query('begin')
  const { rows: [owner] } = await ct.query('insert into up_users default values returning id')
  const { rows: [order] } = await ct.query('insert into orders default values returning id')
  await ct.query('insert into orders_fk_user_lnk (order_id, user_id) values ($1, $2)', [order.id, owner.id])
  const { rows: events } = await ct.query('select user_id, source_table, event_type from tables.order_realtime_events')
  await ct.query('rollback')
  assert.deepEqual(events, [{ user_id: owner.id, source_table: 'orders_fk_user_lnk', event_type: 'INSERT' }])

  // Le altre app e l'amministratore non leggono ComforTables; ct_app non entra nel sito.
  for (const role of ['cs_site', 'cs_account', 'cl_app']) {
    const client = await connectAs(server, db, admin, role)
    await assert.rejects(client.query('select 1 from tables.up_users limit 1'), denied, role)
  }
  await assert.rejects(admin.query('select 1 from tables.up_users limit 1'), denied)
  await assert.rejects(ct.query('create table public.intrusa (id int)'), denied)
  const cs = await server.connect({ ...server.connection, database: db.name, user: 'cs_site', password: newPassword() }).catch(() => null)
  assert.equal(cs, null, 'password sbagliata rifiutata')
})

test('0008-0009 rieseguite convergono; rollback riporta tutto com\'era e le migrazioni si riapplicano', async (t) => {
  const server = await startPostgres()
  t.after(() => server.stop())
  const { admin, superuser } = await stagingBeforePhase1(t, server)
  const before = { public: await catalog(superuser, 'public'), tables: await catalog(superuser, 'tables') }
  await apply({ client: admin, dir: MIGRATIONS_DIR })
  const after = { public: await catalog(superuser, 'public'), tables: await catalog(superuser, 'tables') }

  await inTransaction(admin, sql('0008_comfortables_tables_schema.sql'))
  await inTransaction(admin, sql('0009_site_public_schema.sql'))
  assert.deepEqual({ public: await catalog(superuser, 'public'), tables: await catalog(superuser, 'tables') }, after)

  // Prova del rollback: eseguito e annullato, nulla cambia.
  await applyRollback({ client: admin, file: ROLLBACK, commit: false })
  assert.deepEqual({ public: await catalog(superuser, 'public'), tables: await catalog(superuser, 'tables') }, after)

  await applyRollback({ client: admin, file: ROLLBACK })
  assert.deepEqual({ public: await catalog(superuser, 'public'), tables: await catalog(superuser, 'tables') }, before)
  // Il rollback toglie dal registro solo 0008 e 0009: le migrazioni successive restano.
  const { rows } = await admin.query('select name from platform.migrations order by name')
  const registered = rows.map((row) => row.name)
  assert.ok(!registered.includes('0008_comfortables_tables_schema.sql'))
  assert.ok(!registered.includes('0009_site_public_schema.sql'))
  assert.ok(registered.includes('0010_comfortables_bus_subscriptions.sql'))

  // Con una migrazione successiva gia' applicata il registro ha un buco, e il runner si
  // **ferma** invece di riapplicare fuori ordine: questo rollback va eseguito prima delle
  // migrazioni che lo seguono, oppure annullando anche quelle.
  await assert.rejects(apply({ client: admin, dir: MIGRATIONS_DIR }), /ordine per nome violato/)
  await admin.query("delete from platform.migrations where name = '0010_comfortables_bus_subscriptions.sql'")
  const { rows: memberships } = await superuser.query(
    `select r.rolname::text as role, a.inherit_option from pg_auth_members a join pg_roles r on r.oid = a.roleid
      where a.member = $1::regrole and a.set_option and r.rolname in ('ct_app', 'cs_site') order by 1`,
    [server.admin.user]
  )
  assert.deepEqual(memberships, [{ role: 'cs_site', inherit_option: false }, { role: 'ct_app', inherit_option: false }])

  assert.deepEqual((await apply({ client: admin, dir: MIGRATIONS_DIR })).applied, ['0008_comfortables_tables_schema.sql', '0009_site_public_schema.sql', '0010_comfortables_bus_subscriptions.sql'])
  assert.deepEqual({ public: await catalog(superuser, 'public'), tables: await catalog(superuser, 'tables') }, after)

  // Con il sito gia' copiato in public il rollback si ferma senza toccare nulla.
  await superuser.query('create table public.pages (id int primary key); alter table public.pages owner to cs_site')
  await assert.rejects(applyRollback({ client: admin, file: ROLLBACK }), /In public ci sono gia' oggetti \(il sito\?\): rollback fermato/)
  assert.deepEqual((await catalog(superuser, 'tables')).relations, after.tables.relations)
})

test('0008: stato di ComforTables incompleto (una tabella mancante) → stop, nulla spostato', async (t) => {
  const server = await startPostgres()
  t.after(() => server.stop())
  const { admin, superuser } = await stagingBeforePhase1(t, server)
  await admin.query('drop table public.audit_hardware_events')
  await assert.rejects(apply({ client: admin, dir: MIGRATIONS_DIR }), (err) => {
    assert.equal(err.code, 'MIGRATION_FAILED')
    assert.match(err.message, /^0008_comfortables_tables_schema\.sql fallita.*: Stato di ComforTables non previsto: tabelle in public 159, in tables 0; funzioni in public 21, in tables 0\. Migrazione fermata\. \(SQLSTATE 55000\)/)
    return true
  })
  const state = await catalog(superuser, 'public')
  assert.equal(state.relations.filter((r) => r.kind === 'r').length, 159)
  assert.deepEqual([...new Set(state.relations.map((r) => r.owner))], [server.admin.user])
  assert.deepEqual((await catalog(superuser, 'tables')).schema, [])
})

test('0008 con uno schema tables di un altro proprietario, 0009 con oggetti estranei in public: stop', async (t) => {
  const server = await startPostgres()
  t.after(() => server.stop())
  const db = server.database(server.cronDatabase)
  const root = await db.connect()
  const admin = await db.connectAdmin()
  await apply({ client: admin, dir: migrationsUpTo(t, '0007_account_schema.sql') })

  await root.query('create schema tables')
  await assert.rejects(apply({ client: admin, dir: MIGRATIONS_DIR }), /0008_comfortables_tables_schema\.sql fallita.*: Lo schema tables esiste gia' con proprietario postgres: migrazione fermata\. \(SQLSTATE 55000\)/)
  await root.query('drop schema tables')

  await admin.query('create table public.intrusa (id int)')
  await assert.rejects(apply({ client: admin, dir: MIGRATIONS_DIR }), /0009_site_public_schema\.sql fallita.*: In public ci sono 1 oggetti che non appartengono a cs_site: migrazione fermata\. \(SQLSTATE 55000\)/)
  const { rows } = await root.query("select nspowner::regrole::text as owner from pg_namespace where nspname = 'public'")
  assert.equal(rows[0].owner, server.admin.user)
  const { rows: registry } = await admin.query('select name from platform.migrations order by name desc limit 1')
  assert.equal(registry[0].name, '0008_comfortables_tables_schema.sql')
})
