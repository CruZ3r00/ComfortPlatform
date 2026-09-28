'use strict'

/** Confronto read-only degli schemi applicativi (ADR-0014 §14.5). */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCHEMAS = Object.freeze(['account', 'bus', 'logistics', 'platform', 'public', 'tables'])
const MAX_OUTPUT = 64 * 1024 * 1024

function escapePassfile(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:')
}

function normalizeDump(output) {
  return output.replace(/\r\n/g, '\n').split('\n')
    .filter((line) => !line.startsWith('--') && !/^\\(?:un)?restrict(?:\s|$)/.test(line))
    .map((line) => line.replace(/[\t ]+$/g, ''))
    .join('\n').trim() + '\n'
}

function dumpSchema(config, { schemas = SCHEMAS, bin = 'pg_dump', caPath } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'comfortplatform-schema-'))
  try {
    const passfile = path.join(temp, 'pgpass')
    fs.writeFileSync(passfile,
      [config.host, config.port, config.database, config.user, config.password].map(escapePassfile).join(':') + '\n',
      { mode: 0o600 })
    const sslMode = !config.ssl ? 'disable' : config.ssl.rejectUnauthorized === false ? 'require' : 'verify-full'
    if (sslMode === 'verify-full' && !caPath) throw new Error('Manca il percorso del certificato CA per pg_dump.')
    const env = { ...process.env, PGPASSFILE: passfile, PGSSLMODE: sslMode, PGAPPNAME: 'comfortplatform-schema-compare' }
    delete env.PGPASSWORD
    if (caPath) env.PGSSLROOTCERT = caPath
    const args = ['--schema-only', '--no-password', '--quote-all-identifiers',
      ...schemas.map((schema) => `--schema=${schema}`),
      '--host', config.host, '--port', String(config.port), '--username', config.user, '--dbname', config.database]
    const result = spawnSync(bin, args, { encoding: 'utf8', env, maxBuffer: MAX_OUTPUT })
    if (result.error || result.status !== 0) {
      throw new Error(`pg_dump non riuscito (uscita ${result.status ?? 'sconosciuta'}). Verifica connessione, permessi e versione PostgreSQL.`,
        { cause: result.error })
    }
    return normalizeDump(result.stdout)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function unifiedDiff(left, right, { from = 'origine', to = 'destinazione' } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'comfortplatform-schema-diff-'))
  try {
    const leftFile = path.join(temp, 'left.sql')
    const rightFile = path.join(temp, 'right.sql')
    fs.writeFileSync(leftFile, left, { mode: 0o600 })
    fs.writeFileSync(rightFile, right, { mode: 0o600 })
    const result = spawnSync('diff', ['-u', '--label', from, '--label', to, leftFile, rightFile],
      { encoding: 'utf8', maxBuffer: MAX_OUTPUT })
    if (result.error || ![0, 1].includes(result.status)) {
      throw new Error('Impossibile calcolare il confronto degli schemi.', { cause: result.error })
    }
    return result.stdout
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function compareSchemas(source, target, options = {}) {
  const left = dumpSchema(source, { ...options, caPath: options.sourceCaPath })
  const right = dumpSchema(target, { ...options, caPath: options.targetCaPath })
  return unifiedDiff(left, right, options)
}

module.exports = { SCHEMAS, normalizeDump, dumpSchema, unifiedDiff, compareSchemas }
