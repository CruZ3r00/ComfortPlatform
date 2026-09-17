'use strict'

// Contratto v1 del bus (ADR-0014 §14.8): catalogo, JSON Schema e campi del messaggio.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { ContractError, catalog, getTopic, messageFields, topics, validatePayload } = require('../bus/contract')

const CONTRACT_DIR = path.resolve(__dirname, '..', 'bus', 'contract')
const { ORG, REQUEST, JWE, dish, VALID } = require('./helpers/contract-examples')

/** Varianti non valide: [descrizione, payload]. */
const without = (object, key) => {
  const copy = structuredClone(object)
  delete copy[key]
  return copy
}
const INVALID = {
  'tables.catalog.dish_changed': [['versione 0', { ...dish, version: 0 }], ['prezzo negativo', { ...dish, price: -1 }]],
  'tables.catalog.snapshot': [['piatto senza nome', { ...VALID['tables.catalog.snapshot'], dishes: [without(dish, 'name')] }]],
  'tables.sales.item_served': [
    ['ne\' piatto ne\' nome libero', { ...VALID['tables.sales.item_served'], dish_ref: null, freeform_name: null }],
    ['quantita 0', { ...VALID['tables.sales.item_served'], quantity: 0 }],
    ['tipo di servizio sconosciuto', { ...VALID['tables.sales.item_served'], service_type: 'delivery' }],
    ['senza addon_ingredient_refs', without(VALID['tables.sales.item_served'], 'addon_ingredient_refs')]
  ],
  'tables.sales.item_voided': [['esito sconosciuto', { ...VALID['tables.sales.item_voided'], disposition: 'lost' }]],
  'tables.bar.reload_done': [['data non ISO', { ...VALID['tables.bar.reload_done'], closed_at: 'ieri' }]],
  'tables.alerts.acknowledge_requested': [['nessun alert', { ...VALID['tables.alerts.acknowledge_requested'], alert_refs: [] }]],
  'logistics.link_changed': [['stato sconosciuto', { status: 'paused' }]],
  'logistics.availability.changed': [['senza version', without(VALID['logistics.availability.changed'], 'version')]],
  'logistics.alerts.updated': [['livello sconosciuto', { ...VALID['logistics.alerts.updated'], groups: [{ ...VALID['logistics.alerts.updated'].groups[0], level: 'panic' }] }]],
  'logistics.notifications.email_requested': [['email non valida', { ...VALID['logistics.notifications.email_requested'], recipient_email: 'non-una-email' }]],
  'account.provisioning_requested': [['hash in chiaro invece di JWE', { ...VALID['account.provisioning_requested'], staff_default_password_hash: '$2b$10$abcdefghijklmnopqrstuv' }]],
  'account.password_changed': [['person_id non uuid', { ...VALID['account.password_changed'], person_id: '42' }]],
  'account.entitlements_changed': [['prodotto sconosciuto', { ...VALID['account.entitlements_changed'], products: [{ product: 'pos', config: {} }] }]],
  'platform.clock.daily': [['data con ora', { date: '2026-09-17T02:00:00Z' }]]
}

const APP_OF_PREFIX = { tables: 'comfortables', logistics: 'logistics', account: 'account', platform: 'platform' }

test('catalogo: 21 argomenti, uno schema per versione e nessuno schema orfano', () => {
  assert.equal(topics.length, 21)
  const expectedFiles = topics.flatMap((topic) => topic.versions.map((v) => `${topic.name}/v${v}.schema.json`)).sort()
  const actualFiles = fs
    .readdirSync(CONTRACT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(CONTRACT_DIR, entry.name)).map((file) => `${entry.name}/${file}`))
    .sort()
  assert.deepEqual(actualFiles, expectedFiles)

  for (const topic of topics) {
    for (const version of topic.versions) {
      const schema = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, topic.name, `v${version}.schema.json`), 'utf8'))
      assert.equal(schema.$id, `urn:comfort-platform:bus:${topic.name}:v${version}`)
    }
  }
  assert.deepEqual(Object.keys(VALID).sort(), topics.map((topic) => topic.name).sort(), 'esempio valido mancante')
})

