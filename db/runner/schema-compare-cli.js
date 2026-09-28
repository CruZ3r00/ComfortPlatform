#!/usr/bin/env node
'use strict'

/** Senza --expected-diff qualsiasi differenza ferma il gate; il report esatto può essere riesaminato e approvato. */
const fs = require('node:fs')
const path = require('node:path')
const { connectionFromEnv, variablePrefix } = require('./config')
const { compareSchemas } = require('./schema-compare')

function options(args) {
  const parsed = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!['--from', '--to', '--expected-diff'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Uso: npm run db:schema-compare -- --from <ambiente> --to <ambiente> [--expected-diff <file>]')
    }
    if (parsed[key]) throw new Error(`Argomento ripetuto: ${key}`)
    parsed[key] = args[++i]
  }
  if (!parsed['--from'] || !parsed['--to'] || parsed['--from'] === parsed['--to']) {
    throw new Error('Indica due ambienti distinti con --from e --to.')
  }
  return parsed
}

function main(args) {
  const parsed = options(args)
  const envFile = path.resolve(__dirname, '..', '..', '.env')
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile)
  const from = parsed['--from']
  const to = parsed['--to']
  const source = connectionFromEnv(from)
  const target = connectionFromEnv(to)
  for (const warning of [...source.warnings, ...target.warnings]) console.error(`ATTENZIONE: ${warning}`)
  const diff = compareSchemas(source.config, target.config, {
    from,
    to,
    sourceCaPath: process.env[`${variablePrefix(from)}SSL_CA`],
    targetCaPath: process.env[`${variablePrefix(to)}SSL_CA`]
  })
  if (diff) process.stdout.write(diff)
  const expectedPath = parsed['--expected-diff']
  if (expectedPath) {
    const expected = fs.readFileSync(expectedPath, 'utf8')
    if (expected !== diff) {
      console.error('Il confronto differisce dal file approvato: operazione fermata.')
      return 1
    }
    console.error('Confronto identico al file approvato.')
    return 0
  }
  if (diff) {
    console.error('Differenze non approvate: operazione fermata. Riesamina il diff prima di usare --expected-diff.')
    return 1
  }
  console.error('Gli schemi applicativi sono identici.')
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
}
