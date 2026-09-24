'use strict'

// Migrazioni di piattaforma 0002-0004 applicate da un amministratore NON superutente con CREATEROLE,
// come `postgres` su Supabase (ADR-0014 §14.3), su un cluster con pg_cron precaricata.

const { before, after, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { MIGRATIONS_DIR, newPassword, startPostgres } = require('../testing')
const { waitFor } = require('./helpers/platform')
const { apply, inspect } = require('../db/runner/runner')
const { setLogin } = require('../db/runner/roles')
const { topics: CATALOG } = require('../bus/contract')

const FILES = [
  '0001_platform_registry.sql',
  '0002_platform_roles.sql',
  '0003_bus.sql',
  '0004_pg_cron.sql',
  '0005_bus_contract_v1.sql',
  '0006_logistics_schema.sql',
  '0007_account_schema.sql',
  '0008_comfortables_tables_schema.sql',
  '0009_site_public_schema.sql',
  '0010_comfortables_bus_subscriptions.sql',
  '0011_comfortables_logistics_subscriptions.sql',
  '0012_bus_replay.sql'
]
const PLATFORM_ROLES = ['platform_admin', 'ct_app', 'cs_site', 'cs_account', 'cl_app']
const BUS_APPS = ['ct_app', 'cs_account', 'cl_app']
const APP_ROLES = [...BUS_APPS, 'cs_site']
const PUBLIC_FUNCTIONS = [
  'ack(uuid)',
  'claim_stall_notice(bigint,text)',
  'complete_stall_notice(bigint,text)',
  'fail(uuid,text,boolean)',
  'next()',
  'publish(text,integer,uuid,text,bigint,jsonb,timestamp with time zone,uuid)',
  'release_stall_notice(bigint,text)',
  'stall_notices()',
  'status()'
]
const JOBS = [
  { jobname: 'bus-cleanup', schedule: '30 3 * * *', command: 'select bus.cleanup()' },
  {
    jobname: 'platform-clock-daily',
    schedule: '0 2 * * *',
    command: "select bus.publish('platform.clock.daily', 1, null, null, null, jsonb_build_object('date', (now() at time zone 'UTC')::date), now(), null)"
  }
]

let server
let db
let admin
let superuser

before(async () => {
  server = await startPostgres()
  db = server.database(server.cronDatabase)
  admin = await db.connectAdmin()
  superuser = await db.connect()
})
after(async () => {
  await server?.stop()
})

const sql = (name) => fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')

async function runInTransaction(client, text) {
  await client.query('begin')
  try {
    await client.query(text)
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  }
}

/** Fotografia di tutto cio' che le migrazioni creano: ruoli, permessi, proprieta', job e dati del bus. */
async function snapshot() {
  const query = async (text, params) => (await superuser.query(text, params)).rows
  return {
    roles: await query(
      `select rolname::text, rolcanlogin, rolpassword is null as no_password, rolsuper, rolcreaterole, rolcreatedb,
              rolreplication, rolbypassrls, rolinherit
         from pg_authid where rolname = any($1) order by 1`,
      [PLATFORM_ROLES]
    ),
    settings: await query(
      `select r.rolname::text, s.setdatabase, s.setconfig
         from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
        where r.rolname = any($1) order by 1`,
      [PLATFORM_ROLES]
    ),
    memberships: await query(
      `select r.rolname::text as role, m.rolname::text as member, a.admin_option, a.inherit_option, a.set_option
         from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
        where r.rolname = any($1) order by 1, 2`,
      [PLATFORM_ROLES]
    ),
    schemas: await query(
      "select nspname::text, nspowner::regrole::text, nspacl::text from pg_namespace where nspname in ('account', 'bus', 'logistics', 'platform', 'public', 'tables') order by 1"
    ),
    relations: await query(
      `select c.relname::text, c.relkind::text, c.relowner::regrole::text, c.relacl::text, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('bus', 'platform') order by 1`
    ),
    functions: await query(
      `select p.oid::regprocedure::text as signature, p.proowner::regrole::text, p.prosecdef, p.proconfig, p.proacl::text
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'bus' order by 1`
    ),
    defaultAcl: await query(
      'select defaclrole::regrole::text, defaclnamespace, defaclobjtype::text, defaclacl::text from pg_default_acl order by 1, 3'
    ),
    jobs: await query('select jobname, schedule, command, username, database, active from cron.job order by jobname'),
    apps: await query('select * from bus.apps order by code'),
    topics: await query('select * from bus.topics order by name'),
    topicVersions: await query('select * from bus.topic_versions order by topic, schema_version'),
    subscriptions: await query('select * from bus.subscriptions order by app, topic, schema_version')
  }
}

test('apply come amministratore non superutente: ruoli, proprieta\', permessi, job', async () => {
  const { rows: [who] } = await admin.query('select current_user::text as name, rolsuper from pg_roles where rolname = current_user')
  assert.deepEqual(who, { name: server.admin.user, rolsuper: false })

  const { applied } = await apply({ client: admin, dir: MIGRATIONS_DIR })
  assert.deepEqual(applied, FILES)
  const state = await snapshot()

  // Ruoli NOLOGIN, senza password e senza attributi da amministratore.
  assert.deepEqual(
    state.roles,
    [...PLATFORM_ROLES].sort().map((rolname) => ({
      rolname,
      rolcanlogin: false,
      no_password: true,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      rolinherit: true
    }))
  )
  assert.deepEqual(
    state.settings.map((s) => [s.rolname, s.setdatabase, s.setconfig]),
    [
      ['cl_app', 0, ['search_path=logistics, extensions', 'statement_timeout=60s']],
      ['cs_account', 0, ['search_path=account, extensions', 'statement_timeout=60s']],
      ['cs_site', 0, ['search_path=public, extensions', 'statement_timeout=60s']],
      ['ct_app', 0, ['search_path=tables, extensions', 'statement_timeout=60s']]
    ]
  )
  const adminMembership = state.memberships.find((m) => m.role === 'platform_admin' && m.member === server.admin.user && m.set_option)
  assert.deepEqual(adminMembership, {
    role: 'platform_admin',
    member: server.admin.user,
    admin_option: false,
    inherit_option: true,
    set_option: true
  })

  // Tutto cio' che sta in bus e platform appartiene a platform_admin; RLS su ogni tabella.
  assert.deepEqual(state.schemas.map((s) => [s.nspname, s.nspowner]), [
    ['account', 'cs_account'],
    ['bus', 'platform_admin'],
    ['logistics', 'cl_app'],
    ['platform', 'platform_admin'],
    ['public', 'cs_site'],
    ['tables', 'ct_app']
  ])
  assert.ok(state.relations.length > 10)
  for (const relation of state.relations) {
    assert.equal(relation.relowner, 'platform_admin', relation.relname)
    if (relation.relkind === 'r') assert.equal(relation.relrowsecurity, true, `RLS su ${relation.relname}`)
  }

  // Funzioni: tutte di platform_admin con search_path fissato; SECURITY DEFINER le pubbliche e cleanup.
  const signatures = state.functions.map((f) => f.signature.replace(/^bus\./, ''))
  for (const name of PUBLIC_FUNCTIONS) assert.ok(signatures.includes(name), `manca bus.${name}`)
  for (const fn of state.functions) {
    const name = fn.signature.replace(/^bus\./, '')
    assert.equal(fn.proowner, 'platform_admin', name)
    // proacl nullo vorrebbe dire permessi predefiniti, cioe' EXECUTE a PUBLIC.
    assert.notEqual(fn.proacl, null, `permessi predefiniti su ${name}`)
    assert.deepEqual(fn.proconfig, ['search_path=bus, pg_temp'], name)
    assert.equal(fn.prosecdef, PUBLIC_FUNCTIONS.includes(name) || name === 'cleanup()', `SECURITY DEFINER di ${name}`)
  }

  // Permessi: USAGE su bus ed EXECUTE sulle sole funzioni pubbliche alle tre app del bus; nulla a
  // cs_site; nessun permesso su tabelle, sequenze e schema platform; nulla a PUBLIC.
  const { rows: privileges } = await superuser.query(
    `select r.rolname::text as role,
            has_schema_privilege(r.rolname, 'bus', 'USAGE') as bus_usage,
            has_schema_privilege(r.rolname, 'bus', 'CREATE') as bus_create,
            has_schema_privilege(r.rolname, 'platform', 'USAGE') as platform_usage,
            (select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), '{}')
               from pg_proc p where p.pronamespace = 'bus'::regnamespace
                and has_function_privilege(r.rolname, p.oid, 'EXECUTE')) as executable,
            (select count(*)::int from pg_class c
              where c.relnamespace in ('bus'::regnamespace, 'platform'::regnamespace)
                and case when c.relkind in ('r', 'p') then has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') end) as tables,
            (select count(*)::int from pg_class c
              where c.relnamespace = 'bus'::regnamespace
                and case when c.relkind = 'S' then has_sequence_privilege(r.rolname, c.oid, 'USAGE, SELECT, UPDATE') end) as sequences
       from pg_roles r where r.rolname = any($1) order by 1`,
    [APP_ROLES]
  )
  const publicSignatures = PUBLIC_FUNCTIONS.map((name) => `bus.${name}`).sort()
  for (const row of privileges) {
    const busApp = BUS_APPS.includes(row.role)
    assert.deepEqual(
      row,
      {
        role: row.role,
        bus_usage: busApp,
        bus_create: false,
        platform_usage: false,
        executable: busApp ? publicSignatures : [],
        tables: 0,
        sequences: 0
      },
      row.role
    )
  }
  for (const item of [...state.functions, ...state.relations, ...state.schemas]) {
    const acl = item.proacl ?? item.relacl ?? item.nspacl
    assert.equal(/(^|[{,])=/.test(acl ?? ''), false, `permessi a PUBLIC: ${JSON.stringify(item)}`)
  }

  // App del bus e job pg_cron dell'amministratore.
  assert.deepEqual(state.apps, [
    { code: 'account', role_name: 'cs_account' },
    { code: 'comfortables', role_name: 'ct_app' },
    { code: 'logistics', role_name: 'cl_app' },
    { code: 'platform', role_name: server.admin.user }
  ])
  // Contratto v1: la migrazione registra esattamente il catalogo (bus/contract/catalog.json).
  const byName = (a, b) => a.name.localeCompare(b.name)
  assert.deepEqual(
    state.topics,
    CATALOG.map((t) => ({ name: t.name, producer: t.producer, sensitive: t.sensitive, retention_days: t.retention_days })).sort(byName)
  )
  assert.deepEqual(
    state.topicVersions,
    CATALOG.flatMap((t) => t.versions.map((v) => ({ topic: t.name, schema_version: v }))).sort(
      (a, b) => a.topic.localeCompare(b.topic) || a.schema_version - b.schema_version
    )
  )
  assert.deepEqual(
    state.subscriptions,
    CATALOG.flatMap((t) => t.subscribers.map((s) => ({ app: s.app, topic: t.name, schema_version: s.schema_version }))).sort(
      (a, b) => a.app.localeCompare(b.app) || a.topic.localeCompare(b.topic)
    )
  )
  assert.equal(state.topics.length, 21)

  // Schema logistics: di cl_app, nulla a PUBLIC; l'amministratore ha SET su cl_app ma non ne eredita i permessi.
  const logistics = state.schemas.find((s) => s.nspname === 'logistics')
  assert.equal(/(^|[{,])=/.test(logistics.nspacl ?? ''), false)
  assert.deepEqual(
    state.memberships.find((m) => m.role === 'cl_app' && m.member === server.admin.user && m.set_option),
    { role: 'cl_app', member: server.admin.user, admin_option: false, inherit_option: false, set_option: true }
  )
  // Schema account: di cs_account, nulla a PUBLIC (schema e funzioni future); l'amministratore ha SET su cs_account
  // ma non ne eredita i permessi (credenziali e sessioni).
  const account = state.schemas.find((s) => s.nspname === 'account')
  assert.equal(/(^|[{,])=/.test(account.nspacl ?? ''), false)
  assert.deepEqual(
    state.memberships.find((m) => m.role === 'cs_account' && m.member === server.admin.user && m.set_option),
    { role: 'cs_account', member: server.admin.user, admin_option: false, inherit_option: false, set_option: true }
  )
  assert.deepEqual(
    state.defaultAcl.filter((acl) => acl.defaclrole === 'cs_account').map((acl) => [acl.defaclnamespace, acl.defaclobjtype, acl.defaclacl]),
    [[0, 'f', '{cs_account=X/cs_account}']]
  )
  // Schemi tables (0008) e public (0009): di ct_app e cs_site, stesse regole; su un database nuovo nessuna tabella
  // di ComforTables da spostare.
  for (const role of ['ct_app', 'cs_site']) {
    assert.deepEqual(
      state.memberships.find((m) => m.role === role && m.member === server.admin.user && m.set_option),
      { role, member: server.admin.user, admin_option: false, inherit_option: false, set_option: true },
      role
    )
    assert.deepEqual(
      state.defaultAcl.filter((acl) => acl.defaclrole === role).map((acl) => [acl.defaclnamespace, acl.defaclobjtype, acl.defaclacl]),
      [[0, 'f', `{${role}=X/${role}}`]],
      role
    )
  }
  assert.deepEqual(
    state.jobs,
    JOBS.map((job) => ({ ...job, username: server.admin.user, database: db.name, active: true }))
  )
})

test('secondo apply vuoto; 0002-0004 rieseguite convergono senza cambiare nulla', async () => {
  assert.deepEqual((await apply({ client: admin, dir: MIGRATIONS_DIR })).applied, [])
  const state = await inspect({ client: admin, dir: MIGRATIONS_DIR })
  assert.deepEqual([state.drift, state.pending], [[], []])

  const before = await snapshot()
  for (const name of FILES.slice(1)) {
    await runInTransaction(admin, sql(name))
    assert.deepEqual(await snapshot(), before, `${name} rieseguita ha cambiato lo stato`)
  }

  // Oggetti parzialmente presenti: funzione e permesso mancanti vengono ricreati.
  await admin.query('drop function bus.status()')
  await admin.query('revoke execute on function bus.next() from cl_app')
  await runInTransaction(admin, sql('0003_bus.sql'))
  assert.deepEqual(await snapshot(), before)

  // Schema account con permessi a PUBLIC aggiunti fuori dalle migrazioni: 0007 rieseguita li toglie.
  await superuser.query('grant usage, create on schema account to public')
  await superuser.query('alter default privileges for role cs_account grant execute on functions to public')
  assert.notDeepEqual(await snapshot(), before)
  await runInTransaction(admin, sql('0007_account_schema.sql'))
  assert.deepEqual(await snapshot(), before)

  // Un utente con login impostato dal runner resta tale se 0002 viene rieseguita.
  await setLogin({ client: admin, role: 'ct_app', password: newPassword() })
  await runInTransaction(admin, sql('0002_platform_roles.sql'))
  const { rows } = await superuser.query("select rolcanlogin from pg_roles where rolname = 'ct_app'")
  assert.equal(rows[0].rolcanlogin, true)
})

test('i job pg_cron girano davvero come amministratore: orologio pubblicato, pulizia eseguita', async (t) => {
  const { rows: jobs } = await superuser.query('select jobid, jobname, schedule from cron.job order by jobname')
  t.after(async () => {
    for (const job of jobs) await superuser.query('select cron.alter_job($1, schedule := $2)', [job.jobid, job.schedule])
  })
  const startedAt = new Date()
  for (const job of jobs) await superuser.query("select cron.alter_job($1, schedule := '1 seconds')", [job.jobid])

  const runs = await waitFor(
    async () => {
      const { rows } = await superuser.query(
        `select j.jobname, d.status, d.username, d.return_message
           from cron.job_run_details d join cron.job j on j.jobid = d.jobid
          where d.start_time >= $1 and d.status in ('succeeded', 'failed')`,
        [startedAt]
      )
      const names = new Set(rows.map((r) => r.jobname))
      return names.has('bus-cleanup') && names.has('platform-clock-daily') ? rows : null
    },
    { timeoutMs: 15000, message: 'esecuzioni dei job pg_cron' }
  )
  for (const job of jobs) await superuser.query('select cron.alter_job($1, schedule := $2)', [job.jobid, job.schedule])

  assert.deepEqual(runs.filter((r) => r.status !== 'succeeded'), [])
  assert.deepEqual([...new Set(runs.map((r) => r.username))], [server.admin.user])

  const { rows: messages } = await admin.query(
    `select m.producer, m.schema_version, m.organization_id, m.payload, d.app, d.status
       from bus.messages m join bus.deliveries d on d.message_id = m.id
      where m.topic = 'platform.clock.daily' limit 1`
  )
  const { rows: [today] } = await admin.query("select to_char(now() at time zone 'UTC', 'YYYY-MM-DD') as date")
  assert.deepEqual(messages, [
    { producer: 'platform', schema_version: 1, organization_id: null, payload: { date: today.date }, app: 'logistics', status: 'pending' }
  ])
})

test('0004 in un database diverso da cron.database_name: errore chiaro, registro fermo a 0003', async () => {
  const other = await server.createDatabase()
  const client = await other.connectAdmin()
  await assert.rejects(apply({ client, dir: MIGRATIONS_DIR }), (err) => {
    assert.equal(err.code, 'MIGRATION_FAILED')
    assert.match(
      err.message,
      new RegExp(`^0004_pg_cron\\.sql fallita.*: pg_cron non disponibile in questo database: esegue i job nel database "postgres", non in "${other.name}"\\. \\(SQLSTATE 0A000\\)`)
    )
    assert.match(err.cause.hint, /cron\.database_name/)
    return true
  })
  const { rows } = await client.query('select name from platform.migrations order by name')
  assert.deepEqual(rows.map((r) => r.name), FILES.slice(0, 3))
  const { rows: topics } = await client.query('select count(*)::int as n from bus.topics')
  assert.equal(topics[0].n, 0)
})

test('0006 con uno schema logistics di un altro proprietario: stop senza toccarlo', async (t) => {
  const other = await startPostgres()
  t.after(() => other.stop())
  const otherDb = other.database(other.cronDatabase)
  const root = await otherDb.connect()
  await root.query('create schema logistics')
  const client = await otherDb.connectAdmin()

  await assert.rejects(apply({ client, dir: MIGRATIONS_DIR }), (err) => {
    assert.match(err.message, /^0006_logistics_schema\.sql fallita.*: Lo schema logistics esiste gia' con proprietario postgres: migrazione fermata\. \(SQLSTATE 55000\)/)
    return true
  })
  const { rows } = await root.query("select nspowner::regrole::text as owner from pg_namespace where nspname = 'logistics'")
  assert.equal(rows[0].owner, 'postgres')
  const { rows: registry } = await client.query('select name from platform.migrations order by name')
  assert.deepEqual(registry.map((r) => r.name), FILES.slice(0, 5))
})

test('0007 con uno schema account di un altro proprietario: stop senza toccarlo', async (t) => {
  const other = await startPostgres()
  t.after(() => other.stop())
  const otherDb = other.database(other.cronDatabase)
  const root = await otherDb.connect()
  await root.query('create schema account')
  const client = await otherDb.connectAdmin()

  await assert.rejects(apply({ client, dir: MIGRATIONS_DIR }), (err) => {
    assert.match(err.message, /^0007_account_schema\.sql fallita.*: Lo schema account esiste gia' con proprietario postgres: migrazione fermata\. \(SQLSTATE 55000\)/)
    return true
  })
  const { rows } = await root.query("select nspowner::regrole::text as owner, nspacl::text as acl from pg_namespace where nspname = 'account'")
  assert.deepEqual(rows, [{ owner: 'postgres', acl: null }])
  const { rows: registry } = await client.query('select name from platform.migrations order by name')
  assert.deepEqual(registry.map((r) => r.name), FILES.slice(0, 6))
})

test('cluster senza pg_cron precaricata, o amministratore che non legge le impostazioni: errore chiaro', async (t) => {
  const plain = await startPostgres({ pgCron: false })
  t.after(() => plain.stop())
  const plainDb = plain.database(plain.cronDatabase)
  const client = await plainDb.connectAdmin()

  await assert.rejects(apply({ client, dir: MIGRATIONS_DIR }), (err) => {
    assert.equal(err.code, 'MIGRATION_FAILED')
    assert.match(err.message, /^0004_pg_cron\.sql fallita.*: pg_cron non disponibile: non e' caricata \(shared_preload_libraries = ""\)\. \(SQLSTATE 0A000\)/)
    assert.match(err.cause.hint, /Aggiungi pg_cron a shared_preload_libraries e riavvia il server/)
    return true
  })

  const root = await plainDb.connect()
  await root.query(`revoke pg_read_all_settings from ${plain.admin.user}`)
  await assert.rejects(apply({ client, dir: MIGRATIONS_DIR }), (err) => {
    assert.match(err.message, new RegExp(`pg_cron non verificabile: l'utente ${plain.admin.user} non puo' leggere shared_preload_libraries e cron\\.database_name\\. \\(SQLSTATE 42501\\)`))
    assert.match(err.cause.hint, /pg_read_all_settings/)
    return true
  })
  const { rows } = await client.query('select name from platform.migrations order by name')
  assert.deepEqual(rows.map((r) => r.name), FILES.slice(0, 3))
})
