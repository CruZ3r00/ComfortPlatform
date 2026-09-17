'use strict'

/**
 * Fixture dei test di ComfortPlatform sopra il kit `testing/`: schemi applicativi, argomenti di prova,
 * consumatore SQL di riferimento, pooler simulato. Il superutente serve solo per le fixture che nessuna
 * migrazione crea.
 */
const pg = require('pg')
const { installPlatform } = require('../../testing')
/**
 * Sessione di un utente come la tiene Supavisor: se viene terminata, la riapre subito finche' il
 * login lo consente. `refused` e' il codice SQLSTATE dell'ultima riapertura rifiutata.
 */
function poolerLikeSession(config) {
  const session = { client: null, stopped: false, refused: null, opened: 0 }
  const open = async () => {
    const client = new pg.Client(config)
    client.on('error', () => {})
    await client.connect()
    session.client = client
    session.opened++
    client.once('end', () => {
      if (!session.stopped) open().catch((err) => (session.refused = err.code))
    })
  }
  session.open = open
  session.stop = async () => {
    session.stopped = true
    await session.client?.end().catch(() => {})
  }
  return session
}

/**
 * Schemi applicativi come li creeranno le loro migrazioni (§14.1, §14.3, §14.4, ADR-0015), che non
 * fanno parte di questa sessione: fixture del superutente. Ogni app ne e' proprietaria.
 */
async function createAppSchemas(platform) {
  await platform.superuser.query(`
    create schema if not exists tables authorization ct_app;
    create schema if not exists account authorization cs_account;
    create schema if not exists logistics authorization cl_app;`)
}

/**
 * Argomenti di prova alla versione 1. Sono nel contratto v1 (0005), che pero' registra solo le iscrizioni di
 * logistics: le altre le aggiunge l'amministratore, come fara' la migrazione di attivazione di un'app.
 */
const TEST_TOPICS = [
  { name: 'tables.sales.item_served', producer: 'comfortables', subscribers: ['logistics'] },
  { name: 'logistics.availability.changed', producer: 'logistics', subscribers: ['comfortables'] },
  { name: 'account.password_changed', producer: 'account', sensitive: true, subscribers: ['comfortables', 'logistics'] }
]

const ORGANIZATION_ID = '6f1c1d52-3f5e-4a0e-9d7b-2d6c1b9b0a11'

/**
 * Piattaforma con le tre app del bus collegate come utenti reali, una tabella `effects` nel proprio
 * schema di ciascuna (l'effetto dell'handler) e gli argomenti di prova. `reset()` svuota bus ed effetti.
 */
async function setupBus(server) {
  const platform = await installPlatform(server)
  await createAppSchemas(platform)
  const ct = await platform.connectAs('ct_app')
  const cl = await platform.connectAs('cl_app')
  const acc = await platform.connectAs('cs_account')
  for (const client of [ct, cl, acc]) {
    await client.query(`
      create table effects (
        message_id uuid primary key,
        entity_ref text,
        instance   text,
        processed  bigint generated always as identity
      )`)
  }
  for (const topic of TEST_TOPICS) {
    await platform.admin.query(
      'insert into bus.topics (name, producer, sensitive) values ($1, $2, $3) on conflict (name) do nothing',
      [topic.name, topic.producer, topic.sensitive ?? false]
    )
    await platform.admin.query(
      'insert into bus.topic_versions (topic, schema_version) values ($1, 1) on conflict (topic, schema_version) do nothing',
      [topic.name]
    )
    for (const app of topic.subscribers) {
      await platform.admin.query(
        'insert into bus.subscriptions (app, topic, schema_version) values ($1, $2, 1) on conflict (app, topic) do nothing',
        [app, topic.name]
      )
    }
  }
  // Un test fallito a meta' puo' lasciare transazioni aperte (e lock) sui client condivisi: prima si
  // annullano, e il truncate non aspetta oltre 10 s, cosi' un errore non diventa un blocco del file.
  const reset = async () => {
    await Promise.all([ct, cl, acc].map((client) => client.query('rollback').catch(() => {})))
    await platform.admin.query(`
      begin;
      set local lock_timeout = '10s';
      truncate bus.deliveries, bus.messages, bus.stalls restart identity;
      commit;`)
    for (const client of [ct, cl, acc]) await client.query('truncate effects')
  }
  return { ...platform, ct, cl, acc, reset }
}

/** `bus.publish` con i valori di prova; restituisce l'id del messaggio, `null` se la versione non ha iscritti. */
async function publish(
  client,
  topic,
  { schemaVersion = 1, entity = null, entityVersion = null, payload = { ok: true }, organizationId = ORGANIZATION_ID } = {}
) {
  const { rows } = await client.query('select bus.publish($1, $2, $3, $4, $5, $6) as id', [
    topic,
    schemaVersion,
    organizationId,
    entity,
    entityVersion,
    payload
  ])
  return rows[0].id
}

/**
 * Consumatore di riferimento (ADR-0014 §14.7, «Ricevere» passi 2-3), in attesa della libreria:
 * in un ciclo apre una transazione, `bus.next()`, handler con la stessa transazione, `bus.ack`, commit;
 * se l'handler fallisce rollback e `bus.fail` in una transazione separata. Si ferma quando `next` non
 * restituisce nulla. Un errore con `permanent: true` porta la consegna direttamente a `dead`.
 */
async function drain(client, handler) {
  const results = []
  for (;;) {
    await client.query('begin')
    let message
    try {
      const { rows } = await client.query('select * from bus.next()')
      message = rows[0]
      if (!message) {
        await client.query('commit')
        return results
      }
      await handler(client, message)
      await client.query('select bus.ack($1)', [message.message_id])
      await client.query('commit')
      results.push({ message, ok: true })
    } catch (err) {
      await client.query('rollback').catch(() => {})
      if (!message) throw err
      const { rows: [failure] } = await client.query('select * from bus.fail($1, $2, $3)', [
        message.message_id,
        err.message,
        err.permanent === true
      ])
      results.push({ message, ok: false, error: err, failure })
    }
  }
}

/** Handler di prova: scrive l'effetto nello schema dell'app, nella transazione del messaggio. */
const recordEffect = (instance = 'unica') => async (client, message) => {
  await client.query('insert into effects (message_id, entity_ref, instance) values ($1, $2, $3)', [
    message.message_id,
    message.entity_ref,
    instance
  ])
}

/** Avvisi ricevuti su un canale. */
async function listen(client, channel) {
  const heard = []
  client.on('notification', (notification) => {
    if (notification.channel === channel) heard.push(notification)
  })
  await client.query(`listen ${client.escapeIdentifier(channel)}`)
  return heard
}

/** Attende che `condition()` sia vera, al massimo `timeoutMs`. */
async function waitFor(condition, { timeoutMs = 5000, stepMs = 50, message = 'condizione non raggiunta' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await condition()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`${message} entro ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

module.exports = {
  ORGANIZATION_ID,
  TEST_TOPICS,
  createAppSchemas,
  setupBus,
  publish,
  drain,
  recordEffect,
  listen,
  poolerLikeSession,
  waitFor
}
