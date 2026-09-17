'use strict'

// Libreria del bus (bus/client): pubblicazione con il contratto, consumatore, retry, ascolto, avvisi.
// Postgres 17 locale con le migrazioni reali e gli utenti applicativi reali.

const { before, beforeEach, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const pg = require('pg')
const { startPostgres } = require('../testing')
const { setupBus, waitFor } = require('./helpers/platform')
const { ORG, REQUEST, VALID, dish } = require('./helpers/contract-examples')
const { BusListenError, ContractError, LISTEN_APPLICATION_NAME, createConsumer, publish } = require('..')

const ROOT = path.resolve(__dirname, '..')
const SALE = 'tables.sales.item_served'
const quiet = { info: () => {}, warn: () => {}, error: () => {} }
const FAST = { reconnectDelaysMs: [300], verifyTimeoutMs: 2000 }

let server
let bus
const pools = {}
const consumers = []

before(async () => {
  server = await startPostgres()
  bus = await setupBus(server)
  for (const role of ['ct_app', 'cl_app', 'cs_account']) pools[role] = new pg.Pool(bus.configFor(role))
})
beforeEach(async () => {
  await Promise.all(consumers.splice(0).map((consumer) => consumer.stop()))
  await bus.reset()
})
after(async () => {
  await Promise.all(consumers.splice(0).map((consumer) => consumer.stop()))
  await Promise.all(Object.values(pools).map((pool) => pool.end()))
  await server?.stop()
})

const sale = (itemRef) => ({ ...VALID[SALE], item_ref: itemRef })

function consumer(role, app, settings = {}) {
  const instance = createConsumer({
    app,
    pool: pools[role],
    listen: bus.configFor(role),
    logger: quiet,
    options: FAST,
    ...settings
  })
  consumers.push(instance)
  return instance
}

async function effects(client = bus.cl) {
  const { rows } = await client.query('select message_id, entity_ref from effects order by processed')
  return rows
}

async function deliveries(app) {
  const { rows } = await bus.admin.query(
    `select m.id, d.status, d.attempts, d.last_error from bus.deliveries d join bus.messages m on m.id = d.message_id
      where d.app = $1 order by m.seq`,
    [app]
  )
  return rows
}

const recordSale = async (tx, message) => {
  await tx.query('insert into effects (message_id, entity_ref) values ($1, $2)', [message.id, message.entityRef])
}

test('publish: contratto validato, entita\' e versione ricavate, transazione del chiamante rispettata', async () => {
  await assert.rejects(publish(bus.ct, SALE, { schemaVersion: 1, organizationId: ORG, payload: { ...sale('it1'), quantity: 0 } }), (err) => {
    assert.ok(err instanceof ContractError)
    assert.match(err.message, /tables\.sales\.item_served v1: payload non valido: \/quantity must be >= 1/)
    return true
  })
  await assert.rejects(publish(bus.ct, SALE, { organizationId: ORG, payload: sale('it1') }), /schemaVersion \(intero\) obbligatoria/)
  await assert.rejects(
    publish(bus.ct, 'tables.bar.preview_requested', { schemaVersion: 1, organizationId: ORG, payload: VALID['tables.bar.preview_requested'] }),
    /requestId \(uuid\) obbligatorio/
  )

  await bus.ct.query('begin')
  await publish(bus.ct, SALE, { schemaVersion: 1, organizationId: ORG, payload: sale('annullato') })
  await bus.ct.query('rollback')

  const saleId = await publish(bus.ct, SALE, { schemaVersion: 1, organizationId: ORG, payload: sale('it1') })
  const dishId = await publish(bus.ct, 'tables.catalog.dish_changed', { schemaVersion: 1, organizationId: ORG, payload: dish })
  const previewId = await publish(bus.ct, 'tables.bar.preview_requested', {
    schemaVersion: 1,
    organizationId: ORG,
    requestId: REQUEST,
    payload: VALID['tables.bar.preview_requested']
  })
  // Nessun iscritto di ComforTables nel contratto v1 (le fixture ne aggiungono solo per availability.changed):
  // il messaggio non viene salvato.
  assert.equal(
    await publish(bus.cl, 'logistics.link_changed', { schemaVersion: 1, organizationId: ORG, payload: VALID['logistics.link_changed'] }),
    null
  )

  const { rows } = await bus.admin.query(
    'select id, topic, schema_version, organization_id, entity_ref, entity_version, request_id, payload from bus.messages order by seq'
  )
  assert.deepEqual(rows, [
    { id: saleId, topic: SALE, schema_version: 1, organization_id: ORG, entity_ref: 'item:it1', entity_version: null, request_id: null, payload: sale('it1') },
    { id: dishId, topic: 'tables.catalog.dish_changed', schema_version: 1, organization_id: ORG, entity_ref: 'dish:d1', entity_version: '3', request_id: null, payload: dish },
    {
      id: previewId,
      topic: 'tables.bar.preview_requested',
      schema_version: 1,
      organization_id: ORG,
      entity_ref: null,
      entity_version: null,
      request_id: REQUEST,
      payload: VALID['tables.bar.preview_requested']
    }
  ])
})

test('consumatore: svuota all\'avvio, poi elabora a ogni avviso; effetto e conferma nella stessa transazione', async () => {
  const first = await publish(bus.ct, SALE, { schemaVersion: 1, organizationId: ORG, payload: sale('it1') })
  const second = await publish(bus.ct, SALE, { schemaVersion: 1, organizationId: ORG, payload: sale('it2') })
  const received = []
  const logistics = consumer('cl_app', 'logistics', {
    handlers: {
      [SALE]: {
        1: async (tx, message) => {
          received.push(message)
          await recordSale(tx, message)
        }
      }
    }
  })

  await logistics.start()
  assert.deepEqual((await effects()).map((e) => e.message_id), [first, second])
  assert.deepEqual(logistics.inspect(), { running: true, listening: true, retryAt: null })
  assert.deepEqual(
    { ...received[0], occurredAt: undefined, publishedAt: undefined },
    {
      id: first,
      topic: SALE,
      schemaVersion: 1,
      producer: 'comfortables',
      organizationId: ORG,
      entityRef: 'item:it1',
      entityVersion: null,
      requestId: null,
      payload: sale('it1'),
      occurredAt: undefined,
      publishedAt: undefined,
      attempts: 0
    }
  )

  const third = await publish(bus.ct, SALE, { schemaVersion: 1, organizationId: ORG, payload: sale('it3') })
  await waitFor(async () => (await effects()).length === 3, { message: 'messaggio ricevuto con l\'avviso' })
  assert.deepEqual((await deliveries('logistics')).map((d) => [d.id, d.status]), [[first, 'done'], [second, 'done'], [third, 'done']])

  await logistics.stop()
  assert.deepEqual(logistics.inspect(), { running: false, listening: false, retryAt: null })
})

test('handler che fallisce: effetto annullato, un solo timer al prossimo retry, nessun timer dopo il successo', async () => {
  const id = await publish(bus.ct, SALE, { schemaVersion: 1, organizationId: ORG, payload: sale('it1') })
  let calls = 0
  const logistics = consumer('cl_app', 'logistics', {
    handlers: {
      [SALE]: {
        1: async (tx, message) => {
          calls++
          await recordSale(tx, message)
          if (calls === 1) throw new Error('giacenza non trovata')
        }
      }
    }
  })

  await logistics.start()
  assert.deepEqual((await deliveries('logistics')).map((d) => [d.status, d.attempts, d.last_error]), [['failed', 1, 'giacenza non trovata']])
  assert.deepEqual(await effects(), [])
  const retryAt = logistics.inspect().retryAt
  assert.ok(retryAt instanceof Date)
  assert.ok(Math.abs(retryAt.getTime() - Date.now() - 10000) < 2000, `retry previsto tra circa 10 s, non ${retryAt.getTime() - Date.now()} ms`)

  // Il tempo non scorre nei test: il retry viene anticipato e il consumatore riprogramma il suo unico timer.
  await bus.admin.query("update bus.deliveries set next_attempt_at = now() + interval '300 milliseconds' where message_id = $1", [id])
  await logistics.drain()
  assert.ok(logistics.inspect().retryAt.getTime() - Date.now() < 1000)
  await waitFor(async () => (await effects()).length === 1, { message: 'retry eseguito dal timer' })
  assert.equal(calls, 2)
  assert.deepEqual((await deliveries('logistics')).map((d) => d.status), ['done'])
  await waitFor(() => logistics.inspect().retryAt === null, { message: 'timer non rimosso' })
})

test('messaggio non valido per il contratto: dead senza handler; argomento senza handler: retry', async () => {
  // Pubblicato scavalcando la libreria: il consumatore deve comunque proteggere l'handler.
  const { rows } = await bus.ct.query("select bus.publish($1, 1, $2, 'item:rotto', null, $3) as id", [
    SALE,
    ORG,
    JSON.stringify({ item_ref: 'rotto', quantity: 'tante' })
  ])
  const invalid = rows[0].id
  const voided = await publish(bus.ct, 'tables.sales.item_voided', { schemaVersion: 1, organizationId: ORG, payload: VALID['tables.sales.item_voided'] })
  let calls = 0
  const logistics = consumer('cl_app', 'logistics', { handlers: { [SALE]: { 1: async () => calls++ } } })

  await logistics.start()
  const [dead, retry] = await deliveries('logistics')
  assert.equal(dead.id, invalid)
  assert.deepEqual([dead.status, dead.attempts], ['dead', 1])
  assert.match(dead.last_error, /^contratto non rispettato: .*\/quantity must be integer/)
  assert.equal(calls, 0)
  assert.equal(retry.id, voided)
  assert.deepEqual([retry.status, retry.attempts, retry.last_error], ['failed', 1, 'nessun handler per tables.sales.item_voided v1'])
})

test('verifica dell\'ascolto: se gli avvisi non arrivano (come sul pooler 6543) il consumatore non parte', async () => {
  const mutedName = 'test-ascolto-muto'
  const muted = consumer('cl_app', 'logistics', {
    listen: () => {
      const client = new pg.Client({ ...bus.configFor('cl_app'), application_name: mutedName })
      const emit = client.emit.bind(client)
      client.emit = (event, ...args) => (event === 'notification' ? false : emit(event, ...args))
      return client
    },
    options: { ...FAST, verifyTimeoutMs: 300 }
  })

  await assert.rejects(muted.start(), (err) => {
    assert.ok(err instanceof BusListenError)
    assert.match(err.message, /Ascolto non verificato per bus_logistics: nessun avviso ricevuto entro 300 ms\. .*non il pooler in modalita' transazione \(6543\)/)
    return true
  })
  assert.deepEqual(muted.inspect(), { running: false, listening: false, retryAt: null })
  await waitFor(
    async () => (await bus.admin.query('select count(*)::int as n from pg_stat_activity where application_name = $1', [mutedName])).rows[0].n === 0,
    { message: 'connessione di ascolto non chiusa' }
  )
})

test('verifica dell\'ascolto: l\'avviso di prova parte da un\'altra sessione, non dalla connessione di ascolto', async () => {
  // Sul pooler 6543 un pg_notify dalla connessione di ascolto torna sullo stesso backend e supera la verifica
  // anche se gli avvisi delle altre app non arriverebbero (staging, 2026-09-17).
  const sentByListener = []
  const logistics = consumer('cl_app', 'logistics', {
    listen: () => {
      const client = new pg.Client(bus.configFor('cl_app'))
      const query = client.query.bind(client)
      client.query = (text, ...rest) => {
        sentByListener.push(typeof text === 'string' ? text : text.text)
        return query(text, ...rest)
      }
      return client
    }
  })
  await logistics.start()
  assert.ok(sentByListener.some((text) => /^listen bus_verify_[0-9a-f]{16}$/.test(text)), 'verifica non eseguita')
  assert.equal(sentByListener.some((text) => text.includes('pg_notify')), false, 'pg_notify inviato dalla connessione di ascolto')
})

test('riconnessione: l\'ascolto terminato si riapre e i messaggi pubblicati nel frattempo vengono elaborati', async () => {
  const logistics = consumer('cl_app', 'logistics', { handlers: { [SALE]: { 1: recordSale } } })
  await logistics.start()

  await bus.admin.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and usename = 'cl_app'",
    [LISTEN_APPLICATION_NAME]
  )
  await waitFor(() => !logistics.inspect().listening, { message: 'interruzione non vista' })
  const id = await publish(bus.ct, SALE, { schemaVersion: 1, organizationId: ORG, payload: sale('durante') })

  await waitFor(async () => (await effects()).length === 1, { message: 'messaggio non recuperato dopo la riconnessione' })
  assert.equal((await effects())[0].message_id, id)
  assert.equal(logistics.inspect().listening, true)
})

test('due istanze della stessa app: ogni messaggio elaborato una sola volta', async () => {
  const slow = async (tx, message) => {
    await recordSale(tx, message)
    await tx.query('select pg_sleep(0.005)')
  }
  const instances = [consumer('cl_app', 'logistics', { handlers: { [SALE]: { 1: slow } } }), consumer('cl_app', 'logistics', { handlers: { [SALE]: { 1: slow } } })]
  await Promise.all(instances.map((instance) => instance.start()))

  for (let i = 0; i < 30; i++) await publish(bus.ct, SALE, { schemaVersion: 1, organizationId: ORG, payload: sale(`it${i % 6}-${i}`) })
  await waitFor(async () => (await effects()).length === 30, { timeoutMs: 10000, message: 'messaggi non elaborati' })
  await sleep(200)
  assert.equal((await effects()).length, 30)
  assert.deepEqual([...new Set((await deliveries('logistics')).map((d) => d.status))], ['done'])
})

test('avvisi dei blocchi: una sola email tra due app; invio fallito rilasciato e ripreso da un\'altra app', async () => {
  const sent = { comfortables: [], account: [] }
  const failures = []
  let failComfortables = false
  let stallsChanged = 0
  const tables = consumer('ct_app', 'comfortables', {
    notices: {
      send: async (notice) => {
        if (failComfortables) {
          failures.push(notice)
          throw new Error('SMTP non raggiungibile')
        }
        sent.comfortables.push(notice)
      }
    },
    onStallsChanged: () => stallsChanged++
  })
  const account = consumer('cs_account', 'account', { notices: { send: async (notice) => sent.account.push(notice) } })
  await Promise.all([tables.start(), account.start()])

  // ComfortLogistics ferma da piu' di 5 minuti: blocco backlog alla pubblicazione successiva.
  await publish(bus.ct, SALE, { schemaVersion: 1, organizationId: ORG, payload: sale('it1') })
  await bus.admin.query("update bus.messages set published_at = published_at - interval '6 minutes'")
  await publish(bus.ct, SALE, { schemaVersion: 1, organizationId: ORG, payload: sale('it2') })

  await waitFor(() => sent.comfortables.length + sent.account.length >= 1, { message: 'email di blocco non inviata' })
  await sleep(300)
  const all = [...sent.comfortables, ...sent.account]
  assert.equal(all.length, 1, 'email di blocco inviata piu\' di una volta')
  assert.deepEqual([all[0].kind, all[0].app, all[0].stallKind, all[0].waitingCount], ['opened', 'logistics', 'backlog', 2])
  assert.ok(stallsChanged > 0)

  // Email "risolto": ComforTables non riesce a inviarla e rilascia; account e' ferma e la invia alla ripartenza.
  await account.stop()
  failComfortables = true
  const logistics = consumer('cl_app', 'logistics', { handlers: { [SALE]: { 1: recordSale } } })
  await logistics.start()
  await waitFor(() => failures.length >= 1, { message: 'invio fallito non tentato' })
  await sleep(300)
  assert.equal(failures.length, 1, 'invio fallito ripetuto subito')
  const { rows: [released] } = await bus.admin.query('select resolved_claimed_by, resolved_sent_at from bus.stalls')
  assert.deepEqual(released, { resolved_claimed_by: null, resolved_sent_at: null })

  const accountAgain = consumer('cs_account', 'account', { notices: { send: async (notice) => sent.account.push(notice) } })
  await accountAgain.start()
  const resolved = [...sent.account].filter((notice) => notice.kind === 'resolved')
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].processedCount, 1)
  const { rows: [done] } = await bus.admin.query('select resolved_claimed_by, resolved_sent_at is not null as sent from bus.stalls')
  assert.deepEqual(done, { resolved_claimed_by: 'account', sent: true })
  assert.equal(failures.length, 1)
})

test('pacchetto importabile da CommonJS e da ESM con export nominati', () => {
  const script = `
    import { publish, createConsumer, ContractError, BusListenError } from 'comfort-platform'
    import { validatePayload, topics } from 'comfort-platform/contract'
    import { startPostgres, installPlatform } from 'comfort-platform/testing'
    const kinds = [publish, createConsumer, ContractError, BusListenError, validatePayload, startPostgres, installPlatform].map((x) => typeof x)
    console.log(JSON.stringify({ kinds, topics: topics.length }))`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { kinds: Array(7).fill('function'), topics: 21 })
  assert.equal(typeof require('comfort-platform').createConsumer, 'function')
})
