'use strict'

/**
 * Adattatore knex per `publish` (ADR-0014 §14.7).
 *
 * `publish` vuole un client con `query(text, values)` che restituisca `{ rows }`,
 * cioe' la forma di `pg`. Strapi parla con il database attraverso knex, che usa
 * segnaposto posizionali `?` mentre la libreria genera quelli di PostgreSQL (`$1`).
 * Qui si converte l'uno nell'altro e si normalizza la risposta.
 *
 * Va costruito sulla **transazione** dell'operazione di dominio, non sull'istanza
 * knex: il messaggio deve nascere con l'operazione, e una `knex` qualunque
 * prenderebbe un'altra connessione dal pool, fuori da quella transazione.
 *
 * ```js
 * await strapi.db.transaction(async ({ trx }) => {
 *   await trx('orders').where({ id }).update({ status: 'served' })
 *   await publish(knexClient(trx), 'tables.sales.item_served', { … })
 * })
 * ```
 */

/**
 * `$n` -> `?`, nell'ordine in cui i segnaposto compaiono nel testo.
 * Regge ripetizioni dello stesso indice e ordine non crescente: knex lega i
 * valori per posizione, quindi l'elenco va ricostruito seguendo il testo.
 */
function toPositional(text, values) {
  const bindings = []
  const sql = String(text).replace(/\$(\d+)/g, (match, index) => {
    const position = Number(index) - 1
    if (position < 0 || position >= values.length) {
      throw new RangeError(`Segnaposto ${match} senza valore corrispondente (${values.length} forniti)`)
    }
    bindings.push(values[position])
    return '?'
  })
  return { sql, bindings }
}

/**
 * @param {object} trx transazione knex (o istanza knex, per le letture fuori transazione)
 * @returns {{ query: (text: string, values?: unknown[]) => Promise<{ rows: object[] }> }}
 */
function knexClient(trx) {
  if (!trx || typeof trx.raw !== 'function') {
    throw new TypeError('knexClient richiede una transazione knex (o un\'istanza knex) con raw()')
  }
  return {
    async query(text, values = []) {
      const { sql, bindings } = toPositional(text, values)
      const result = await trx.raw(sql, bindings)
      // `raw` restituisce il Result di pg; con un `postProcessResponse` configurato
      // dall'app puo' arrivare gia' come elenco di righe.
      const rows = Array.isArray(result) ? result : (result && result.rows) || []
      return { rows }
    }
  }
}

module.exports = { knexClient, toPositional }
