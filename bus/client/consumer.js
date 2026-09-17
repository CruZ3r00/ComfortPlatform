'use strict'

/**
 * Consumatore del bus per un'app (ADR-0014 §14.7 «Ricevere», §14.9 avvisi).
 *
 * - Connessione di ascolto dedicata (`LISTEN bus_<app>` e `bus_stalls`) sul pooler in modalita' sessione o
 *   sulla connessione diretta. All'avvio e a ogni riconnessione l'ascolto viene verificato con un
 *   `pg_notify` su un canale casuale inviato da un'altra sessione: sul pooler in modalita' transazione
 *   `LISTEN` e' accettato ma non riceve nulla (docs/prove-tecniche-staging.md §6), e il consumatore non parte.
 * - Svuotamento della coda all'avvio, a ogni riconnessione e a ogni avviso, mai due in parallelo nello
 *   stesso processo: `bus.next()`, validazione del contratto, handler sulla stessa transazione, `bus.ack`,
 *   commit. Handler fallito: rollback e `bus.fail` separata. Messaggio non valido per il contratto:
 *   `bus.fail(…, permanent)` nella stessa transazione (non c'e' alcun effetto da annullare).
 * - Timer: uno solo al prossimo retry delle consegne fallite; nessun timer senza consegne fallite. Gli
 *   altri timer servono solo a riprovare dopo un guasto (riconnessione dell'ascolto, svuotamento fallito).
 * - Avvisi email dei blocchi, solo se l'app passa `notices.send`: presa in carico, invio, conferma; se
 *   l'invio fallisce la presa viene rilasciata e questa istanza non riprova lo stesso avviso per
 *   `noticeCooldownMs`, cosi' un servizio email guasto non genera un ciclo di rilasci.
 */
const { randomBytes } = require('node:crypto')
const pg = require('pg')
const { getTopic, validatePayload } = require('../contract')

const LISTEN_APPLICATION_NAME = 'comfort-platform-bus-listen'
const STALLS_CHANNEL = 'bus_stalls'
const APP_RE = /^[a-z][a-z0-9_]*$/
const MAX_TIMER_MS = 2 ** 31 - 1
const RETRY_MARGIN_MS = 50
const ERROR_TEXT_MAX = 2000

const DEFAULTS = Object.freeze({
  verifyTimeoutMs: 5000,
  reconnectDelaysMs: [1000, 2000, 5000, 10000, 30000],
  noticeCooldownMs: 60000
})

const defaultLogger = {
  info: () => {},
  warn: (message) => console.warn(`[bus] ${message}`),
  error: (message) => console.error(`[bus] ${message}`)
}

class BusListenError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BusListenError'
    this.code = 'BUS_LISTEN'
  }
}

const errorText = (err) => String((err && err.message) || err).slice(0, ERROR_TEXT_MAX)

function toMessage(row) {
  return {
    id: row.message_id,
    topic: row.topic,
    schemaVersion: row.schema_version,
    producer: row.producer,
    organizationId: row.organization_id,
    entityRef: row.entity_ref,
    entityVersion: row.entity_version === null ? null : Number(row.entity_version),
    requestId: row.request_id,
    payload: row.payload,
    occurredAt: row.occurred_at,
    publishedAt: row.published_at,
    attempts: row.attempts
  }
}

function toNotice(row) {
  return {
    stallId: Number(row.stall_id),
    kind: row.kind,
    app: row.app,
    stallKind: row.stall_kind,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    waitingCount: row.waiting_count,
    oldestWaitingAt: row.oldest_waiting_at,
    lastError: row.last_error,
    processedCount: row.processed_count
  }
}

function checkHandlers(handlers) {
  for (const [topicName, versions] of Object.entries(handlers)) {
    const topic = getTopic(topicName)
    for (const [version, handler] of Object.entries(versions || {})) {
      if (!topic.versions.includes(Number(version))) {
        throw new Error(`Handler per ${topicName} v${version}: versione non prevista dal contratto`)
      }
      if (typeof handler !== 'function') throw new Error(`Handler per ${topicName} v${version}: non e' una funzione`)
    }
  }
}