test('catalogo: coerenza di produttore, destinatari, iscrizioni, chiavi e riservatezza', () => {
  for (const topic of topics) {
    const name = topic.name
    assert.match(name, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
    assert.equal(topic.producer, APP_OF_PREFIX[name.split('.')[0]], `${name}: produttore diverso dal prefisso`)
    assert.ok(topic.recipients.length > 0, `${name}: nessun destinatario previsto`)
    for (const subscription of topic.subscribers) {
      assert.ok(topic.recipients.includes(subscription.app), `${name}: iscritto ${subscription.app} non previsto`)
      assert.ok(topic.versions.includes(subscription.schema_version), `${name}: iscrizione a una versione non registrata`)
    }
    assert.ok(['required', 'forbidden'].includes(topic.request_id), name)
    assert.equal(topic.retention_days, 30)

    const example = VALID[name]
    if (topic.entity && !topic.entity.organization) {
      assert.ok(example[topic.entity.field], `${name}: il campo di entita' ${topic.entity.field} manca nell'esempio`)
      const withoutEntity = without(example, topic.entity.field)
      assert.equal(validatePayload(name, 1, withoutEntity).valid, false, `${name}: il campo di entita' non e' obbligatorio`)
    }
    if (topic.entity_version) {
      assert.equal(validatePayload(name, 1, without(example, topic.entity_version)).valid, false, `${name}: versione non obbligatoria`)
    }
    const hasJwe = JSON.stringify(example).includes(JWE)
    assert.equal(topic.sensitive, hasJwe, `${name}: sensitive deve corrispondere a un contenuto cifrato (JWE)`)
  }

  const subscribed = topics.filter((topic) => topic.subscribers.length).map((topic) => topic.name)
  assert.ok(subscribed.every((name) => getTopic(name).subscribers.every((s) => s.app === 'logistics')), 'solo iscrizioni di logistics nella v1')
  assert.equal(catalog.topics, topics)
})

test('ogni esempio valido passa; campi in piu\' ammessi per la compatibilita\' della stessa versione', () => {
  for (const [name, payload] of Object.entries(VALID)) {
    assert.deepEqual(validatePayload(name, 1, payload), { valid: true, errors: [] }, name)
    assert.equal(validatePayload(name, 1, { ...payload, campo_futuro: 'opzionale' }).valid, true, `${name}: campo in piu' rifiutato`)
  }
})

test('le varianti non valide sono rifiutate con errori leggibili', () => {
  for (const [name, cases] of Object.entries(INVALID)) {
    for (const [description, payload] of cases) {
      const result = validatePayload(name, 1, payload)
      assert.equal(result.valid, false, `${name}: ${description} accettato`)
      assert.ok(result.errors.length > 0 && result.errors.every((error) => typeof error === 'string'), name)
    }
  }
  assert.deepEqual(validatePayload('platform.clock.daily', 2, { date: '2026-09-17' }), {
    valid: false,
    errors: ['versione 2 non prevista (versioni: 1)']
  })
  assert.throws(() => validatePayload('tables.sales.inesistente', 1, {}), ContractError)
})

test('campi del messaggio: chiave di entita\' con prefisso, versione, organizzazione e request_id', () => {
  assert.deepEqual(messageFields('tables.sales.item_served', { organizationId: ORG, payload: VALID['tables.sales.item_served'] }), {
    entityRef: 'item:it1',
    entityVersion: null
  })
  assert.deepEqual(messageFields('tables.catalog.dish_changed', { organizationId: ORG, payload: dish }), {
    entityRef: 'dish:d1',
    entityVersion: 3
  })
  assert.deepEqual(messageFields('logistics.availability.changed', { organizationId: ORG, payload: VALID['logistics.availability.changed'] }), {
    entityRef: `availability:${ORG}`,
    entityVersion: 7
  })
  assert.deepEqual(
    messageFields('tables.bar.preview_requested', { organizationId: ORG, requestId: REQUEST, payload: VALID['tables.bar.preview_requested'] }),
    { entityRef: null, entityVersion: null }
  )
  assert.deepEqual(messageFields('platform.clock.daily', { payload: VALID['platform.clock.daily'] }), { entityRef: null, entityVersion: null })

  const rejects = (name, fields, pattern) =>
    assert.throws(() => messageFields(name, { payload: VALID[name], ...fields }), (err) => err instanceof ContractError && pattern.test(err.message))
  rejects('tables.sales.item_served', {}, /organizationId \(uuid\) obbligatorio/)
  rejects('tables.sales.item_served', { organizationId: 'org-1' }, /organizationId \(uuid\) obbligatorio/)
  rejects('tables.bar.preview_requested', { organizationId: ORG }, /requestId \(uuid\) obbligatorio/)
  rejects('tables.sales.item_served', { organizationId: ORG, requestId: REQUEST }, /requestId non previsto/)
  rejects('platform.clock.daily', { organizationId: ORG }, /i messaggi di platform non hanno organizzazione/)
})

