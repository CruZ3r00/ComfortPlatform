#!/usr/bin/env node
'use strict'

/**
 * Comando da terminale del runner delle migrazioni di piattaforma.
 *
 *   node db/runner/cli.js list    --env <ambiente>   stato di ogni migrazione, senza scrivere
 *   node db/runner/cli.js dry-run --env <ambiente>   cosa applicherebbe, senza eseguire SQL
 *   node db/runner/cli.js apply   --env <ambiente>   applica le migrazioni in attesa
 *
 * Carica `.env` dalla root del repository se esiste; le variabili gia' presenti nell'ambiente
 * del processo hanno la precedenza. Uscita 0 se tutto e' in ordine, 1 altrimenti.
 */
const { existsSync } = require('node:fs')
const path = require('node:path')
const pg = require('pg')
const { connectionFromEnv } = require('./config')
const { inspect, apply } = require('./runner')

const ROOT = path.resolve(__dirname, '..', '..')
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations')
const COMMANDS = ['list', 'dry-run', 'apply']
const USAGE = `Uso: node db/runner/cli.js <${COMMANDS.join('|')}> --env <ambiente>`

function parseArgs(argv) {
  const [command, ...rest] = argv
  let env
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--env' && i + 1 < rest.length) env = rest[++i]
    else if (arg.startsWith('--env=')) env = arg.slice('--env='.length)
    else throw new Error(`Argomento non riconosciuto: ${arg}\n${USAGE}`)
  }
  if (!COMMANDS.includes(command)) throw new Error(USAGE)
  if (!env) throw new Error(`Manca --env: l'ambiente va sempre indicato.\n${USAGE}`)
  return { command, env }
}

const STATUS_LABEL = {
  applied: '[x]',
  pending: '[ ]',
  modified: '[!]',
  missing: '[!]',
  out_of_order: '[!]'
}

function describeEntry(entry) {
  switch (entry.status) {
    case 'applied':
      return `applicata ${entry.appliedAt.toISOString()}`
    case 'pending':
      return 'in attesa'
    case 'modified':
      return 'MODIFICATA dopo l\'applicazione'
    case 'missing':
      return 'applicata ma file ASSENTE'
    default:
      return 'FUORI ORDINE'
  }
}

function printDrift(drift) {
  console.error(`\nDerive (${drift.length}): apply si fermera' prima di applicare qualsiasi file.`)
  for (const line of drift) console.error(`  - ${line}`)
}

async function run(command, client) {
  if (command === 'apply') {
    const { applied } = await apply({
      client,
      dir: MIGRATIONS_DIR,
      onStart: (name) => process.stdout.write(`[apply] ${name} ... `),
      onApplied: (name, ms) => console.log(`ok (${ms} ms)`)
    })
    console.log(
      applied.length
        ? `[apply] ${applied.length} migrazioni applicate.`
        : '[apply] Nessuna migrazione da applicare.'
    )
    return 0
  }

  const state = await inspect({ client, dir: MIGRATIONS_DIR })
  console.log(
    `Registro platform.migrations: ${state.registryExists ? 'presente' : 'assente (lo creera\' apply)'}\n`
  )

  if (command === 'list') {
    if (!state.entries.length) console.log('  Nessuna migrazione.')
    for (const entry of state.entries) {
      console.log(`  ${STATUS_LABEL[entry.status]} ${entry.name}  ${describeEntry(entry)}`)
    }
  } else if (state.pending.length) {
    console.log('apply eseguirebbe, in quest\'ordine:')
    state.pending.forEach((file, i) => console.log(`  ${i + 1}. ${file.name}  sha256 ${file.checksum}`))
  } else {
    console.log('Nessuna migrazione in attesa.')
  }

  if (state.drift.length) {
    printDrift(state.drift)
    return 1
  }
  return 0
}

async function main(argv) {
  const { command, env } = parseArgs(argv)

  const envFile = path.join(ROOT, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)

  const { config, warnings } = connectionFromEnv(env)
  console.log(`Ambiente: ${env} - ${config.host}:${config.port}/${config.database} (utente ${config.user})`)
  for (const warning of warnings) console.warn(`ATTENZIONE: ${warning}`)

  const client = new pg.Client(config)
  // Un errore sulla connessione inattiva non deve diventare un'eccezione non gestita.
  client.on('error', (err) => console.error(`[db] connessione interrotta: ${err.message}`))
  await client.connect()
  try {
    return await run(command, client)
  } finally {
    await client.end()
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(`\n${err.message}`)
    process.exitCode = 1
  }
)
