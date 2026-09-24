'use strict'

// 0012 (ADR-0014 §14.7, §14.9): rigioco da amministratore delle consegne `dead`. Una consegna morta blocca le
// successive della stessa entita' e tiene aperto il blocco dell'app; `bus.replay` la rimette in coda, e il blocco si
// chiude da solo quando l'app la conferma.

const { before, beforeEach, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { startPostgres } = require('../testing')
const { drain, listen, publish, recordEffect, setupBus, waitFor } = require('./helpers/platform')
const { listDead, replay, formatDead } = require('../db/runner/replay')

const SALE = 'tables.sales.item_served'

let server
let bus

before(async () => {
  server = await startPostgres()
  bus = await setupBus(server)
})
beforeEach(async () => {
  await bus.reset()
})
after(async () => {
  await server?.stop()
})

/** Handler che scarta per sempre i messaggi indicati, come un contratto non rispettato. */
const rejecting = (ids) => async (client, message) => {
  if (ids.includes(message.message_id)) {
    throw Object.assign(new Error('contratto non rispettato: (payload) must be object'), { permanent: true })
  }
  await recordEffect()(client, message)
}

const deliveries = async () => (await bus.admin.query(
  "select m.entity_ref, d.status, d.attempts from bus.deliveries d join bus.messages m on m.id = d.message_id where d.app = 'logistics' order by m.seq"
)).rows
const effects = async () => (await bus.cl.query('select message_id from effects order by processed')).rows.map((r) => r.message_id)
const openStall = async () => (await bus.admin.query("select kind from bus.stalls where app = 'logistics' and closed_at is null")).rows

test('una consegna morta rigiocata passa, sblocca la sua entita\' e chiude il blocco', async (t) => {
  const dead = await publish(bus.ct, SALE, { entity: 'item-1' })
  const behind = await publish(bus.ct, SALE, { entity: 'item-1' })
  const other = await publish(bus.ct, SALE, { entity: 'item-2' })

  await drain(bus.cl, rejecting([dead]))
  // La morta ferma la sua entita', non le altre.
  assert.deepEqual(await deliveries(), [
    { entity_ref: 'item-1', status: 'dead', attempts: 1 },
    { entity_ref: 'item-1', status: 'pending', attempts: 0 },
    { entity_ref: 'item-2', status: 'done', attempts: 0 }
  ])
  assert.deepEqual(await effects(), [other])
  assert.deepEqual(await openStall(), [{ kind: 'dead' }])

  const listener = await bus.connectAs('cl_app')
  t.after(() => listener.end())
  const heard = await listen(listener, 'bus_logistics')

  const { rows: replayed } = await bus.admin.query("select * from bus.replay('logistics')")
  assert.deepEqual(replayed, [{
    message_id: dead,
    topic: SALE,
    entity_ref: 'item-1',
    attempts: 1,
    last_error: 'contratto non rispettato: (payload) must be object'
  }])
  await waitFor(() => heard.length >= 1, { message: 'avviso al consumatore' })

  // Causa corretta: passa, e dietro di lei la successiva della stessa entita', nell'ordine.
  await drain(bus.cl, recordEffect())
  assert.deepEqual(await effects(), [other, dead, behind])
  assert.deepEqual((await deliveries()).map((d) => d.status), ['done', 'done', 'done'])
  assert.deepEqual(await openStall(), [])
})

test('un solo messaggio: le altre morte restano dove sono', async () => {
  const first = await publish(bus.ct, SALE, { entity: 'item-1' })
  const second = await publish(bus.ct, SALE, { entity: 'item-2' })
  await drain(bus.cl, rejecting([first, second]))

  const { rows } = await bus.admin.query("select message_id from bus.replay('logistics', $1)", [second])
  assert.deepEqual(rows.map((r) => r.message_id), [second])
  assert.deepEqual((await deliveries()).map((d) => d.status), ['dead', 'pending'])
})

test('nulla da rigiocare: nessuna riga e nessun cambiamento', async () => {
  await publish(bus.ct, SALE, { entity: 'item-1' })
  const { rows } = await bus.admin.query("select * from bus.replay('logistics')")
  assert.deepEqual(rows, [])
  assert.deepEqual((await deliveries()).map((d) => d.status), ['pending'])
})

test('solo l\'amministratore: nessuna app puo\' rigiocare, e un\'app sconosciuta e\' rifiutata', async () => {
  for (const client of [bus.ct, bus.cl, bus.acc]) {
    await assert.rejects(client.query("select * from bus.replay('logistics')"), { code: '42501' })
  }
  await assert.rejects(bus.admin.query("select * from bus.replay('magazzino')"), { code: '22023' })
})

test('comando bus-replay: di default elenca e non scrive, poi rigioca in una transazione', async () => {
  const dead = await publish(bus.ct, SALE, { entity: 'item-9' })
  await drain(bus.cl, rejecting([dead]))

  const listed = await listDead({ client: bus.admin, app: 'logistics' })
  assert.deepEqual(listed.map((r) => [r.message_id, r.topic, r.entity_ref, r.attempts]), [[dead, SALE, 'item-9', 1]])
  assert.match(formatDead(listed), /contratto non rispettato/)
  assert.deepEqual((await deliveries()).map((d) => d.status), ['dead'], 'l\'elenco non scrive')

  const replayed = await replay({ client: bus.admin, app: 'logistics', messageId: dead })
  assert.deepEqual(replayed.map((r) => r.message_id), [dead])
  assert.deepEqual((await deliveries()).map((d) => d.status), ['pending'])
  assert.deepEqual(await listDead({ client: bus.admin, app: 'logistics' }), [])
  await assert.rejects(listDead({ client: bus.admin, app: 'logistics', messageId: 'non-un-uuid' }), /uuid/)
})
