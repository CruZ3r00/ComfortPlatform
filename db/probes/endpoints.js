'use strict'

/**
 * Endpoint di un progetto Supabase ricavati dalla connessione amministratore del runner
 * (PLATFORM_<AMBIENTE>_DATABASE_*): pooler in modalita' sessione (5432), pooler in modalita'
 * transazione (6543) e connessione diretta. Stessa validazione e stesso TLS del runner.
 *
 * Sul pooler l'utente e' `<ruolo>.<ref>`; sulla connessione diretta e' `<ruolo>`, con host
 * `db.<ref>.supabase.co`. Se `.env` punta alla diretta, l'host del pooler va indicato a mano.
 */
const { connectionFromEnv } = require('../runner/config')

const POOLER_HOST_RE = /\.pooler\.supabase\.com$/
const DIRECT_HOST_RE = /^db\.([a-z0-9]+)\.supabase\.co$/
const REF_RE = /^[a-z0-9]+$/

const APPLICATION_NAME = 'comfortplatform-probe'
const SESSION_PORT = 5432
const TRANSACTION_PORT = 6543
const DIRECT_PORT = 5432

/**
 * Un endpoint: dove collegarsi e con quale nome utente per un ruolo.
 * `configFor(ruolo, password, extra)` restituisce la configurazione di `pg.Client`.
 */
function makeEndpoint({ name, label, base, host, port, userFor }) {
  return {
    name,
    label,
    host,
    port,
    userFor,
    configFor: (role, password, extra = {}) => ({ ...base, ...extra, host, port, user: userFor(role), password })
  }
}

function endpointError(message) {
  const error = new Error(message)
  error.code = 'CONFIG_INVALID'
  return error
}

function supabaseEndpoints(envName, { poolerHost, directHost, source } = {}) {
  const { config, warnings } = connectionFromEnv(envName, source)
  const [adminRole, userRef] = config.user.split('.')
  const directMatch = DIRECT_HOST_RE.exec(config.host)

  let ref
  let pooler
  if (POOLER_HOST_RE.test(config.host)) {
    if (!userRef || !REF_RE.test(userRef)) {
      throw endpointError('Sul pooler Supabase l\'utente deve essere <ruolo>.<ref> (es. postgres.<ref>).')
    }
    ref = userRef
    pooler = poolerHost || config.host
  } else if (directMatch) {
    ref = directMatch[1]
    if (!poolerHost) {
      throw endpointError('.env punta alla connessione diretta: indica l\'host del pooler con --pooler-host.')
    }
    pooler = poolerHost
  } else {
    throw endpointError(
      `Host non riconosciuto come Supabase (atteso *.pooler.supabase.com o db.<ref>.supabase.co): ${config.host}`
    )
  }

  const base = { database: config.database, ssl: config.ssl, application_name: APPLICATION_NAME, connectionTimeoutMillis: 15000 }
  const poolerUser = (role) => `${role}.${ref}`
  const plainUser = (role) => role

  return {
    admin: {
      name: 'admin',
      label: 'amministratore',
      host: config.host,
      port: config.port,
      user: `${adminRole}${userRef ? `.${userRef}` : ''}`,
      config: { ...config, application_name: APPLICATION_NAME }
    },
    session: makeEndpoint({
      name: 'session', label: 'pooler sessione :5432', base, host: pooler, port: SESSION_PORT, userFor: poolerUser
    }),
    transaction: makeEndpoint({
      name: 'transaction', label: 'pooler transazione :6543', base, host: pooler, port: TRANSACTION_PORT, userFor: poolerUser
    }),
    direct: makeEndpoint({
      name: 'direct', label: 'connessione diretta', base, host: directHost || `db.${ref}.supabase.co`, port: DIRECT_PORT, userFor: plainUser
    }),
    /** Il ref del progetto non compare negli output destinati ai documenti. */
    mask: (text) => String(text).split(ref).join('<ref>'),
    warnings
  }
}

module.exports = { APPLICATION_NAME, makeEndpoint, supabaseEndpoints }
