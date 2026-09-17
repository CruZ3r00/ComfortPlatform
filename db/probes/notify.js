'use strict'

/**
 * Punto 4: LISTEN/NOTIFY come avviso del bus (ADR-0014 §14.7). Ascolto sul pooler in modalita'
 * sessione e sulla connessione diretta; NOTIFY da transazioni sul pooler in modalita' transazione.
 *
 * Le verifiche "non consegnato" non si affidano a un timeout: dopo l'avviso che non deve arrivare
 * se ne invia uno sentinella. Gli avvisi arrivano in ordine di commit, quindi quando la sentinella
 * e' arrivata l'altro non arrivera' piu'.
 */
const { errorText, waitFor, withTimeout } = require('./context')
const { CHANNEL, ROLE_A } = require('./objects')

const DETECT_MS = 15000
const QUERY_TIMEOUT_MS = 10000
const KEEPALIVE = { keepAlive: true, keepAliveInitialDelayMillis: 60000 }

async function openListener(ctx, endpoint, { keepAlive = false } = {}) {
  const client = await ctx.connect(endpoint, ROLE_A, keepAlive ? KEEPALIVE : {})
  const listener = {
    endpoint,
    keepAlive,
    client,
    label: `${endpoint.label}${keepAlive ? ' (keepalive TCP)' : ''}`,
    pid: null,
    received: [],
    events: []
  }
  client.on('notification', (msg) => {
    if (msg.channel === CHANNEL) listener.received.push({ payload: msg.payload, at: Date.now() })
  })
  client.on('error', (err) => listener.events.push({ type: 'error', detail: err.code || err.message, at: Date.now() }))
  client.on('end', () => listener.events.push({ type: 'end', at: Date.now() }))
  listener.pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid
  await client.query(`listen ${CHANNEL}`)
  return listener
}

const receivedAt = (listener, payload) => listener.received.find((n) => n.payload === payload)?.at
const interrupted = (listener) => listener.events.length > 0
const describeEvents = (listener, since) =>
  listener.events.map((e) => `${e.type}${e.detail ? ` ${e.detail}` : ''} a +${e.at - since} ms`).join(', ')

const notifySql = (client, payload) => `select pg_notify('${CHANNEL}', ${client.escapeLiteral(payload)})`
const publishSql = (client, payload) => `select probe_a.probe_publish(${client.escapeLiteral(payload)})`

/** La connessione e' ancora viva e in ascolto? Solo dopo che il client non ha visto nulla. */
async function silentState(listener) {
  try {
    const { rows: [state] } = await withTimeout(
      listener.client.query(
        "select pg_backend_pid() as pid, array_to_string(array(select pg_listening_channels()), ',') as channels"
      ),
      QUERY_TIMEOUT_MS,
      'query di controllo'
    )
    return `la connessione risponde (backend ${state.pid}, canali in ascolto "${state.channels}")`
  } catch (err) {
    return `la connessione non risponde alla query successiva (${errorText(err)})`
  }
}

async function openListeners(ctx, id, keepAliveModes) {
  const { report, endpoints } = ctx
  const listeners = []
  for (const endpoint of [endpoints.session, endpoints.direct]) {
    if (endpoint === endpoints.direct) {
      const reach = await ctx.reachable(endpoint, ROLE_A)
      report.info(id, `${endpoint.label}: ${reach.addresses}`)
      if (!reach.ok) {
        report.info(id, `${endpoint.label}: non raggiungibile (${reach.reason}), prove saltate`)
        continue
      }
    }
    for (const keepAlive of keepAliveModes) {
      try {
        const listener = await openListener(ctx, endpoint, { keepAlive })
        report.ok(id, `${listener.label}: LISTEN ${CHANNEL} attivo (backend ${listener.pid})`)
        listeners.push(listener)
      } catch (err) {
        report.ko(id, `${endpoint.label}: LISTEN non utilizzabile (${errorText(err)})`)
      }
    }
  }
  return listeners
}

async function checkCommit(ctx, sender, listeners, tag) {
  const { report, options } = ctx
  const payload = `commit-${tag}`
  await sender.query('begin')
  await sender.query(notifySql(sender, payload))
  await new Promise((resolve) => setTimeout(resolve, options.notifyHoldMs))
  const early = new Set(listeners.filter((l) => receivedAt(l, payload)))
  const commitAt = Date.now()
  await sender.query('commit')
  await waitFor(() => listeners.every((l) => receivedAt(l, payload)), options.waitMs)
  for (const l of listeners) {
    const at = receivedAt(l, payload)
    report.check(
      !early.has(l) && Boolean(at),
      '4.2',
      `${l.label}: ${early.has(l) ? 'avviso RICEVUTO PRIMA del commit' : `nulla nei ${options.notifyHoldMs} ms tra pg_notify e commit`}; ` +
        (at ? `ricevuto ${at - commitAt} ms dopo l'invio del COMMIT` : `NON ricevuto entro ${options.waitMs} ms dal commit`)
    )
  }
}

