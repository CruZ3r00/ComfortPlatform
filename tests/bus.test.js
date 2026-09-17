'use strict'

// ADR-0014 §7 «Bus», su Postgres 17 con le migrazioni reali e gli utenti applicativi reali.

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

async function status(app) {
  const { rows } = await bus.admin.query('select * from bus.status() where app = $1', [app])
  return rows[0]
}

async function deliveries(app) {
  const { rows } = await bus.admin.query(
    `select m.id, m.entity_ref, m.seq, d.status, d.attempts, d.last_error, d.first_failed_at
       from bus.deliveries d join bus.messages m on m.id = d.message_id
      where d.app = $1 order by m.seq`,
    [app]
  )
  return rows
}

async function effects(client) {
  const { rows } = await client.query('select message_id, entity_ref, instance, processed from effects order by processed')
  return rows
}

async function nextFor(client) {
  const { rows } = await client.query('select * from bus.next()')
  return rows[0]
}

/** Rende subito dovuta una consegna fallita (il tempo non si puo' far scorrere). */
async function makeDue(messageId) {
  await bus.admin.query('update bus.deliveries set next_attempt_at = now() where message_id = $1', [messageId])
}

test('avviso solo al commit; transazione annullata: nessun messaggio e nessun avviso', async (t) => {
  const listener = await bus.connectAs('cl_app')
  t.after(() => listener.end())
  const heard = await listen(listener, 'bus_logistics')

  await bus.ct.query('begin')
  const committed = await publish(bus.ct, SALE, { entity: 'item-1' })
  await sleep(300)
  assert.equal(heard.length, 0, 'avviso prima del commit')
  await bus.ct.query('commit')
  await waitFor(() => heard.length === 1, { message: 'avviso del commit' })

  await bus.ct.query('begin')
  await publish(bus.ct, SALE, { entity: 'item-2' })
  await bus.ct.query('rollback')

  // Sentinella confermata dopo: gli avvisi arrivano in ordine di commit, quindi se quello annullato
  // esistesse sarebbe arrivato prima di lei.
  const sentinel = await publish(bus.ct, SALE, { entity: 'item-3' })
  await waitFor(() => heard.length >= 2, { message: 'avviso della sentinella' })
  await sleep(200)
  assert.equal(heard.length, 2)
  assert.deepEqual(heard.map((n) => n.payload), ['', ''])

  const { rows } = await bus.admin.query('select id, entity_ref from bus.messages order by seq')
  assert.deepEqual(rows, [
    { id: committed, entity_ref: 'item-1' },
    { id: sentinel, entity_ref: 'item-3' }
  ])
})

test('destinatario spento: consegne pending, elaborate in ordine al riavvio', async () => {
  const ids = []
  for (let i = 1; i <= 5; i++) ids.push(await publish(bus.ct, SALE, { entity: `item-${i}` }))

  const before = await status('logistics')
  assert.equal(before.pending, 5)
  assert.ok(before.oldest_pending_at instanceof Date)
  assert.deepEqual((await deliveries('logistics')).map((d) => d.status), Array(5).fill('pending'))

  // Riavvio: svuotamento della coda.
  const results = await drain(bus.cl, recordEffect())
  assert.deepEqual(results.map((r) => [r.message.message_id, r.ok]), ids.map((id) => [id, true]))
  assert.deepEqual((await effects(bus.cl)).map((e) => e.message_id), ids)

  const after = await status('logistics')
  assert.equal(after.pending, 0)
  assert.equal(after.oldest_pending_at, null)
  assert.deepEqual((await deliveries('logistics')).map((d) => d.status), Array(5).fill('done'))
})

