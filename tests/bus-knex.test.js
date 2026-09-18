'use strict'

// Adattatore knex (bus/client/knex.js): pubblicare dalla transazione di un'app che
// parla con il database tramite knex, come Strapi in ComforTables.

const { before, beforeEach, after, test } = require('node:test')
const assert = require('node:assert/strict')
const createKnex = require('knex')
const { startPostgres } = require('../testing')
const { setupBus } = require('./helpers/platform')
const { VALID } = require('./helpers/contract-examples')
const { knexClient, publish } = require('..')
const { toPositional } = require('../bus/client/knex')

const ORG = 'a1b2c3d4-1111-4222-8333-444444444444'
const SALE = 'tables.sales.item_served'

let server
let bus
let db

before(async () => {
  server = await startPostgres()
  bus = await setupBus(server)
  // Come Strapi: knex sul client pg, con l'utente dell'app. Lo schema arriva dal ruolo.
  db = createKnex({ client: 'pg', connection: bus.configFor('ct_app'), pool: { min: 0, max: 4 } })
})
beforeEach(() => bus.reset())
after(async () => {
  await db?.destroy()
  await server?.stop()
})

const sale = (itemRef) => ({ ...VALID[SALE], item_ref: itemRef })
const messages = () => bus.admin.query('select topic, organization_id, entity_ref, request_id, payload from bus.messages order by seq')

test('segnaposto: ordine di apparizione, ripetizioni e indici non crescenti', () => {
  assert.deepEqual(toPositional('select $1, $2', ['a', 'b']), { sql: 'select ?, ?', bindings: ['a', 'b'] })
  // knex lega per posizione: l'elenco va ricostruito seguendo il testo, non l'indice.
  assert.deepEqual(toPositional('select $2, $1', ['a', 'b']), { sql: 'select ?, ?', bindings: ['b', 'a'] })
  assert.deepEqual(toPositional('select $1, $1', ['a']), { sql: 'select ?, ?', bindings: ['a', 'a'] })
  assert.throws(() => toPositional('select $3', ['a']), RangeError)
})

test('pubblica dalla transazione dell\'operazione e la restituisce con { rows }', async () => {
  const itemRef = 'it-knex-1'
  await db.transaction(async (trx) => {
    await trx('effects').insert({ message_id: '11111111-1111-4111-8111-111111111111', entity_ref: `item:${itemRef}` })
    const id = await publish(knexClient(trx), SALE, { schemaVersion: 1, organizationId: ORG, payload: sale(itemRef) })
    assert.match(id, /^[0-9a-f-]{36}$/, 'publish restituisce l\'id del messaggio')
  })

  const { rows } = await messages()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].topic, SALE)
  assert.equal(rows[0].organization_id, ORG)
  assert.equal(rows[0].entity_ref, `item:${itemRef}`, 'la chiave di entità la ricava la libreria dal catalogo')
  assert.equal(rows[0].payload.item_ref, itemRef)
})

test('operazione annullata: nessun messaggio e nessun effetto', async () => {
  await assert.rejects(db.transaction(async (trx) => {
    await trx('effects').insert({ message_id: '22222222-2222-4222-8222-222222222222', entity_ref: 'item:it-knex-2' })
    await publish(knexClient(trx), SALE, { schemaVersion: 1, organizationId: ORG, payload: sale('it-knex-2') })
    throw new Error('operazione fallita dopo la pubblicazione')
  }), /operazione fallita/)

  assert.equal((await messages()).rows.length, 0, 'il messaggio nasce e muore con l\'operazione')
  const effects = await db('effects').count({ total: '*' })
  assert.equal(Number(effects[0].total), 0)
})

test('il messaggio non è visibile finché la transazione non ha fatto commit', async () => {
  let seenDuring = null
  await db.transaction(async (trx) => {
    await publish(knexClient(trx), SALE, { schemaVersion: 1, organizationId: ORG, payload: sale('it-knex-3') })
    // Connessione diversa, fuori dalla transazione: non deve vedere nulla.
    seenDuring = (await messages()).rows.length
  })
  assert.equal(seenDuring, 0)
  assert.equal((await messages()).rows.length, 1, 'dopo il commit il messaggio c\'è')
})

test('richiesta con request_id e payload non valido rifiutato prima di scrivere', async () => {
  const requestId = 'c3d5a1e2-7b8f-4c6d-9e0a-1b2c3d4e5f60'
  await db.transaction(async (trx) => {
    await publish(knexClient(trx), 'tables.bar.preview_requested', {
      schemaVersion: 1, organizationId: ORG, requestId, payload: VALID['tables.bar.preview_requested']
    })
  })
  const { rows } = await messages()
  assert.equal(rows[0].request_id, requestId)

  await assert.rejects(db.transaction(async (trx) => {
    await publish(knexClient(trx), SALE, { schemaVersion: 1, organizationId: ORG, payload: { item_ref: 'solo-questo' } })
  }), (error) => error.code === 'BUS_CONTRACT')
  assert.equal((await messages()).rows.length, 1, 'il payload non valido non lascia nulla')
})

test('risposta gia\' ridotta a righe da un postProcessResponse dell\'app', async () => {
  // knex restituisce il Result di pg, ma un'app puo' configurare `postProcessResponse`
  // e consegnare direttamente l'elenco delle righe: l'adattatore normalizza entrambe.
  const seen = []
  const fake = { raw: (sql, bindings) => { seen.push({ sql, bindings }); return [{ id: 'abc' }] } }
  assert.deepEqual(await knexClient(fake).query('select bus.publish($1) as id', ['x']), { rows: [{ id: 'abc' }] })
  assert.deepEqual(seen, [{ sql: 'select bus.publish(?) as id', bindings: ['x'] }])

  const empty = { raw: () => undefined }
  assert.deepEqual(await knexClient(empty).query('select 1', []), { rows: [] })
})

test('senza una transazione knex l\'adattatore si rifiuta di costruire', () => {
  assert.throws(() => knexClient(null), TypeError)
  assert.throws(() => knexClient({}), TypeError)
})