/**
 * Crea il consumatore di un'app. Opzioni:
 * - `app`: codice dell'app nel bus (`logistics`, `comfortables`, `account`);
 * - `pool`: `pg.Pool` dell'utente dell'app, per le transazioni di elaborazione (va bene anche il pooler in
 *   modalita' transazione);
 * - `listen`: configurazione `pg` della connessione di ascolto (pooler di sessione o diretta), oppure una
 *   funzione che restituisce un nuovo `pg.Client`;
 * - `handlers`: `{ [argomento]: { [versione]: async (tx, message) => {} } }`; `tx` e' il client della
 *   transazione in cui viene confermato il messaggio: l'effetto va scritto li', senza commit ne' rollback;
 * - `notices`: `{ send: async (notice) => {} }` per inviare le email dei blocchi, oppure null;
 * - `onStallsChanged`: funzione chiamata a ogni avviso su `bus_stalls` (es. banner di ComforTables);
 * - `logger`: `{ info, warn, error }`; `options`: `verifyTimeoutMs`, `reconnectDelaysMs`, `noticeCooldownMs`.
 */
function createConsumer({ app, pool, listen, handlers = {}, notices = null, onStallsChanged = null, logger = defaultLogger, options = {} } = {}) {
  if (typeof app !== 'string' || !APP_RE.test(app)) throw new Error(`Codice app non valido: ${app}`)
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
    throw new Error('pool: serve un pg.Pool dell\'utente dell\'app')
  }
  if (!listen || (typeof listen !== 'object' && typeof listen !== 'function')) {
    throw new Error('listen: serve la configurazione della connessione di ascolto (pooler di sessione o diretta)')
  }
  if (notices !== null && typeof notices?.send !== 'function') throw new Error('notices: serve { send(notice) } oppure null')
  checkHandlers(handlers)

  const settings = { ...DEFAULTS, ...options }
  const channel = `bus_${app}`
  const state = {
    running: false,
    listenClient: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    retryTimer: null,
    retryAt: null,
    draining: null,
    drainAgain: false,
    drainRetryTimer: null,
    drainFailures: 0,
    noticing: null,
    noticeAgain: false,
    noticeFailures: new Map()
  }

  const backoff = (attempt) => settings.reconnectDelaysMs[Math.min(attempt, settings.reconnectDelaysMs.length - 1)]

  // --- Svuotamento della coda ----------------------------------------------------------------------

  /** Contratto noto a questo pacchetto: un argomento o una versione sconosciuti non sono un messaggio non valido. */
  function contractCheck(row) {
    let topic
    try {
      topic = getTopic(row.topic)
    } catch {
      return { known: false }
    }
    if (!topic.versions.includes(row.schema_version)) return { known: false }
    return { known: true, ...validatePayload(row.topic, row.schema_version, row.payload) }
  }

  async function drainOnce() {
    const client = await pool.connect()
    let broken
    try {
      while (state.running) {
        await client.query('begin')
        let row
        try {
          const { rows } = await client.query('select * from bus.next()')
          row = rows[0]
          if (!row) {
            await client.query('commit')
            return
          }
          const check = contractCheck(row)
          if (!check.known) {
            throw new Error(`${row.topic} v${row.schema_version} non previsto dal contratto di questa versione del pacchetto`)
          }
          if (!check.valid) {
            await client.query('select bus.fail($1, $2, true)', [
              row.message_id,
              errorText(`contratto non rispettato: ${check.errors.join('; ')}`)
            ])
            await client.query('commit')
            logger.warn(`${row.topic} ${row.message_id}: non valido per il contratto, consegna dead`)
            continue
          }
          const handler = handlers[row.topic]?.[row.schema_version]
          if (!handler) throw new Error(`nessun handler per ${row.topic} v${row.schema_version}`)
          await handler(client, toMessage(row))
          await client.query('select bus.ack($1)', [row.message_id])
          await client.query('commit')
        } catch (err) {
          await client.query('rollback')
          if (!row) throw err
          logger.warn(`${row.topic} ${row.message_id}: elaborazione fallita: ${err.message}`)
          await client.query('select bus.fail($1, $2, false)', [row.message_id, errorText(err)])
        }
      }
    } catch (err) {
      broken = err
      throw err
    } finally {
      client.release(broken)
    }
  }

  /** Un solo timer, al prossimo retry futuro delle consegne fallite dell'app (orario del database). */
  async function scheduleRetry() {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
    state.retryAt = null
    if (!state.running) return
    const { rows } = await pool.query(
      `select next_retry_at,
              greatest(0, ceil(extract(epoch from next_retry_at - clock_timestamp()) * 1000))::bigint as delay_ms
         from bus.status() where app = $1`,
      [app]
    )
    const row = rows[0]
    if (!row || !row.next_retry_at || !state.running) return
    state.retryAt = row.next_retry_at
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null
      state.retryAt = null
      requestDrain()
    }, Math.min(Number(row.delay_ms) + RETRY_MARGIN_MS, MAX_TIMER_MS))
  }

  function scheduleDrainRetry() {
    if (!state.running || state.drainRetryTimer) return
    state.drainRetryTimer = setTimeout(() => {
      state.drainRetryTimer = null
      requestDrain()
    }, backoff(state.drainFailures++))
  }

  function requestDrain() {
    if (!state.running) return Promise.resolve()
    if (state.draining) {
      state.drainAgain = true
      return state.draining
    }
    state.draining = (async () => {
      try {
        do {
          state.drainAgain = false
          await drainOnce()
        } while (state.drainAgain && state.running)
        state.drainFailures = 0
        await scheduleRetry()
      } catch (err) {
        logger.error(`svuotamento della coda di ${app} fallito: ${err.message}`)
        scheduleDrainRetry()
      } finally {
        const again = state.drainAgain
        state.draining = null
        state.drainAgain = false
        if (again && state.running) requestDrain()
      }
    })()
    return state.draining
  }

  // --- Avvisi email dei blocchi --------------------------------------------------------------------

  async function processNotices() {
    const { rows } = await pool.query('select * from bus.stall_notices()')
    for (const notice of rows) {
      if (!state.running) return
      const key = `${notice.stall_id}:${notice.kind}`
      const failedAt = state.noticeFailures.get(key)
      if (failedAt !== undefined && Date.now() - failedAt < settings.noticeCooldownMs) continue

      const { rows: claimed } = await pool.query('select * from bus.claim_stall_notice($1, $2)', [notice.stall_id, notice.kind])
      if (!claimed.length) continue
      try {
        await notices.send(toNotice(claimed[0]))
      } catch (err) {
        state.noticeFailures.set(key, Date.now())
        logger.warn(`avviso ${notice.kind} del blocco ${notice.stall_id} non inviato: ${err.message}`)
        await pool.query('select bus.release_stall_notice($1, $2)', [notice.stall_id, notice.kind])
        continue
      }
      state.noticeFailures.delete(key)
      await pool.query('select bus.complete_stall_notice($1, $2)', [notice.stall_id, notice.kind])
    }
  }

  function requestNotices() {
    if (!state.running || !notices) return Promise.resolve()
    if (state.noticing) {
      state.noticeAgain = true
      return state.noticing
    }
    state.noticing = (async () => {
      try {
        do {
          state.noticeAgain = false
          await processNotices()
        } while (state.noticeAgain && state.running)
      } catch (err) {
        logger.error(`avvisi dei blocchi per ${app} non elaborati: ${err.message}`)
      } finally {
        const again = state.noticeAgain
        state.noticing = null
        state.noticeAgain = false
        if (again && state.running) requestNotices()
      }
    })()
    return state.noticing
  }

  // --- Connessione di ascolto ----------------------------------------------------------------------

  function onNotification(notification) {
    if (notification.channel === channel) {
      requestDrain()
    } else if (notification.channel === STALLS_CHANNEL) {
      requestNotices()
      if (onStallsChanged) {
        Promise.resolve()
          .then(() => onStallsChanged())
          .catch((err) => logger.error(`onStallsChanged fallita: ${err.message}`))
      }
    }
  }

  /**
   * L'avviso di verifica parte da un'altra sessione (il pool), come gli avvisi veri delle altre app. Se partisse
   * dalla connessione di ascolto, sul pooler in modalita' transazione potrebbe tornare indietro sullo stesso
   * backend e superare la verifica anche se gli avvisi delle altre sessioni non arrivano (visto su staging).
   */
  async function verifyListening(client) {
    const probe = `bus_verify_${randomBytes(8).toString('hex')}`
    let onProbe
    let timer
    const received = new Promise((resolve) => {
      onProbe = (notification) => {
        if (notification.channel === probe) resolve(true)
      }
      client.on('notification', onProbe)
      timer = setTimeout(() => resolve(false), settings.verifyTimeoutMs)
    })
    try {
      await client.query(`listen ${probe}`)
      await pool.query('select pg_notify($1, $2)', [probe, ''])
      if (!(await received)) {
        throw new BusListenError(
          `Ascolto non verificato per ${channel}: nessun avviso ricevuto entro ${settings.verifyTimeoutMs} ms. ` +
            'La connessione di ascolto deve usare il pooler in modalita\' sessione (5432) o la connessione diretta, ' +
            'non il pooler in modalita\' transazione (6543).'
        )
      }
      await client.query(`unlisten ${probe}`)
    } finally {
      clearTimeout(timer)
      client.removeListener('notification', onProbe)
    }
  }

  async function connectListener() {
    const client = typeof listen === 'function' ? listen() : new pg.Client({ application_name: LISTEN_APPLICATION_NAME, ...listen })
    let lost = false
    const onLost = (err) => {
      if (lost) return
      lost = true
      if (state.listenClient === client) state.listenClient = null
      if (!state.running) return
      logger.warn(`connessione di ascolto di ${app} persa${err ? `: ${err.message}` : ''}`)
      scheduleReconnect()
    }
    client.on('error', onLost)
    client.on('end', () => onLost())
    try {
      await client.connect()
      client.on('notification', onNotification)
      await client.query(`listen ${client.escapeIdentifier(channel)}`)
      await client.query(`listen ${client.escapeIdentifier(STALLS_CHANNEL)}`)
      await verifyListening(client)
    } catch (err) {
      lost = true
      await client.end().catch(() => {})
      throw err
    }
    if (!state.running) {
      lost = true
      await client.end().catch(() => {})
      return
    }
    state.listenClient = client
  }

  function scheduleReconnect() {
    if (!state.running || state.reconnectTimer) return
    state.reconnectTimer = setTimeout(async () => {
      state.reconnectTimer = null
      if (!state.running) return
      try {
        await connectListener()
        state.reconnectAttempt = 0
        logger.info(`connessione di ascolto di ${app} ripristinata`)
        requestDrain()
        requestNotices()
      } catch (err) {
        logger.warn(`riconnessione dell'ascolto di ${app} fallita: ${err.message}`)
        scheduleReconnect()
      }
    }, backoff(state.reconnectAttempt++))
  }

  // --- Interfaccia ---------------------------------------------------------------------------------

  return {
    /** Collega e verifica l'ascolto (errore se non riceve), poi svuota la coda e gli avvisi. */
    async start() {
      if (state.running) throw new Error(`Consumatore di ${app} gia' avviato`)
      state.running = true
      try {
        await connectListener()
      } catch (err) {
        state.running = false
        throw err
      }
      await requestDrain()
      await requestNotices()
    },

    /** Ferma timer e ascolto, attende l'elaborazione in corso. */
    async stop() {
      state.running = false
      for (const timer of ['reconnectTimer', 'retryTimer', 'drainRetryTimer']) {
        clearTimeout(state[timer])
        state[timer] = null
      }
      state.retryAt = null
      const client = state.listenClient
      state.listenClient = null
      if (client) await client.end().catch(() => {})
      await Promise.all([state.draining, state.noticing])
    },

    /** Svuota la coda adesso (es. dopo un intervento manuale su una consegna). */
    drain: () => requestDrain(),

    /** Stato per pagine di salute e test. */
    inspect: () => ({ running: state.running, listening: state.listenClient !== null, retryAt: state.retryAt })
  }
}

module.exports = { createConsumer, BusListenError, LISTEN_APPLICATION_NAME }
