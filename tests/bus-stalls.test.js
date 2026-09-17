'use strict'

// ADR-0014 §14.9 e §7 «Avvisi»: blocchi rilevati in publish, fail e ack, presa in carico unica dell'email.
// Il tempo non scorre nei test: i timestamp vengono spostati indietro dall'amministratore.

const { before, beforeEach, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { setTimeout: sleep } = require('node:timers/promises')
const { startPostgres } = require('../testing')
const { drain, listen, publish, recordEffect, setupBus, waitFor } = require('./helpers/platform')

const SALE = 'tables.sales.item_served'
const AVAILABILITY = 'logistics.availability.changed'
const PASSWORD_CHANGED = 'account.password_changed'

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

async function stalls(app) {
  const { rows } = await bus.admin.query('select * from bus.stalls where app = $1 order by id', [app])
  return rows
}

async function status(app) {
  const { rows } = await bus.admin.query('select * from bus.status() where app = $1', [app])
  return rows[0]
}

async function agePublished(minutes) {
  await bus.admin.query("update bus.messages set published_at = published_at - make_interval(mins => $1)", [minutes])
}

async function ageStalls(minutes) {
  await bus.admin.query("update bus.stalls set opened_at = opened_at - make_interval(mins => $1)", [minutes])
}

async function notices(client = bus.ct) {
  const { rows } = await client.query('select stall_id, kind, app, stall_kind from bus.stall_notices()')
  return rows
}

async function claim(client, stallId, kind) {
  const { rows } = await client.query('select * from bus.claim_stall_notice($1, $2)', [stallId, kind])
  return rows
}

async function failOnce(messageId, { permanent = false } = {}) {
  await bus.admin.query('update bus.deliveries set next_attempt_at = now() where message_id = $1', [messageId])
  const { rows } = await bus.cl.query("select * from bus.fail($1, 'giacenza non trovata', $2)", [messageId, permanent])
  return rows[0]
}

/** Blocco `backlog` di ComfortLogistics: un messaggio fermo da piu' di 5 minuti e una nuova pubblicazione. */
async function logisticsBacklog() {
  await publish(bus.ct, SALE, { entity: 'item-1' })
  await agePublished(6)
  await publish(bus.ct, SALE, { entity: 'item-2' })
  const [stall] = await stalls('logistics')
  assert.equal(stall?.kind, 'backlog')
  return stall
}

test('backlog: aperto dalla prima pubblicazione dopo 5 minuti, avviso su bus_stalls, nessun duplicato', async (t) => {
  const listener = await bus.connectAs('cs_account')
  t.after(() => listener.end())
  const heard = await listen(listener, 'bus_stalls')

  const first = await publish(bus.ct, SALE, { entity: 'item-1' })
  await agePublished(4)
  await publish(bus.ct, SALE, { entity: 'item-2' })
  assert.deepEqual(await stalls('logistics'), [], 'blocco aperto prima dei 5 minuti')

  await agePublished(2)
  await publish(bus.ct, SALE, { entity: 'item-3' })
  const [stall] = await stalls('logistics')
  assert.equal(stall.kind, 'backlog')
  assert.equal(stall.waiting_count, 3)
  const { rows: [oldest] } = await bus.admin.query('select published_at from bus.messages where id = $1', [first])
  assert.equal(stall.oldest_waiting_at.getTime(), oldest.published_at.getTime())
  await waitFor(() => heard.length >= 1, { message: 'avviso di apertura' })

  const state = await status('logistics')
  assert.deepEqual([state.stall_id, state.stall_kind, state.banner_at], [stall.id, 'backlog', null])

  // Altre pubblicazioni: stesso blocco, e nuovo avviso finche' l'email non e' inviata.
  const heardBefore = heard.length
  await publish(bus.ct, SALE, { entity: 'item-4' })
  assert.equal((await stalls('logistics')).length, 1)
  await waitFor(() => heard.length > heardBefore, { message: 'avviso di ripresa' })
  assert.deepEqual(await stalls('comfortables'), [])
})

test('banner dopo 15 minuti: ComfortLogistics, e ComforTables solo sui messaggi logistics.*', async () => {
  // ComfortLogistics bloccata da 16 minuti: banner alla pubblicazione successiva.
  await logisticsBacklog()
  await ageStalls(14)
  await publish(bus.ct, SALE, { entity: 'item-3' })
  assert.equal((await stalls('logistics'))[0].banner_at, null, 'banner prima dei 15 minuti')
  await ageStalls(2)
  await publish(bus.ct, SALE, { entity: 'item-4' })
  assert.ok((await stalls('logistics'))[0].banner_at instanceof Date)
  assert.ok((await status('logistics')).banner_at instanceof Date)

  // ComforTables bloccata su un messaggio di ComfortLogistics: banner.
  await bus.reset()
  await publish(bus.cl, AVAILABILITY, { entity: 'dish-1' })
  await agePublished(6)
  await publish(bus.cl, AVAILABILITY, { entity: 'dish-2' })
  await ageStalls(16)
  await publish(bus.cl, AVAILABILITY, { entity: 'dish-3' })
  assert.ok((await stalls('comfortables'))[0].banner_at instanceof Date)

  // ComforTables bloccata solo su messaggi account.*: nessun banner; ComfortLogistics si'.
  await bus.reset()
  await publish(bus.acc, PASSWORD_CHANGED, { entity: 'person-1', payload: { hash: 'jwe' } })
  await agePublished(6)
  await publish(bus.acc, PASSWORD_CHANGED, { entity: 'person-2', payload: { hash: 'jwe' } })
  await ageStalls(16)
  await publish(bus.acc, PASSWORD_CHANGED, { entity: 'person-3', payload: { hash: 'jwe' } })
  assert.equal((await stalls('comfortables'))[0].banner_at, null)
  assert.ok((await stalls('logistics'))[0].banner_at instanceof Date)
})

test('failing al terzo tentativo, dead subito, stesso blocco con gravita\' crescente', async () => {
  const id = await publish(bus.ct, SALE, { entity: 'item-1' })

  await failOnce(id)
  await failOnce(id)
  assert.deepEqual(await stalls('logistics'), [], 'blocco aperto prima del terzo tentativo')

  await failOnce(id)
  const [failing] = await stalls('logistics')
  assert.deepEqual([failing.kind, failing.waiting_count, failing.last_error], ['failing', 1, 'giacenza non trovata'])

  for (let attempt = 4; attempt <= 10; attempt++) await failOnce(id)
  const all = await stalls('logistics')
  assert.equal(all.length, 1)
  assert.deepEqual([all[0].id, all[0].kind], [failing.id, 'dead'])

  // Un messaggio dead apre subito un blocco anche senza tentativi precedenti.
  await bus.reset()
  const invalid = await publish(bus.ct, SALE, { entity: 'item-2' })
  const failure = await failOnce(invalid, { permanent: true })
  assert.equal(failure.status, 'dead')
  assert.equal((await stalls('logistics'))[0].kind, 'dead')
})

test('ack chiude il blocco solo quando non restano consegne scadute o fallite', async (t) => {
  const listener = await bus.connectAs('ct_app')
  t.after(() => listener.end())
  const heard = await listen(listener, 'bus_stalls')

  const broken = await publish(bus.ct, SALE, { entity: 'item-rotto' })
  await agePublished(6)
  await publish(bus.ct, SALE, { entity: 'item-1' })
  const [stall] = await stalls('logistics')
  assert.equal(stall.kind, 'backlog')

  // Ripresa: il messaggio vecchio fallisce, l'altro viene confermato. Resta una consegna fallita.
  const results = await drain(bus.cl, async (client, message) => {
    if (message.entity_ref === 'item-rotto') throw new Error('giacenza non trovata')
    await recordEffect()(client, message)
  })
  assert.deepEqual(results.map((r) => [r.message.entity_ref, r.ok]), [['item-rotto', false], ['item-1', true]])
  assert.equal((await stalls('logistics'))[0].closed_at, null, 'blocco chiuso con una consegna fallita')

  const heardBefore = heard.length
  await bus.admin.query('update bus.deliveries set next_attempt_at = now() where message_id = $1', [broken])
  await drain(bus.cl, recordEffect())
  const [closed] = await stalls('logistics')
  assert.equal(closed.id, stall.id)
  assert.ok(closed.closed_at instanceof Date)
  assert.equal(closed.processed_count, 2)
  await waitFor(() => heard.length > heardBefore, { message: 'avviso di chiusura' })
  assert.equal((await status('logistics')).stall_id, null)
})

test('una sola email: presa in carico contemporanea, rilascio, presa abbandonata, risoluzione', async (t) => {
  const stall = await logisticsBacklog()
  assert.deepEqual(await notices(), [{ stall_id: stall.id, kind: 'opened', app: 'logistics', stall_kind: 'backlog' }])
  await assert.rejects(claim(bus.ct, stall.id, 'altro'), { code: '22023' })

  // Due app attive prendono lo stesso avviso insieme: una sola riceve la riga.
  await bus.ct.query('begin')
  await bus.acc.query('begin')
  const ctClaim = await claim(bus.ct, stall.id, 'opened')
  const accClaim = claim(bus.acc, stall.id, 'opened')
  await sleep(100)
  await bus.ct.query('commit')
  assert.deepEqual(await accClaim, [])
  await bus.acc.query('commit')
  assert.equal(ctClaim.length, 1)
  assert.deepEqual(
    [ctClaim[0].kind, ctClaim[0].app, ctClaim[0].stall_kind, ctClaim[0].waiting_count],
    ['opened', 'logistics', 'backlog', 2]
  )
  assert.deepEqual(await notices(), [])
  assert.deepEqual(await claim(bus.cl, stall.id, 'opened'), [])

  // Solo chi l'ha preso puo' completarlo o rilasciarlo.
  await assert.rejects(bus.acc.query("select bus.complete_stall_notice($1, 'opened')", [stall.id]), { code: '55000' })
  await assert.rejects(bus.acc.query("select bus.release_stall_notice($1, 'opened')", [stall.id]), { code: '55000' })

  // Invio fallito: rilascio, avviso alle app, un'altra app lo prende.
  const listener = await bus.connectAs('cl_app')
  t.after(() => listener.end())
  const heard = await listen(listener, 'bus_stalls')
  await bus.ct.query("select bus.release_stall_notice($1, 'opened')", [stall.id])
  await waitFor(() => heard.length >= 1, { message: 'avviso di rilascio' })
  assert.equal((await claim(bus.acc, stall.id, 'opened')).length, 1)

  // Presa abbandonata (app caduta durante l'invio): dopo 5 minuti un'altra app la riprende.
  assert.deepEqual(await claim(bus.cl, stall.id, 'opened'), [])
  await bus.admin.query("update bus.stalls set opened_claimed_at = now() - interval '6 minutes' where id = $1", [stall.id])
  assert.equal((await claim(bus.cl, stall.id, 'opened')).length, 1)
  await assert.rejects(bus.acc.query("select bus.complete_stall_notice($1, 'opened')", [stall.id]), { code: '55000' })
  await bus.cl.query("select bus.complete_stall_notice($1, 'opened')", [stall.id])
  assert.deepEqual(await notices(), [])
  assert.deepEqual(await claim(bus.ct, stall.id, 'opened'), [])

  // L'email "risolto" non e' prendibile finche' il blocco e' aperto.
  assert.deepEqual(await claim(bus.ct, stall.id, 'resolved'), [])
  await drain(bus.cl, recordEffect())
  assert.deepEqual(await notices(), [{ stall_id: stall.id, kind: 'resolved', app: 'logistics', stall_kind: 'backlog' }])

  await bus.ct.query('begin')
  await bus.acc.query('begin')
  const resolved = await claim(bus.ct, stall.id, 'resolved')
  const late = claim(bus.acc, stall.id, 'resolved')
  await sleep(100)
  await bus.ct.query('commit')
  assert.deepEqual(await late, [])
  await bus.acc.query('commit')
  assert.equal(resolved.length, 1)
  assert.ok(resolved[0].closed_at instanceof Date)
  // Chiuso alla prima conferma: dopo quella non restava nulla di scaduto.
  assert.equal(resolved[0].processed_count, 1)
  await bus.ct.query("select bus.complete_stall_notice($1, 'resolved')", [stall.id])
  assert.deepEqual(await notices(), [])
})

test('blocco chiuso prima dell\'email di apertura: resta da inviare solo "blocco", non "risolto"', async () => {
  const stall = await logisticsBacklog()
  await drain(bus.cl, recordEffect())
  assert.ok((await stalls('logistics'))[0].closed_at instanceof Date)
  assert.deepEqual(await notices(), [{ stall_id: stall.id, kind: 'opened', app: 'logistics', stall_kind: 'backlog' }])
  assert.deepEqual(await claim(bus.ct, stall.id, 'resolved'), [])
})
