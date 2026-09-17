#!/usr/bin/env node
'use strict'

/**
 * Comando da terminale del runner delle migrazioni di piattaforma.
 *
 *   node db/runner/cli.js list    --env <ambiente>   stato di ogni migrazione, senza scrivere
 *   node db/runner/cli.js dry-run --env <ambiente>   cosa applicherebbe, senza eseguire SQL
 *   node db/runner/cli.js apply   --env <ambiente>   applica le migrazioni in attesa
 *   node db/runner/cli.js role-login   <ruolo> --env <ambiente>   LOGIN e password (da stdin in pipe)
 *   node db/runner/cli.js role-disable <ruolo> --env <ambiente>   NOLOGIN e chiusura delle sessioni
 *
 * Carica `.env` dalla root del repository se esiste; le variabili gia' presenti nell'ambiente
 * del processo hanno la precedenza. Uscita 0 se tutto e' in ordine, 1 altrimenti.
 */
const { existsSync } = require('node:fs')
const path = require('node:path')
const pg = require('pg')
const { connectionFromEnv } = require('./config')
const { inspect, apply } = require('./runner')
const { checkPassword, checkRole, disableLogin, setLogin } = require('./roles')

const ROOT = path.resolve(__dirname, '..', '..')
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations')
const MIGRATION_COMMANDS = ['list', 'dry-run', 'apply']
const ROLE_COMMANDS = ['role-login', 'role-disable']
const USAGE = [
  'Uso:',
  `  node db/runner/cli.js <${MIGRATION_COMMANDS.join('|')}> --env <ambiente>`,
  '  node db/runner/cli.js role-login <ruolo> --env <ambiente>     (password da stdin in pipe)',
  '  node db/runner/cli.js role-disable <ruolo> --env <ambiente>'
].join('\n')

function parseArgs(argv) {
  const [command, ...rest] = argv
  let env
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--env' && i + 1 < rest.length) env = rest[++i]
    else if (arg.startsWith('--env=')) env = arg.slice('--env='.length)
    else if (!arg.startsWith('-')) positional.push(arg)
    else throw new Error(`Argomento non riconosciuto: ${arg}\n${USAGE}`)
  }
  const isRoleCommand = ROLE_COMMANDS.includes(command)
  if (!isRoleCommand && !MIGRATION_COMMANDS.includes(command)) throw new Error(USAGE)
  if (positional.length !== (isRoleCommand ? 1 : 0)) {
    throw new Error(`${isRoleCommand ? 'Indica un solo ruolo' : `Argomento non riconosciuto: ${positional[0]}`}\n${USAGE}`)
  }
  if (!env) throw new Error(`Manca --env: l'ambiente va sempre indicato.\n${USAGE}`)
  return { command, env, role: positional[0] }
}

/**
 * Password da stdin in pipe: mai da argomenti (visibili in `ps`) ne' da variabili. Da terminale il
 * comando si ferma, cosi' la password non resta a schermo ne' nella cronologia.
 */
async function readPassword(role) {
  if (process.stdin.isTTY) {
    throw new Error(
      'La password si passa da stdin in pipe, non da terminale. Esempio:\n' +
        `  read -rs PW; printf '%s' "$PW" | npm run db:role-login -- ${role} --env <ambiente>; unset PW`
    )
  }
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
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

async function runRole(command, role, password, client) {
  if (command === 'role-login') {
    await setLogin({ client, role, password })
    console.log(`[role-login] ${role}: LOGIN attivo, password impostata con il verificatore SCRAM.`)
    console.log('[role-login] Le sessioni gia\' aperte restano valide: per chiuderle usa role-disable e poi role-login.')
    return 0
  }
  const startedAt = Date.now()
  const { terminated } = await disableLogin({ client, role })
  console.log(
    `[role-disable] ${role}: NOLOGIN, ${terminated} sessioni terminate, nessuna sessione attiva (${Date.now() - startedAt} ms).`
  )
  return 0
}

async function main(argv) {
  const { command, env, role } = parseArgs(argv)
  let password
  if (role) {
    checkRole(role)
    if (command === 'role-login') {
      password = await readPassword(role)
      checkPassword(password)
    }
  }

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
    return role ? await runRole(command, role, password, client) : await run(command, client)
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