async function checkRollback(ctx, sender, listeners, tag) {
  const { report, options } = ctx
  const payload = `rollback-${tag}`
  const sentinel = `sentinel-${tag}`
  await sender.query('begin')
  await sender.query(notifySql(sender, payload))
  await sender.query('rollback')
  await sender.query(notifySql(sender, sentinel))
  await waitFor(() => listeners.every((l) => receivedAt(l, sentinel)), options.waitMs)
  for (const l of listeners) {
    report.check(
      Boolean(receivedAt(l, sentinel)) && !receivedAt(l, payload),
      '4.3',
      `${l.label}: sentinella ${receivedAt(l, sentinel) ? 'ricevuta' : 'NON ricevuta'}; ` +
        `avviso della transazione annullata ${receivedAt(l, payload) ? 'RICEVUTO' : 'mai ricevuto'}`
    )
  }
}

async function checkPublish(ctx, sender, listeners, tag) {
  const { report, options } = ctx
  const committed = `publish-commit-${tag}`
  const rolledBack = `publish-rollback-${tag}`
  const sentinel = `publish-sentinel-${tag}`
  await sender.query('begin')
  await sender.query(publishSql(sender, committed))
  await sender.query('commit')
  await sender.query('begin')
  await sender.query(publishSql(sender, rolledBack))
  await sender.query('rollback')
  await sender.query(notifySql(sender, sentinel))
  await waitFor(() => listeners.every((l) => receivedAt(l, committed) && receivedAt(l, sentinel)), options.waitMs)

  const { rows } = await sender.query(
    `select payload from probe_a.probe_queue where payload in (${sender.escapeLiteral(committed)}, ${sender.escapeLiteral(rolledBack)})`
  )
  const rowsOk = rows.length === 1 && rows[0].payload === committed
  for (const l of listeners) {
    report.check(
      rowsOk && Boolean(receivedAt(l, committed)) && Boolean(receivedAt(l, sentinel)) && !receivedAt(l, rolledBack),
      '4.4',
      `${l.label}: probe_publish confermata ${receivedAt(l, committed) ? 'avvisata' : 'NON avvisata'}, ` +
        `annullata ${receivedAt(l, rolledBack) ? 'AVVISATA' : 'mai avvisata'}; righe in coda: ` +
        `${rows.map((r) => r.payload.replace(`-${tag}`, '')).join(', ') || 'nessuna'} (attesa solo publish-commit)`
    )
  }
}

/**
 * Chiusura dell'ascoltatore (dal client o terminando il backend), pubblicazione mentre e' giu',
 * riconnessione e svuotamento della coda. Restituisce il nuovo ascoltatore.
 */
async function checkRecovery(ctx, sender, listener, mode, tag) {
  const { report, options } = ctx
  const id = mode === 'graceful' ? '4.5a' : '4.5b'
  const missed = `down-${mode}-${listener.endpoint.name}-${tag}`

  if (mode === 'graceful') {
    await listener.client.end()
  } else {
    const startedAt = Date.now()
    const { rows: [terminated] } = await sender.query(`select pg_terminate_backend(${Number(listener.pid)}) as done`)
    if (!terminated.done) report.ko(id, `${listener.label}: pg_terminate_backend(${listener.pid}) ha restituito false`)
    if (await waitFor(() => interrupted(listener), DETECT_MS)) {
      report.ok(
        id,
        `${listener.label}: backend ${listener.pid} terminato, interruzione vista dal client (${describeEvents(listener, startedAt)})`
      )
    } else {
      report.ko(
        id,
        `${listener.label}: backend ${listener.pid} terminato, nessun evento sul client entro ${DETECT_MS} ms; ` +
          `${await silentState(listener)}. Un ascoltatore inattivo resterebbe sordo SENZA saperlo`
      )
    }
    await listener.client.end().catch(() => {})
  }

  await sender.query(publishSql(sender, missed))
  const reopened = await openListener(ctx, listener.endpoint, { keepAlive: listener.keepAlive })
  const { rows: drained } = await reopened.client.query('delete from probe_a.probe_queue returning payload')
  const recovered = drained.some((row) => row.payload === missed)
  const after = `after-${mode}-${listener.endpoint.name}-${tag}`
  await sender.query(notifySql(sender, after))
  const listening = await waitFor(() => receivedAt(reopened, after), options.waitMs)
  report.check(
    recovered && listening,
    id,
    `${listener.label}: dopo la ${mode === 'graceful' ? 'chiusura dal client' : 'terminazione del backend'} ` +
      `riconnesso (backend ${reopened.pid}); lo svuotamento della coda ${recovered ? 'ha recuperato' : 'NON ha recuperato'} ` +
      `il messaggio pubblicato nel frattempo; avviso successivo ${listening ? 'ricevuto' : 'NON ricevuto'}`
  )
  report.info(
    id,
    `${listener.label}: l'avviso pubblicato durante l'interruzione ${receivedAt(reopened, missed) ? 'e\' arrivato comunque' : 'e\' andato perso'} ` +
      '(NOTIFY non e\' persistente: il recupero passa dallo svuotamento della coda alla riconnessione)'
  )
  return reopened
}

