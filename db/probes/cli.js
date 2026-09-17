#!/usr/bin/env node
'use strict'

/**
 * Prove tecniche su un database Supabase (ADR-0014 §14.2, §14.7), da ripetere prima di ogni
 * replica in un nuovo ambiente. Gli oggetti di prova `probe_` nascono e muoiono a ogni esecuzione.
 *
 *   node db/probes/cli.js <comando> --env <ambiente> [opzioni]
 *
 *   server        versione, estensioni e contesto del server (sola lettura)
 *   search-path   schema predefinito per utente sul pooler in modalita' transazione
 *   session-user  session_user in una funzione SECURITY DEFINER attraverso il pooler
 *   notify        LISTEN/NOTIFY: commit, rollback, disconnessione e recupero
 *   notify-idle   ascoltatori inattivi a lungo (--idle-seconds, default 420)
 *   all           server + search-path + session-user + notify
 *   cleanup       elimina gli oggetti di prova rimasti (es. dopo un'interruzione)
 *   leftovers     verifica che non resti nulla
 *
 * Opzioni: --pooler-host <host> (se .env punta alla diretta), --direct-host <host>,
 * --idle-seconds <n>, --rounds <n>, --parallel <n>.
 *
 * Carica `.env` dalla root come il runner; l'utente e' l'amministratore. L'output non contiene
 * password e maschera il ref del progetto. Uscita 0 senza KO, 1 altrimenti.
 */
const { existsSync } = require('node:fs')
const path = require('node:path')
const { Report } = require('./context')
const { supabaseEndpoints } = require('./endpoints')
const { COMMANDS, runProbes } = require('./run')

const ROOT = path.resolve(__dirname, '..', '..')
const USAGE = `Uso: node db/probes/cli.js <${COMMANDS.join('|')}> --env <ambiente> [--pooler-host h] [--direct-host h] [--idle-seconds n] [--rounds n] [--parallel n]`

const FLAGS = {
  '--env': 'env',
  '--pooler-host': 'poolerHost',
  '--direct-host': 'directHost',
  '--idle-seconds': 'idleSeconds',
  '--rounds': 'rounds',
  '--parallel': 'parallel'
}
const NUMERIC = new Set(['idleSeconds', 'rounds', 'parallel'])

function parseArgs(argv) {
  const [command, ...rest] = argv
  const args = {}
  for (let i = 0; i < rest.length; i++) {
    const [flag, inline] = rest[i].split(/=(.*)/s)
    const key = FLAGS[flag]
    const value = inline ?? rest[++i]
    if (!key || value === undefined) throw new Error(`Argomento non riconosciuto: ${rest[i] ?? flag}\n${USAGE}`)
    if (NUMERIC.has(key)) {
      const number = Number(value)
      if (!Number.isInteger(number) || number < 1) throw new Error(`${flag} deve essere un intero positivo`)
      args[key] = number
    } else {
      args[key] = value
    }
  }
  if (!COMMANDS.includes(command)) throw new Error(USAGE)
  if (!args.env) throw new Error(`Manca --env: l'ambiente va sempre indicato.\n${USAGE}`)
  return { command, ...args }
}

async function main(argv, output) {
  const { command, env, poolerHost, directHost, ...options } = parseArgs(argv)

  const envFile = path.join(ROOT, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)

  const endpoints = supabaseEndpoints(env, { poolerHost, directHost })
  output.mask = endpoints.mask
  const say = (text) => console.log(endpoints.mask(text))
  say(`Prove tecniche ComfortPlatform - ambiente ${env} - comando ${command} - ${new Date().toISOString()}`)
  say(`  ${endpoints.admin.label}: ${endpoints.admin.host}:${endpoints.admin.port} (utente ${endpoints.admin.user})`)
  for (const e of [endpoints.session, endpoints.transaction, endpoints.direct]) {
    say(`  ${e.label}: ${e.host}:${e.port} (utente ${e.userFor('<ruolo>')})`)
  }
  say(`  TLS: ${endpoints.admin.config.ssl ? `attivo, verifica certificato ${endpoints.admin.config.ssl.rejectUnauthorized ? 'si' : 'NO'}` : 'NON attivo'}`)
  for (const warning of endpoints.warnings) console.warn(`ATTENZIONE: ${warning}`)
  say('')

  const report = new Report({ mask: endpoints.mask })
  await runProbes(command, { endpoints, report, options })
  say(`\nEsito: ${report.count('OK')} OK, ${report.count('KO')} KO, ${report.count('INFO')} INFO`)
  return report.count('KO') ? 1 : 0
}

const output = { mask: String }
main(process.argv.slice(2), output).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(`\n${output.mask(err.message)}`)
    process.exitCode = 1
  }
)
