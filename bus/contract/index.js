'use strict'

/**
 * Contratto v1 del bus (ADR-0014 §14.8).
 *
 * - `catalog.json` e' la fonte unica degli argomenti: produttore, riservatezza, conservazione, versioni,
 *   destinatari previsti e iscrizioni registrate, chiave di entita', uso di `request_id`. La migrazione 0005
 *   lo registra nel database e un test verifica che coincidano.
 * - Un JSON Schema per argomento e versione (`<argomento>/v<N>.schema.json`), tipi condivisi in
 *   `common.schema.json`. I campi in piu' sono ammessi: un campo opzionale aggiunto nella stessa versione non
 *   deve rendere non valido il messaggio per un destinatario con il pacchetto precedente.
 * - Il payload non ripete i campi del messaggio (`organization_id`, `request_id`, `occurred_at`,
 *   `entity_ref`, `entity_version`): `entity_ref` ed `entity_version` si ricavano dal payload secondo il catalogo.
 */
const path = require('node:path')
const Ajv2020 = require('ajv/dist/2020')
const addFormats = require('ajv-formats')
const catalog = require('./catalog.json')
const common = require('./common.schema.json')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class ContractError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ContractError'
    this.code = 'BUS_CONTRACT'
    Object.assign(this, details)
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
ajv.addSchema(common)

const topicsByName = new Map(catalog.topics.map((topic) => [topic.name, topic]))
const validators = new Map()
for (const topic of catalog.topics) {
  for (const version of topic.versions) {
    const schema = require(path.join(__dirname, topic.name, `v${version}.schema.json`))
    validators.set(`${topic.name}@${version}`, ajv.compile(schema))
  }
}

function getTopic(name) {
  const topic = topicsByName.get(name)
  if (!topic) throw new ContractError(`Argomento sconosciuto al contratto: ${name}`, { topic: name })
  return topic
}

function formatErrors(errors) {
  return (errors || []).map((error) => `${error.instancePath || '(payload)'} ${error.message}`)
}

/** `{ valid, errors }` del payload contro lo schema dell'argomento alla versione indicata. */
function validatePayload(topicName, schemaVersion, payload) {
  const topic = getTopic(topicName)
  const validate = validators.get(`${topic.name}@${schemaVersion}`)
  if (!validate) {
    return { valid: false, errors: [`versione ${schemaVersion} non prevista (versioni: ${topic.versions.join(', ')})`] }
  }
  const valid = validate(payload)
  return { valid, errors: valid ? [] : formatErrors(validate.errors) }
}

/**
 * Campi del messaggio ricavati dal catalogo: `entityRef` (`<prefisso>:<valore>`, il prefisso separa entita'
 * diverse nell'ordine per entita' di `bus.next()`) ed `entityVersion`. Verifica anche organizzazione e
 * `request_id`. Il payload deve essere gia' valido.
 */
function messageFields(topicName, { organizationId = null, requestId = null, payload }) {
  const topic = getTopic(topicName)
  const fail = (message) => {
    throw new ContractError(`${topic.name}: ${message}`, { topic: topic.name })
  }

  if (topic.producer === 'platform') {
    if (organizationId !== null) fail('i messaggi di platform non hanno organizzazione')
  } else if (typeof organizationId !== 'string' || !UUID_RE.test(organizationId)) {
    fail('organizationId (uuid) obbligatorio')
  }

  if (topic.request_id === 'required' && (typeof requestId !== 'string' || !UUID_RE.test(requestId))) {
    fail('requestId (uuid) obbligatorio')
  }
  if (topic.request_id === 'forbidden' && requestId !== null) fail('requestId non previsto')

  let entityRef = null
  if (topic.entity) {
    const value = topic.entity.organization ? organizationId : payload[topic.entity.field]
    entityRef = `${topic.entity.prefix}:${value}`
  }
  const entityVersion = topic.entity_version ? payload[topic.entity_version] : null

  return { entityRef, entityVersion }
}

// Solo nomi abbreviati: cosi' Node riconosce gli export anche da un modulo ESM (`import { … } from`).
const { topics } = catalog

module.exports = {
  ContractError,
  catalog,
  topics,
  getTopic,
  validatePayload,
  messageFields
}
