'use strict'

const { before, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { randomBytes } = require('node:crypto')
const pg = require('pg')
const { startPostgres } = require('../testing')
const { Report, createContext } = require('../db/probes/context')
const { APPLICATION_NAME, makeEndpoint, supabaseEndpoints } = require('../db/probes/endpoints')
const { ROLE_A, findProbeObjects, setup } = require('../db/probes/objects')
const { runProbes } = require('../db/probes/run')
const { waitFor } = require('./helpers/platform')

// Postgres locale: pooler di sessione, pooler di transazione e diretta sono lo stesso server. Le
// prove verificano il funzionamento degli script, non il comportamento di Supavisor.
const FAST = { parallel: 3, rounds: 3, sequential: 2, sessionUserCalls: 6, notifyHoldMs: 300, waitMs: 3000 }

let server
let db
let adminConfig
let superuser

before(async () => {
  server = await startPostgres()
  db = await server.createDatabase()
  superuser = await db.connect()
  // Amministratore come `postgres` su Supabase: CREATEROLE e pg_signal_backend, non superutente.
  adminConfig = await createAdmin('platform_probe_admin', { signalBackend: true })
})
after(async () => {
  await server?.stop()
})

async function createAdmin(name, { signalBackend }) {
  const password = randomBytes(16).toString('hex')
  await superuser.query(`create role ${name} login createrole password '${password}'`)
  await superuser.query(`grant create on database ${db.name} to ${name}`)
  if (signalBackend) await superuser.query(`grant pg_signal_backend to ${name}`)
  return { ...server.connection, user: name, password, database: db.name }
}

/**
 * Sessione di un ruolo come la tiene Supavisor: se viene terminata, la riapre subito finche' il
 * login lo consente. `refused` e' il codice dell'ultima riapertura rifiutata, `reopened` quante
 * riaperture sono riuscite.
 */
function poolerLikeSession(config) {
  const session = { client: null, stopped: false, refused: null, reopened: 0, opened: false }
  const open = async () => {
    const client = new pg.Client(config)
    client.on('error', () => {})
    await client.connect()
    if (session.opened) session.reopened += 1
    session.opened = true
    session.client = client
    client.once('end', () => {
      if (!session.stopped) open().catch((err) => (session.refused = err.code))
    })
  }
  session.open = open
  session.stop = async () => {
    session.stopped = true
    await session.client?.end().catch(() => {})
  }
  return session
}

function localEndpoints(adminOverride = {}) {
  const localAdmin = { ...adminConfig, ...adminOverride }
  const base = { database: localAdmin.database, ssl: false, application_name: APPLICATION_NAME, connectionTimeoutMillis: 5000 }
  const local = (name, label) =>
    makeEndpoint({ name, label, base, host: localAdmin.host, port: localAdmin.port, userFor: (role) => role })
  return {
    admin: { name: 'admin', label: 'amministratore', host: localAdmin.host, port: localAdmin.port, user: localAdmin.user, config: localAdmin },
    session: local('session', 'sessione locale'),
    transaction: local('transaction', 'transazione locale'),
    direct: local('direct', 'diretta locale'),
    mask: String,
    warnings: []
  }
}

const silentReport = () => new Report({ write: () => {} })
const levels = (report, level) => report.results.filter((r) => r.level === level)
const ids = (report, level) => [...new Set(levels(report, level).map((r) => r.id))].sort()

async function assertNoProbeObjects() {
  assert.deepEqual(await findProbeObjects(superuser, { orphans: true }), [])
}

test('all: ogni prova OK sul server locale, nessun residuo', async () => {
  const report = silentReport()
  await runProbes('all', { endpoints: localEndpoints(), report, options: FAST })

  // pg_cron e pgcrypto sono disponibili nel Postgres locale (postgresql-17-cron installato).
  assert.deepEqual(levels(report, 'KO').map((r) => `${r.id} ${r.text}`), [])
  assert.equal(levels(report, 'OK').filter((r) => r.id === '1.2' && r.text.startsWith('pg_cron: disponibile')).length, 1)
  assert.deepEqual(ids(report, 'OK'), ['1.2', '2.1', '2.2', '2.3', '3.1', '3.2', '4.1', '4.2', '4.3', '4.4', '4.5a', '4.5b', 'C', 'P.1', 'P.2', 'P.3', 'R'])
  assert.equal(levels(report, 'OK').filter((r) => r.id === '3.2').length, 3)
  // Due ascoltatori (sessione e diretta), ognuno con chiusura regolare e brusca.
  assert.equal(levels(report, 'OK').filter((r) => r.id.startsWith('4.5')).length, 6)
  await assertNoProbeObjects()
})

test('notify-idle: ascoltatori con e senza keepalive ricevono dopo l\'inattivita\'', async () => {
  const report = silentReport()
  await runProbes('notify-idle', { endpoints: localEndpoints(), report, options: { ...FAST, idleSeconds: 1 } })
  assert.deepEqual(levels(report, 'KO'), [])
  assert.equal(levels(report, 'OK').filter((r) => r.id === '4.6').length, 4 + 4) // 4 LISTEN + 4 avvisi
  await assertNoProbeObjects()
})

test('un oggetto probe_ gia\' presente ferma le prove e non viene toccato', async (t) => {
  await superuser.query('create role probe_estraneo nologin')
  t.after(() => superuser.query('drop role if exists probe_estraneo'))

  await assert.rejects(
    runProbes('search-path', { endpoints: localEndpoints(), report: silentReport(), options: FAST }),
    /Esistono gia' oggetti probe_ \(ruolo probe_estraneo\)/
  )
  const { rows } = await superuser.query("select rolname from pg_roles where rolname like 'probe\\_%' order by 1")
  assert.deepEqual(rows.map((r) => r.rolname), ['probe_estraneo'])
})

test('amministratore senza pg_signal_backend: prove non avviate, nulla creato', async (t) => {
  const weak = await createAdmin('platform_probe_weak', { signalBackend: false })
  t.after(async () => {
    await superuser.query(`revoke create on database ${db.name} from platform_probe_weak`)
    await superuser.query('drop role platform_probe_weak')
  })
  await assert.rejects(
    runProbes('search-path', { endpoints: localEndpoints(weak), report: silentReport(), options: FAST }),
    /non ha pg_signal_backend/
  )
  await assertNoProbeObjects()
})

test('cleanup dopo un\'interruzione, con il pooler che riapre le sessioni terminate; poi idempotente', async () => {
  // Esecuzione interrotta: oggetti creati, una sessione del ruolo tenuta aperta come da Supavisor.
  const crashed = createContext({ endpoints: localEndpoints(), report: silentReport() })
  await crashed.connectAdmin()
  await setup(crashed)
  const pooled = poolerLikeSession(localEndpoints().session.configFor(ROLE_A, crashed.passwords.get(ROLE_A)))
  await pooled.open()
  await crashed.admin.end()

  const report = silentReport()
  await runProbes('cleanup', { endpoints: localEndpoints(), report })
  // La riapertura del «pooler» parte dall'evento `end` del client ed e' asincrona. Sotto carico non si era ancora
  // conclusa quando il test controllava (`refused` null, 2026-09-19), oppure si concludeva dopo l'eliminazione del
  // ruolo, con un altro codice (`28P01`): riprodotto ritardandola di 300 ms. Si aspetta che finisca, e si prova la
  // proprieta' vera: il pooler non e' mai riuscito a riaprire, perche' il login era gia' disattivato quando la
  // sessione e' stata terminata. Con l'ordine sbagliato la riapertura riesce e il test cade.
  await waitFor(() => pooled.refused !== null || pooled.reopened > 0, { timeoutMs: 10000, message: 'riapertura del pooler non conclusa' })
  await pooled.stop()
  assert.deepEqual(levels(report, 'KO'), [])
  assert.ok(levels(report, 'INFO').some((r) => r.text === `${ROLE_A}: login disattivato, 1 sessioni residue terminate`))
  assert.equal(pooled.reopened, 0, 'il pooler ha riaperto una sessione del ruolo')
  // Rifiutata: login disattivato (28000) o, se la riapertura arriva dopo la pulizia, ruolo gia' eliminato (28P01).
  assert.ok(['28000', '28P01'].includes(pooled.refused), `riapertura rifiutata con ${pooled.refused}`)
  await assertNoProbeObjects()

  const again = silentReport()
  await runProbes('cleanup', { endpoints: localEndpoints(), report: again })
  assert.deepEqual(levels(again, 'KO'), [])
  assert.ok(levels(again, 'OK').some((r) => r.id === 'C' && r.text.includes('ruoli trovati: nessuno')))
})

test('leftovers segnala un residuo come KO', async (t) => {
  await superuser.query('create schema probe_rimasto')
  t.after(() => superuser.query('drop schema if exists probe_rimasto'))
  const report = silentReport()
  await runProbes('leftovers', { endpoints: localEndpoints(), report })
  assert.deepEqual(levels(report, 'KO').map((r) => r.text), ['residui: schema probe_rimasto'])
})

test('endpoint Supabase ricavati da .env sul pooler di sessione', () => {
  const ref = 'abcdefghijklmnopqrst'
  const source = {
    PLATFORM_STAGING_DATABASE_HOST: 'aws-0-eu-west-3.pooler.supabase.com',
    PLATFORM_STAGING_DATABASE_PORT: '5432',
    PLATFORM_STAGING_DATABASE_USERNAME: `postgres.${ref}`,
    PLATFORM_STAGING_DATABASE_PASSWORD: 'segreta',
    PLATFORM_STAGING_DATABASE_SSL: 'false'
  }
  const e = supabaseEndpoints('staging', { source })
  assert.deepEqual(
    [e.session, e.transaction, e.direct].map((x) => [x.host, x.port, x.userFor(ROLE_A)]),
    [
      ['aws-0-eu-west-3.pooler.supabase.com', 5432, `${ROLE_A}.${ref}`],
      ['aws-0-eu-west-3.pooler.supabase.com', 6543, `${ROLE_A}.${ref}`],
      [`db.${ref}.supabase.co`, 5432, ROLE_A]
    ]
  )
  assert.equal(e.transaction.configFor(ROLE_A, 'pw').application_name, APPLICATION_NAME)
  assert.equal(e.admin.config.application_name, APPLICATION_NAME)
  assert.equal(e.mask(`utente postgres.${ref} su db.${ref}.supabase.co`), 'utente postgres.<ref> su db.<ref>.supabase.co')

  const direct = { ...source, PLATFORM_STAGING_DATABASE_HOST: `db.${ref}.supabase.co`, PLATFORM_STAGING_DATABASE_USERNAME: 'postgres' }
  assert.throws(() => supabaseEndpoints('staging', { source: direct }), /--pooler-host/)
  assert.equal(supabaseEndpoints('staging', { source: direct, poolerHost: 'aws-0-x.pooler.supabase.com' }).transaction.userFor(ROLE_A), `${ROLE_A}.${ref}`)

  const other = { ...source, PLATFORM_STAGING_DATABASE_HOST: 'localhost' }
  assert.throws(() => supabaseEndpoints('staging', { source: other }), (err) => /non riconosciuto/.test(err.message) && !err.message.includes('segreta'))
})
