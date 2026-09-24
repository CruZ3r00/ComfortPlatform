'use strict'

/**
 * Consegne scartate (`dead`) di un'app: elenco e rigioco (0012, ADR-0014 §14.9).
 *
 * `listDead` legge soltanto; `replay` chiama `bus.replay` in una transazione e restituisce le consegne rimesse in
 * coda. Da usare dopo aver corretto la causa: una consegna rigiocata con la stessa causa torna `dead`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function checkArgs(app, messageId) {
  if (typeof app !== 'string' || !/^[a-z][a-z0-9_]*$/.test(app)) throw new Error(`App non valida: ${app}`)
  if (messageId != null && !UUID_RE.test(messageId)) throw new Error(`--message deve essere un uuid: ${messageId}`)
}

/** Consegne `dead` dell'app, nell'ordine in cui verrebbero rigiocate. */
async function listDead({ client, app, messageId = null }) {
  checkArgs(app, messageId)
  const { rows } = await client.query(
    `select d.message_id, m.topic, m.entity_ref, d.attempts, d.last_error, m.published_at
       from bus.deliveries d
       join bus.messages m on m.id = d.message_id
      where d.app = $1 and d.status = 'dead' and ($2::uuid is null or d.message_id = $2::uuid)
      order by m.seq`,
    [app, messageId]
  )
  return rows
}

/** Rigioca le consegne `dead` dell'app (o del solo messaggio) e restituisce quelle rimesse in coda. */
async function replay({ client, app, messageId = null }) {
  checkArgs(app, messageId)
  await client.query('begin')
  try {
    const { rows } = await client.query('select * from bus.replay($1, $2)', [app, messageId])
    await client.query('commit')
    return rows
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }
}

function formatDead(rows) {
  if (!rows.length) return '  Nessuna consegna scartata.'
  return rows
    .map((r) => `  ${r.message_id}  ${r.topic}  ${r.entity_ref ?? '-'}  tentativi ${r.attempts}\n      ${String(r.last_error ?? '').slice(0, 300)}`)
    .join('\n')
}

module.exports = { listDead, replay, formatDead }
