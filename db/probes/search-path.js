'use strict'

/**
 * Punto 2: schema predefinito per utente (`ALTER ROLE ... SET search_path`) attraverso il pooler in
 * modalita' transazione, su molte transazioni e connessioni (ADR-0014 §14.2).
 *
 * Ogni osservazione registra il valore di `search_path`, lo schema corrente, lo schema in cui si
 * risolve il nome NON qualificato `probe_marker` (stesso meccanismo delle query di Strapi) e il
 * backend. Nelle transazioni esplicite legge anche la riga del marker.
 */
const { ROLE_A, ROLE_B } = require('./objects')

const OBSERVE_SQL = `
  select current_setting('search_path') as search_path,
         current_schema()::text as current_schema,
         (select n.nspname::text
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.oid = to_regclass('probe_marker')) as resolved_schema,
         pg_backend_pid() as pid`

const EXPECTED = {
  [ROLE_A]: { searchPath: 'probe_a, extensions', schema: 'probe_a', marker: 'a' },
  [ROLE_B]: { searchPath: 'probe_b, extensions', schema: 'probe_b', marker: 'b' }
}

async function observe(client, { transaction, readMarker }) {
  if (!transaction) return (await client.query(OBSERVE_SQL)).rows[0]
  await client.query('begin')
  try {
    // Breve attesa dentro la transazione: i client si sovrappongono e il pooler usa piu' backend.
    await client.query('select pg_sleep(0.02)')
    const row = (await client.query(OBSERVE_SQL)).rows[0]
    if (readMarker) row.marker = (await client.query('select name from probe_marker')).rows[0]?.name
    await client.query('commit')
    return row
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }
}

async function sample(ctx, role, { parallel, rounds, sequential, readMarker = true }) {
  const { transaction } = ctx.endpoints
  const observations = []
  const record = async (client, inTransaction) => {
    try {
      observations.push(await observe(client, { transaction: inTransaction, readMarker }))
    } catch (err) {
      observations.push({ error: err.code || err.message })
    }
  }
  const worker = async () => {
    const client = await ctx.connect(transaction, role)
    try {
      for (let i = 0; i < rounds; i++) {
        await record(client, true)
        await record(client, false)
      }
    } finally {
      await client.end()
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))
  for (let i = 0; i < sequential; i++) {
    const client = await ctx.connect(transaction, role)
    try {
      await record(client, true)
    } finally {
      await client.end()
    }
  }
  return observations
}

function describe(observations) {
  const values = new Map()
  for (const o of observations) {
    const key = o.error ? `errore ${o.error}` : `"${o.search_path}"`
    values.set(key, (values.get(key) || 0) + 1)
  }
  const backends = new Set(observations.map((o) => o.pid).filter(Boolean)).size
  return `valori: ${[...values].map(([key, n]) => `${key} x${n}`).join(', ')}; backend distinti: ${backends}`
}

function assess(ctx, id, role, observations, label) {
  const expected = EXPECTED[role]
  const correct = observations.filter(
    (o) =>
      !o.error &&
      o.search_path === expected.searchPath &&
      o.current_schema === expected.schema &&
      o.resolved_schema === expected.schema &&
      (o.marker === undefined || o.marker === expected.marker)
  ).length
  ctx.report.check(
    correct === observations.length,
    id,
    `${role} ${label}: ${correct}/${observations.length} osservazioni corrette (search_path "${expected.searchPath}", ` +
      `schema corrente e nome non qualificato in ${expected.schema}, marker "${expected.marker}"); ${describe(observations)}`
  )
}

async function probeSearchPath(ctx) {
  const { parallel, rounds, sequential } = ctx.options
  const clientsA = Math.max(1, Math.ceil(parallel / 2))
  const clientsB = Math.max(1, Math.floor(parallel / 2))

  const [a, b] = await Promise.all([
    sample(ctx, ROLE_A, { parallel: clientsA, rounds, sequential }),
    sample(ctx, ROLE_B, { parallel: clientsB, rounds, sequential })
  ])
  assess(ctx, '2.1', ROLE_A, a, `sul pooler transazione (${clientsA} client x ${rounds} transazioni + ${rounds} autocommit, ${sequential} connessioni in sequenza)`)
  assess(ctx, '2.2', ROLE_B, b, `sul pooler transazione, in parallelo ad A (${clientsB} client)`)

  // 2.3: B cambia search_path con un SET di sessione, come fa Strapi. Non deve toccare A.
  const leaker = await ctx.connect(ctx.endpoints.transaction, ROLE_B)
  const [, pidResult] = await leaker.query('set search_path = probe_a; select pg_backend_pid() as pid')
  const leakPid = pidResult.rows[0].pid
  const half = { rounds: Math.max(1, Math.round(rounds / 2)), sequential: Math.max(1, Math.round(sequential / 2)) }
  const [a2, b2] = await Promise.all([
    sample(ctx, ROLE_A, { parallel: clientsA, ...half }),
    sample(ctx, ROLE_B, { parallel: clientsB, ...half, readMarker: false })
  ])
  await leaker.end()
  assess(ctx, '2.3', ROLE_A, a2, `mentre ${ROLE_B} ha eseguito SET search_path = probe_a sul pooler`)
  const leaked = b2.filter((o) => o.search_path === 'probe_a').length
  ctx.report.info(
    '2.3',
    `${ROLE_B}: dopo il SET di sessione (backend ${leakPid}), ${leaked}/${b2.length} osservazioni da ALTRI client ` +
      `di ${ROLE_B} vedono il valore trapelato; ${describe(b2)}`
  )
}

module.exports = { probeSearchPath }