async function checkTransactionListen(ctx, sender, tag) {
  const { report, endpoints, options } = ctx
  const client = await ctx.connect(endpoints.transaction, ROLE_A)
  const received = []
  client.on('notification', (msg) => {
    if (msg.channel === CHANNEL) received.push(msg.payload)
  })
  try {
    await client.query(`listen ${CHANNEL}`)
    const payload = `transaction-listen-${tag}`
    await sender.query(notifySql(sender, payload))
    const got = await waitFor(() => received.includes(payload), Math.min(options.waitMs, 5000))
    report.info(
      '4.7',
      `${endpoints.transaction.label}: LISTEN accettato senza errori; avviso ${got ? 'ricevuto' : 'NON ricevuto'}. ` +
        'Il backend cambia a ogni transazione: l\'ascolto non e\' affidabile e la libreria deve rifiutare questa porta'
    )
  } catch (err) {
    report.info('4.7', `${endpoints.transaction.label}: LISTEN rifiutato (${errorText(err)})`)
  } finally {
    await client.query('unlisten *').catch(() => {})
    await client.end().catch(() => {})
  }
}

async function probeNotify(ctx) {
  const tag = Date.now().toString(36)
  let listeners = await openListeners(ctx, '4.1', [false])
  if (!listeners.length) {
    ctx.report.ko('4.1', 'nessun ascoltatore utilizzabile: serve l\'alternativa del realtime Supabase (punto 5)')
    return
  }
  const sender = await ctx.connect(ctx.endpoints.transaction, ROLE_A)
  await checkCommit(ctx, sender, listeners, tag)
  await checkRollback(ctx, sender, listeners, tag)
  await checkPublish(ctx, sender, listeners, tag)
  for (let i = 0; i < listeners.length; i++) {
    listeners[i] = await checkRecovery(ctx, sender, listeners[i], 'graceful', tag)
    listeners[i] = await checkRecovery(ctx, sender, listeners[i], 'abrupt', tag)
  }
  await checkTransactionListen(ctx, sender, tag)
}

/** 4.6: ascoltatori fermi a lungo, con e senza keepalive TCP, poi un avviso. */
async function probeNotifyIdle(ctx) {
  const { report, endpoints, options } = ctx
  const tag = Date.now().toString(36)
  const listeners = await openListeners(ctx, '4.6', [false, true])
  if (!listeners.length) return

  report.info('4.6', `${listeners.length} ascoltatori inattivi per ${options.idleSeconds} s`)
  const startedAt = Date.now()
  await new Promise((resolve) => setTimeout(resolve, options.idleSeconds * 1000))

  const payload = `idle-${tag}`
  const sender = await ctx.connect(endpoints.transaction, ROLE_A)
  await sender.query(notifySql(sender, payload))
  await waitFor(() => listeners.every((l) => receivedAt(l, payload) || interrupted(l)), options.waitMs)

  for (const l of listeners) {
    if (receivedAt(l, payload)) {
      report.ok('4.6', `${l.label}: avviso ricevuto dopo ${options.idleSeconds} s di inattivita'`)
    } else if (interrupted(l)) {
      report.info(
        '4.6',
        `${l.label}: connessione chiusa durante l'inattivita' (${describeEvents(l, startedAt)}): ` +
          'interruzione visibile, la libreria si riconnette e svuota la coda'
      )
    } else {
      report.ko(
        '4.6',
        `${l.label}: avviso NON ricevuto e nessun evento sul client; ${await silentState(l)}. Ascolto perso IN SILENZIO`
      )
    }
  }
}

module.exports = { probeNotify, probeNotifyIdle }
