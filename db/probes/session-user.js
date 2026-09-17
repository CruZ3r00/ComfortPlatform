'use strict'

/**
 * Punto 3: `session_user` dentro una funzione SECURITY DEFINER chiamata da un utente applicativo
 * attraverso il pooler. Il bus ricava l'app chiamante da `session_user`, perche' dentro la funzione
 * `current_user` e' il proprietario (ADR-0014 §14.7).
 */
const { errorText } = require('./context')
const { ROLE_A, ROLE_B } = require('./objects')

const WHOAMI_SQL = `
  select w.session_user_name, w.current_user_name,
         session_user::text as outer_session_user, current_user::text as outer_current_user,
         pg_backend_pid() as pid
    from probe_a.probe_whoami() w`

async function call(client, inTransaction) {
  if (!inTransaction) return (await client.query(WHOAMI_SQL)).rows[0]
  await client.query('begin')
  try {
    const row = (await client.query(WHOAMI_SQL)).rows[0]
    await client.query('commit')
    return row
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }
}

async function sampleEndpoint(ctx, endpoint, { clients, calls }) {
  const rows = []
  const worker = async () => {
    const client = await ctx.connect(endpoint, ROLE_A)
    try {
      for (let i = 0; i < calls; i++) {
        try {
          rows.push(await call(client, i % 2 === 0))
        } catch (err) {
          rows.push({ error: err.code || err.message })
        }
      }
    } finally {
      await client.end()
    }
  }
  await Promise.all(Array.from({ length: clients }, worker))
  return rows
}

async function expectDenied(ctx, role, sql, label, { inTransaction = false } = {}) {
  const client = await ctx.connect(ctx.endpoints.transaction, role)
  try {
    if (inTransaction) await client.query('begin')
    await client.query(sql)
    ctx.report.ko('3.2', `${label}: ACCETTATO, atteso il rifiuto 42501`)
  } catch (err) {
    ctx.report.check(err.code === '42501', '3.2', `${label}: rifiutato (${errorText(err)})`)
  } finally {
    // Un SET LOCAL accettato per errore non sopravvive al rollback: nulla resta sul backend del pooler.
    if (inTransaction) await client.query('rollback').catch(() => {})
    await client.end()
  }
}

async function probeSessionUser(ctx) {
  const { report, endpoints, owner, options } = ctx
  const plans = [
    { endpoint: endpoints.transaction, clients: 2, calls: Math.ceil(options.sessionUserCalls / 2) },
    { endpoint: endpoints.session, clients: 1, calls: 10 },
    { endpoint: endpoints.direct, clients: 1, calls: 10, optional: true }
  ]
  for (const plan of plans) {
    if (plan.optional) {
      const reach = await ctx.reachable(plan.endpoint, ROLE_A)
      if (!reach.ok) {
        report.info('3.1', `${plan.endpoint.label}: non raggiungibile (${reach.reason}; ${reach.addresses}), prova saltata`)
        continue
      }
    }
    const rows = await sampleEndpoint(ctx, plan.endpoint, plan)
    const correct = rows.filter(
      (r) =>
        !r.error &&
        r.session_user_name === ROLE_A &&
        r.current_user_name === owner &&
        r.outer_session_user === ROLE_A &&
        r.outer_current_user === ROLE_A
    ).length
    const backends = new Set(rows.map((r) => r.pid).filter(Boolean)).size
    const errors = [...new Set(rows.filter((r) => r.error).map((r) => r.error))]
    report.check(
      correct === rows.length,
      '3.1',
      `${plan.endpoint.label}: ${correct}/${rows.length} chiamate con session_user = ${ROLE_A} e current_user = ${owner} ` +
        `dentro la funzione, ${ROLE_A} fuori; backend distinti: ${backends}` +
        (errors.length ? `; errori: ${errors.join(', ')}` : '')
    )
  }

  const ownerIdent = ctx.admin.escapeIdentifier(owner)
  await expectDenied(ctx, ROLE_B, 'select * from probe_a.probe_whoami()', `${ROLE_B} chiama probe_a.probe_whoami()`)
  await expectDenied(ctx, ROLE_A, `set local role ${ownerIdent}`, `${ROLE_A}: SET ROLE ${owner}`, { inTransaction: true })
  await expectDenied(
    ctx,
    ROLE_A,
    `set local session authorization ${ownerIdent}`,
    `${ROLE_A}: SET SESSION AUTHORIZATION ${owner}`,
    { inTransaction: true }
  )
}

module.exports = { probeSessionUser }
