'use strict'

/**
 * Pubblicazione di un messaggio (ADR-0014 §14.7 «Pubblicare»).
 *
 * Va chiamata con il client della transazione dell'operazione di dominio: il messaggio esiste solo se
 * l'operazione viene confermata, e gli iscritti vengono svegliati solo al commit. La libreria non puo'
 * verificare che il client sia dentro una transazione: e' responsabilita' del chiamante.
 */
const { ContractError, getTopic, messageFields, validatePayload } = require('../contract')

/**
 * Valida il payload contro il contratto, ricava `entity_ref` ed `entity_version` dal catalogo e chiama
 * `bus.publish`. Restituisce l'id del messaggio, oppure `null` se la versione non ha iscritti.
 *
 * `client`: oggetto con `query(text, values)` che restituisce `{ rows }` (pg `Client` o `PoolClient`).
 */
async function publish(client, topicName, { schemaVersion, organizationId = null, payload, occurredAt = new Date(), requestId = null } = {}) {
  const topic = getTopic(topicName)
  if (!Number.isInteger(schemaVersion)) {
    throw new ContractError(`${topic.name}: schemaVersion (intero) obbligatoria`, { topic: topic.name })
  }
  const { valid, errors } = validatePayload(topic.name, schemaVersion, payload)
  if (!valid) {
    throw new ContractError(`${topic.name} v${schemaVersion}: payload non valido: ${errors.join('; ')}`, {
      topic: topic.name,
      schemaVersion,
      errors
    })
  }
  const { entityRef, entityVersion } = messageFields(topic.name, { organizationId, requestId, payload })

  const { rows } = await client.query('select bus.publish($1, $2, $3, $4, $5, $6, $7, $8) as id', [
    topic.name,
    schemaVersion,
    organizationId,
    entityRef,
    entityVersion,
    JSON.stringify(payload),
    occurredAt,
    requestId
  ])
  return rows[0].id
}

module.exports = { publish }
