'use strict'

/**
 * Connessione del runner da variabili d'ambiente, una sezione per ambiente:
 * PLATFORM_<AMBIENTE>_DATABASE_{HOST,PORT,NAME,USERNAME,PASSWORD,SSL,SSL_CA,SSL_REJECT_UNAUTHORIZED}.
 *
 * Fail-loud come `ComfortService/backend/src/config/env.mjs`: una variabile mancante o lasciata
 * al segnaposto ferma il runner. Gli errori elencano solo i NOMI delle variabili, mai i valori.
 */
const { existsSync, readFileSync } = require('node:fs')

const ENV_NAME_RE = /^[a-z][a-z0-9_]*$/

/** Valori che "sembrano compilati" ma non lo sono (stesso elenco di ComfortService). */
const PLACEHOLDERS = new Set(['', 'changeme', 'change-me', 'tobemodified', 'placeholder', 'todo', 'xxx'])

const variablePrefix = (envName) => `PLATFORM_${envName.toUpperCase()}_DATABASE_`

function configError(envName, problems) {
  const error = new Error(
    `Configurazione dell'ambiente "${envName}" non valida:\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\n\nCompila .env partendo da .env.example, oppure esporta le variabili.'
  )
  error.code = 'CONFIG_INVALID'
  return error
}

/**
 * Restituisce `{ config, warnings }`: `config` va passato a `new pg.Client(config)`.
 * `source` e' `process.env` salvo nei test.
 */
function connectionFromEnv(envName, source = process.env) {
  if (typeof envName !== 'string' || !ENV_NAME_RE.test(envName)) {
    throw configError(String(envName), ['il nome dell\'ambiente deve rispettare [a-z][a-z0-9_]* (es. staging)'])
  }

  const prefix = variablePrefix(envName)
  const problems = []
  const warnings = []

  const read = (key) => {
    const raw = source[prefix + key]
    const value = raw === undefined || raw === null ? '' : String(raw).trim()
    return PLACEHOLDERS.has(value.toLowerCase()) ? '' : value
  }
  const required = (key) => {
    const value = read(key)
    if (!value) problems.push(`${prefix}${key} mancante o segnaposto`)
    return value
  }
  const bool = (key, fallback) => {
    const value = read(key).toLowerCase()
    if (!value) return fallback
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
    problems.push(`${prefix}${key} deve essere true o false`)
    return fallback
  }

  const host = required('HOST')
  const user = required('USERNAME')
  const password = required('PASSWORD')
  const database = read('NAME') || 'postgres'

  let port = 5432
  const rawPort = read('PORT')
  if (rawPort) {
    port = Number(rawPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push(`${prefix}PORT deve essere un intero tra 1 e 65535`)
    }
  }

  let ssl = false
  if (bool('SSL', true)) {
    const rejectUnauthorized = bool('SSL_REJECT_UNAUTHORIZED', true)
    const caPath = read('SSL_CA')
    let ca
    if (caPath && existsSync(caPath)) {
      ca = readFileSync(caPath, 'utf8')
    } else if (caPath) {
      problems.push(`${prefix}SSL_CA punta a un file inesistente`)
    } else if (rejectUnauthorized) {
      problems.push(
        `${prefix}SSL_CA mancante: indica il certificato CA del database, oppure dichiara ` +
          `${prefix}SSL_REJECT_UNAUTHORIZED=false per accettare TLS non verificato`
      )
    }
    if (!ca && !rejectUnauthorized) {
      warnings.push('TLS attivo ma NON verificato: manca il certificato CA.')
    }
    ssl = ca ? { ca, rejectUnauthorized } : { rejectUnauthorized }
  }

  if (problems.length) throw configError(envName, problems)

  return {
    config: {
      host,
      port,
      database,
      user,
      password,
      ssl,
      application_name: 'comfortplatform-migrations',
      connectionTimeoutMillis: 30000
    },
    warnings
  }
}

module.exports = { ENV_NAME_RE, variablePrefix, connectionFromEnv }