test('handler che fallisce: effetto annullato, retry con backoff, dead al decimo tentativo', async () => {
  const id = await publish(bus.ct, SALE, { entity: 'item-1' })
  const waits = [10, 60, 300, 1800, 3600, 3600, 3600, 3600, 3600]

  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) {
      await bus.cl.query('begin')
      assert.equal(await nextFor(bus.cl), undefined, `consegna restituita prima del retry ${attempt}`)
      await bus.cl.query('commit')
      await makeDue(id)
    }

    await bus.cl.query('begin')
    const message = await nextFor(bus.cl)
    assert.equal(message.message_id, id)
    assert.equal(message.attempts, attempt - 1)
    await recordEffect()(bus.cl, message)
    await bus.cl.query('rollback')

    const { rows: [failure] } = await bus.cl.query(
      `select f.status, f.attempts, extract(epoch from f.next_attempt_at - now())::int as wait
         from bus.fail($1, 'handler rotto') f`,
      [id]
    )
    if (attempt < 10) assert.deepEqual(failure, { status: 'failed', attempts: attempt, wait: waits[attempt - 1] })
    else assert.deepEqual(failure, { status: 'dead', attempts: 10, wait: null })
  }

  assert.deepEqual(await effects(bus.cl), [])
  const [delivery] = await deliveries('logistics')
  assert.equal(delivery.status, 'dead')
  assert.equal(delivery.last_error, 'handler rotto')
  assert.ok(delivery.first_failed_at instanceof Date)

  await makeDue(id)
  await bus.cl.query('begin')
  assert.equal(await nextFor(bus.cl), undefined, 'una consegna dead non si elabora')
  await bus.cl.query('commit')
  const state = await status('logistics')
  assert.deepEqual([state.pending, state.failed, state.dead], [0, 0, 1])
})

test('tre istanze della stessa app in parallelo: ogni messaggio elaborato una sola volta, in ordine per entita\'', async (t) => {
  const instances = await Promise.all([1, 2, 3].map(() => bus.connectAs('cl_app')))
  t.after(() => Promise.all(instances.map((client) => client.end())))

  const published = []
  for (let i = 0; i < 60; i++) {
    const entity = `item-${i % 12}`
    published.push({ id: await publish(bus.ct, SALE, { entity }), entity })
  }

  const slow = (name) => async (client, message) => {
    await recordEffect(name)(client, message)
    await client.query('select pg_sleep(0.005)')
  }
  const results = await Promise.all(instances.map((client, i) => drain(client, slow(`istanza-${i + 1}`))))

  assert.equal(results.flat().filter((r) => !r.ok).length, 0)
  const done = await effects(bus.cl)
  assert.equal(done.length, 60)
  assert.equal(new Set(done.map((e) => e.message_id)).size, 60)
  assert.ok(new Set(done.map((e) => e.instance)).size >= 2, 'una sola istanza ha lavorato')
  assert.equal((await status('logistics')).pending, 0)

  // Per ogni entita' l'ordine di elaborazione e' quello di pubblicazione.
  const processed = new Map(done.map((e) => [e.message_id, Number(e.processed)]))
  for (let entity = 0; entity < 12; entity++) {
    const order = published.filter((m) => m.entity === `item-${entity}`).map((m) => processed.get(m.id))
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `ordine violato per item-${entity}`)
  }
})

test('ordine per entity_ref con un messaggio precedente fallito', async () => {
  const first = await publish(bus.ct, SALE, { entity: 'item-x' })
  const second = await publish(bus.ct, SALE, { entity: 'item-x' })
  const other = await publish(bus.ct, SALE, { entity: 'item-y' })

  await bus.cl.query('begin')
  assert.equal((await nextFor(bus.cl)).message_id, first)
  await bus.cl.query('rollback')
  await bus.cl.query("select bus.fail($1, 'giacenza non trovata')", [first])

  // Il secondo di item-x aspetta il primo; item-y no.
  await bus.cl.query('begin')
  assert.equal((await nextFor(bus.cl)).message_id, other)
  await bus.cl.query('select bus.ack($1)', [other])
  await bus.cl.query('commit')
  await bus.cl.query('begin')
  assert.equal(await nextFor(bus.cl), undefined)
  await bus.cl.query('commit')

  await makeDue(first)
  for (const expected of [first, second]) {
    await bus.cl.query('begin')
    assert.equal((await nextFor(bus.cl)).message_id, expected)
    await bus.cl.query('select bus.ack($1)', [expected])
    await bus.cl.query('commit')
  }
})

test('ordine per entity_ref con il precedente in elaborazione in un\'altra istanza', async (t) => {
  const other = await bus.connectAs('cl_app')
  t.after(() => other.end())
  const first = await publish(bus.ct, SALE, { entity: 'item-z' })
  const second = await publish(bus.ct, SALE, { entity: 'item-z' })
  const unrelated = await publish(bus.ct, SALE, { entity: 'item-w' })

  await bus.cl.query('begin')
  assert.equal((await nextFor(bus.cl)).message_id, first)

  await other.query('begin')
  assert.equal((await nextFor(other)).message_id, unrelated, 'bloccata o fuori ordine')
  await other.query('select bus.ack($1)', [unrelated])
  await other.query('commit')
  await other.query('begin')
  assert.equal(await nextFor(other), undefined, 'secondo di item-z restituito mentre il primo e\' in elaborazione')
  await other.query('commit')

  await bus.cl.query('select bus.ack($1)', [first])
  await bus.cl.query('commit')
  await other.query('begin')
  assert.equal((await nextFor(other)).message_id, second)
  await other.query('select bus.ack($1)', [second])
  await other.query('commit')
})

