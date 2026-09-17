#!/usr/bin/env node
'use strict'

/**
 * Rollback di migrazioni di piattaforma (ADR-0014 §14.3 «Rollback»): esegue uno script di `db/rollback/` come
 * amministratore, in una transazione.
 *
 *   node db/rollback/apply.js <script.sql> --env <ambiente>           esegue e conferma
 *   node db/rollback/apply.js <script.sql> --env <ambiente> --check   esegue e annulla: prova che lo script passa
 *
 * Lo script stesso toglie dal registro le migrazioni che annulla, cosi' `apply` le puo' riapplicare. Stessa
 * configurazione e stesso lock del runner: un rollback non si sovrappone a un `apply`.
 */
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const pg = require('pg')
const { connectionFromEnv } = require('../runner/config')
const { LOCK_KEY } = require('../runner/runner')

const ROOT = path.resolve(__dirname, '..', '..')

/** Esegue lo script sul client dato. Con `commit: false` annulla alla fine (prova). */
async function applyRollback({ client, file, commit = true }) {
  const sql = readFileSync(file, 'utf8')
  await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [LOCK_KEY])
  try {
    await client.query('begin')
    try {
      await client.query(sql)
      await client.query(commit ? 'commit' : 'rollback')
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw Object.assign(
        new Error(`${path.basename(file)} fallito: ${err.message}${err.code ? ` (SQLSTATE ${err.code})` : ''}. Nulla e' cambiato.`, { cause: err }),
        { code: 'ROLLBACK_FAILED' }
      )
    }
  } finally {
    await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [LOCK_KEY])
  }
}

async function main(argv) {
  const file = argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.sql'))
  const envIndex = argv.indexOf('--env')
  const env = envIndex === -1 ? null : argv[envIndex + 1]
  const check = argv.includes('--check')
  if (!file || !env) {
    throw new Error('Uso: node db/rollback/apply.js <db/rollback/script.sql> --env <ambiente> [--check]')
  }
  const envFile = path.join(ROOT, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  const { config, warnings } = connectionFromEnv(env)
  console.log(`Ambiente: ${env} - ${config.host}:${config.port}/${config.database} (utente ${config.user})`)
  for (const warning of warnings) console.warn(`Attenzione: ${warning}`)

  const client = new pg.Client(config)
  await client.connect()
  try {
    await applyRollback({ client, file: path.resolve(file), commit: !check })
    console.log(check ? `[rollback] ${path.basename(file)}: eseguito e annullato (prova).` : `[rollback] ${path.basename(file)}: applicato.`)
  } finally {
    await client.end()
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message)
    process.exitCode = 1
  })
}

module.exports = { applyRollback }