test('pubblicazione rifiutata: argomento di un\'altra app, inesistente, utente non app, senza organizzazione', async (t) => {
  await assert.rejects(publish(bus.ct, AVAILABILITY, { entity: 'dish-1' }), (err) => {
    assert.equal(err.code, '42501')
    assert.match(err.message, /l'app comfortables non produce l'argomento logistics\.availability\.changed \(produttore logistics\)/)
    return true
  })
  await assert.rejects(publish(bus.ct, 'tables.sales.inesistente'), { code: '42704' })
  await assert.rejects(publish(bus.ct, SALE, { organizationId: null }), { code: '23502' })

  // L'amministratore e' l'app `platform`: non produce argomenti di ComforTables.
  await assert.rejects(publish(bus.admin, SALE), { code: '42501' })

  const superuser = await server.connect({ ...server.connection, database: bus.db.name })
  t.after(() => superuser.end())
  await assert.rejects(publish(superuser, SALE), (err) => {
    assert.equal(err.code, '42501')
    assert.match(err.message, /l'utente postgres non e' un'app registrata nel bus/)
    return true
  })

  const site = await bus.connectAs('cs_site')
  t.after(() => site.end())
  await assert.rejects(publish(site, SALE), { code: '42501' })

  const { rows } = await bus.admin.query('select count(*)::int as n from bus.messages')
  assert.equal(rows[0].n, 0)
})

test('versioni in parallelo: ogni iscritto riceve solo la sua versione, anche dopo il passaggio a v2', async () => {
  const topic = 'tables.prova.versioni'
  await bus.admin.query("insert into bus.topics (name, producer) values ($1, 'comfortables')", [topic])
  await bus.admin.query('insert into bus.topic_versions (topic, schema_version) values ($1, 1), ($1, 2)', [topic])
  await bus.admin.query("insert into bus.subscriptions (app, topic, schema_version) values ('logistics', $1, 1)", [topic])

  // ComforTables gia' aggiornata pubblica v1 e v2 nella stessa transazione; ComfortLogistics e' ancora a v1.
  await bus.ct.query('begin')
  const oldV1 = await publish(bus.ct, topic, { schemaVersion: 1, entity: 'dish-1', payload: { price: 9 } })
  const oldV2 = await publish(bus.ct, topic, { schemaVersion: 2, entity: 'dish-1', payload: { price: { amount: 9, currency: 'EUR' } } })
  await bus.ct.query('commit')
  assert.ok(oldV1)
  assert.equal(oldV2, null, 'messaggio v2 salvato senza iscritti')

  // ComfortLogistics passa a v2 (migrazione di piattaforma) con la consegna v1 ancora in coda.
  await bus.admin.query("update bus.subscriptions set schema_version = 2 where app = 'logistics' and topic = $1", [topic])
  await bus.ct.query('begin')
  const newV1 = await publish(bus.ct, topic, { schemaVersion: 1, entity: 'dish-1', payload: { price: 10 } })
  const newV2 = await publish(bus.ct, topic, { schemaVersion: 2, entity: 'dish-1', payload: { price: { amount: 10, currency: 'EUR' } } })
  await bus.ct.query('commit')
  assert.equal(newV1, null, 'messaggio v1 salvato senza iscritti')
  assert.ok(newV2)

  // La consegna v1 in coda precede la v2 della stessa entita', anche se fallisce.
  const failed = await drain(bus.cl, async (client, message) => {
    if (message.schema_version === 1) throw new Error('la nuova release non gestisce ancora v1')
    await recordEffect()(client, message)
  })
  assert.deepEqual(failed.map((r) => [r.message.message_id, r.ok]), [[oldV1, false]])

  await bus.admin.query('update bus.deliveries set next_attempt_at = now() where message_id = $1', [oldV1])
  const results = await drain(bus.cl, recordEffect())
  assert.deepEqual(
    results.map((r) => [r.message.message_id, r.message.schema_version, r.message.payload]),
    [
      [oldV1, 1, { price: 9 }],
      [newV2, 2, { price: { amount: 10, currency: 'EUR' } }]
    ]
  )
  const { rows } = await bus.admin.query('select schema_version from bus.messages where topic = $1 order by seq', [topic])
  assert.deepEqual(rows.map((r) => r.schema_version), [1, 2])
})

test('versioni: registrazione obbligatoria, una sola versione per iscritto, versioni in uso non eliminabili', async () => {
  await assert.rejects(publish(bus.ct, SALE, { schemaVersion: 2 }), (err) => {
    assert.equal(err.code, '42704')
    assert.match(err.message, /versione 2 dell'argomento tables\.sales\.item_served non registrata/)
    return true
  })
  await assert.rejects(publish(bus.ct, SALE, { schemaVersion: null }), { code: '23502' })
  await assert.rejects(
    bus.admin.query("insert into bus.subscriptions (app, topic, schema_version) values ('comfortables', $1, 2)", [SALE]),
    { code: '23503' }
  )

  await bus.admin.query('insert into bus.topic_versions (topic, schema_version) values ($1, 2)', [SALE])
  await assert.rejects(
    bus.admin.query("insert into bus.subscriptions (app, topic, schema_version) values ('logistics', $1, 2)", [SALE]),
    { code: '23505' },
    'app iscritta a due versioni dello stesso argomento'
  )
  assert.equal(await publish(bus.ct, SALE, { schemaVersion: 2, entity: 'item-1' }), null)

  // v1 ha un iscritto e un messaggio: non si elimina. Senza iscritti la trattiene il messaggio.
  await publish(bus.ct, SALE, { schemaVersion: 1, entity: 'item-1' })
  const dropV1 = () => bus.admin.query('delete from bus.topic_versions where topic = $1 and schema_version = 1', [SALE])
  await assert.rejects(dropV1(), { code: '23503' })
  await bus.admin.query("update bus.subscriptions set schema_version = 2 where app = 'logistics' and topic = $1", [SALE])
  await assert.rejects(dropV1(), { code: '23503' })

  // Ripristino della fixture: logistics a v1, v2 non usata eliminabile.
  await bus.admin.query("update bus.subscriptions set schema_version = 1 where app = 'logistics' and topic = $1", [SALE])
  await bus.admin.query('delete from bus.topic_versions where topic = $1 and schema_version = 2', [SALE])
  const { rows } = await bus.admin.query('select schema_version, count(*)::int as n from bus.messages group by 1')
  assert.deepEqual(rows, [{ schema_version: 1, n: 1 }])
})

test('messaggio sensibile: payload cancellato quando tutte le consegne sono concluse', async () => {
  const payload = { person: 'p-1', hash: 'eyJhbGciOiJFQ0RILUVTK0EyNTZLVyJ9.cifrato.iv.testo.tag' }
  const id = await publish(bus.acc, PASSWORD_CHANGED, { entity: 'person-1', payload })
  const plain = await publish(bus.ct, SALE, { entity: 'item-1' })
  const message = async (messageId) =>
    (await bus.admin.query('select payload, payload_erased_at from bus.messages where id = $1', [messageId])).rows[0]

  await drain(bus.ct, recordEffect())
  assert.deepEqual(await message(id), { payload, payload_erased_at: null })

  await drain(bus.cl, recordEffect())
  const erased = await message(id)
  assert.equal(erased.payload, null)
  assert.ok(erased.payload_erased_at instanceof Date)
  assert.deepEqual((await message(plain)).payload, { ok: true })
})

test('messaggio sensibile: conferme contemporanee delle ultime due consegne cancellano comunque il payload', async () => {
  const id = await publish(bus.acc, PASSWORD_CHANGED, { entity: 'person-2', payload: { hash: 'jwe' } })

  await bus.ct.query('begin')
  assert.equal((await nextFor(bus.ct)).message_id, id)
  await bus.cl.query('begin')
  assert.equal((await nextFor(bus.cl)).message_id, id)

  await bus.ct.query('select bus.ack($1)', [id])
  const second = bus.cl.query('select bus.ack($1)', [id])
  await sleep(100)
  await bus.ct.query('commit')
  await second
  await bus.cl.query('commit')

  const { rows: [row] } = await bus.admin.query('select payload, payload_erased_at is not null as erased from bus.messages where id = $1', [id])
  assert.deepEqual(row, { payload: null, erased: true })
})

test('messaggio non valido per il contratto: dead subito e le successive della stessa entita\' restano ferme', async () => {
  const invalid = await publish(bus.ct, SALE, { entity: 'item-q', payload: { quantita: 'tante' } })
  const next = await publish(bus.ct, SALE, { entity: 'item-q' })

  // La validazione del contratto e' della libreria (sessione futura): qui il suo esito sul database.
  const results = await drain(bus.cl, async () => {
    throw Object.assign(new Error('contratto: quantita deve essere un numero'), { permanent: true })
  })
  assert.equal(results.length, 1)
  assert.equal(results[0].message.message_id, invalid)
  assert.equal(results[0].failure.status, 'dead')
  assert.equal(results[0].failure.attempts, 1)
  assert.equal(results[0].failure.next_attempt_at, null)

  assert.deepEqual((await deliveries('logistics')).map((d) => [d.id, d.status]), [[invalid, 'dead'], [next, 'pending']])
  const state = await status('logistics')
  assert.deepEqual([state.pending, state.dead, state.stall_kind], [1, 1, 'dead'])
})

test('un\'app conferma o fa fallire solo le proprie consegne', async () => {
  const id = await publish(bus.ct, SALE, { entity: 'item-1' })

  await assert.rejects(bus.ct.query('select bus.ack($1)', [id]), { code: 'P0002' })
  await assert.rejects(bus.ct.query("select bus.fail($1, 'non mia')", [id]), { code: 'P0002' })
  await assert.rejects(bus.cl.query('select bus.ack($1)', ['00000000-0000-4000-8000-000000000000']), { code: 'P0002' })
  assert.equal((await deliveries('logistics'))[0].status, 'pending')

  await bus.cl.query('select bus.ack($1)', [id])
  await assert.rejects(bus.cl.query('select bus.ack($1)', [id]), (err) => {
    assert.equal(err.code, '55000')
    assert.match(err.message, /e' gia' done/)
    return true
  })
  // `fail` dopo la conferma di un'altra istanza non riapre la consegna.
  const { rows: [failure] } = await bus.cl.query("select * from bus.fail($1, 'tardivo')", [id])
  assert.deepEqual(failure, { status: 'done', attempts: 0, next_attempt_at: null })
})

test('identita\' da session_user: SET ROLE e SET SESSION AUTHORIZATION verso un\'altra app rifiutati', async () => {
  await assert.rejects(bus.cl.query('set role ct_app'), { code: '42501' })
  await assert.rejects(bus.cl.query('set session authorization ct_app'), { code: '42501' })
  await assert.rejects(publish(bus.cl, SALE), { code: '42501' })
  const id = await publish(bus.cl, AVAILABILITY, { entity: 'dish-1' })
  const { rows } = await bus.admin.query('select producer from bus.messages where id = $1', [id])
  assert.equal(rows[0].producer, 'logistics')
})

test('cleanup: elimina solo i messaggi conclusi oltre i giorni di conservazione', async () => {
  const oldDone = await publish(bus.ct, SALE, { entity: 'item-1' })
  const oldPending = await publish(bus.ct, SALE, { entity: 'item-2' })
  const oldDead = await publish(bus.ct, SALE, { entity: 'item-3' })
  const recentDone = await publish(bus.ct, SALE, { entity: 'item-4' })

  for (const id of [oldDone, recentDone]) await bus.cl.query('select bus.ack($1)', [id])
  await bus.cl.query("select bus.fail($1, 'rotto', true)", [oldDead])
  await bus.admin.query(
    "update bus.messages set published_at = now() - interval '31 days' where id = any($1::uuid[])",
    [[oldDone, oldPending, oldDead]]
  )

  const { rows: [cleaned] } = await bus.admin.query('select bus.cleanup() as deleted')
  assert.equal(cleaned.deleted, 1)
  const { rows } = await bus.admin.query('select id from bus.messages order by seq')
  assert.deepEqual(rows.map((r) => r.id), [oldPending, oldDead, recentDone])
  const { rows: orphans } = await bus.admin.query('select count(*)::int as n from bus.deliveries where message_id = $1', [oldDone])
  assert.equal(orphans[0].n, 0)
})
