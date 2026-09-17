#!/usr/bin/env node
'use strict'

/**
 * Copia del sito ComfortService nel database unico (ADR-0014 §14.1 e §14.5): le righe delle tabelle del sito dal
 * database di oggi a `public` del database unico, di cs_site.
 *
 *   node data-migrations/site-copy/copy.js --from <ambiente> --from-schema <schema> --env <ambiente>
 *       prova: copia, report, annulla (default)
 *   … --apply                        copia e conferma
 *   … --no-data contact_messages     la tabella resta vuota (es. staging: niente messaggi dei visitatori)
 *
 * Sorgente (`--from`, variabili PLATFORM_<FROM>_DATABASE_*): il database del sito di oggi, letto in una transazione
 * `repeatable read read only`: una fotografia coerente, e nessuna scrittura possibile.
 * Destinazione (`--env`, l'amministratore del runner, pooler di sessione): scritta come cs_site (`set local role`) in
 * una sola transazione.
 *
 * Prerequisiti, verificati prima di scrivere: 0009 applicata (public di cs_site); le migrazioni del sito applicate come
 * cs_site (`npm run migrate` di ComfortService: tabelle, trigger, RLS), almeno tutte quelle registrate nella sorgente;
 * stesse colonne e stessa chiave primaria in ogni tabella. La copia non crea struttura.
 *
 * Nella destinazione: truncate di tutte le tabelle del sito, insert dei valori identici (identita' comprese), sequenze
 * allo stato della sorgente, poi il confronto: le righe di ogni tabella (jsonb ordinato per chiave primaria, in UTC) e
 * le sequenze devono essere identiche a quelle della sorgente, altrimenti si annulla tutto. `schema_migrations` non si
 * copia: e' il registro della destinazione.
 */
const { existsSync } = require('node:fs')
const path = require('node:path')
const pg = require('pg')
const { connectionFromEnv, ENV_NAME_RE } = require('../../db/runner/config')

const ROOT = path.resolve(__dirname, '..', '..')

/** Tabelle del sito in ordine di chiavi esterne: ogni tabella dopo quelle a cui fa riferimento. */
const SITE_TABLES = [
  'languages',
  'translations',
  'services',
  'service_translations',
  'pages',
  'page_translations',
  'faqs',
  'faq_translations',
  'contact_messages'
]
const TARGET_SCHEMA = 'public'
const TARGET_ROLE = 'cs_site'
const PLATFORM_MIGRATION = '0009_site_public_schema.sql'

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`
const qualified = (schema, table) => `${ident(schema)}.${ident(table)}`

function stop(message) {
  return Object.assign(new Error(`${message} Nulla e' stato scritto.`), { code: 'SITE_COPY_STOPPED' })
}

/** Colonne (nome, tipo, not null, identita', generata, chiave primaria) ordinate per nome; `null` se la tabella manca. */
async function columnsOf(client, schema, table) {
  const name = qualified(schema, table)
  const { rows: [relation] } = await client.query(
    "select relowner::regrole::text as owner from pg_class where oid = to_regclass($1) and relkind = 'r'",
    [name]
  )
  if (!relation) return null
  const { rows: columns } = await client.query(
    `select a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
            a.attidentity::text as identity, a.attgenerated::text as generated,
            coalesce(a.attnum = any(i.indkey), false) as primary_key
       from pg_attribute a
       left join pg_index i on i.indrelid = a.attrelid and i.indisprimary
      where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped
      order by a.attname`,
    [name]
  )
  return { owner: relation.owner, columns }
}

/** Righe e sequenze di una tabella: jsonb delle righe ordinate per chiave primaria, stato di ogni sequenza d'identita'. */
async function snapshotOf(client, schema, table, columns) {
  const order = columns.filter((c) => c.primary_key).map((c) => `t.${ident(c.name)}`).join(', ')
  const { rows: [data] } = await client.query(
    `select count(*)::int as count, coalesce(jsonb_agg(t order by ${order}), '[]'::jsonb)::text as rows
       from ${qualified(schema, table)} t`
  )
  const sequences = {}
  for (const column of columns.filter((c) => c.identity)) {
    const { rows: [{ sequence }] } = await client.query('select pg_get_serial_sequence($1, $2) as sequence', [
      qualified(schema, table),
      column.name
    ])
    const { rows: [state] } = await client.query(`select last_value::text, is_called from ${sequence}`)
    sequences[column.name] = state
  }
  return { ...data, sequences }
}

async function readSource(client, schema, noData) {
  const tables = {}
  for (const table of SITE_TABLES) {
    const structure = await columnsOf(client, schema, table)
    if (!structure) throw stop(`Sorgente: la tabella ${schema}.${table} non esiste.`)
    tables[table] = { structure, snapshot: noData.includes(table) ? null : await snapshotOf(client, schema, table, structure.columns) }
    if (noData.includes(table)) {
      const { rows: [{ count }] } = await client.query(`select count(*)::int as count from ${qualified(schema, table)}`)
      tables[table].count = count
    }
  }
  const registry = await columnsOf(client, schema, 'schema_migrations')
  const { rows } = registry ? await client.query(`select name from ${qualified(schema, 'schema_migrations')} order by name`) : { rows: [] }
  return { tables, migrations: rows.map((r) => r.name) }
}

async function checkTarget(client, source) {
  // Due query: in una sola, `platform.migrations` verrebbe risolta durante il parsing anche su un database senza registro.
  const { rows: [platformRegistry] } = await client.query("select to_regclass('platform.migrations') is not null as present")
  const { rows: [platform] } = platformRegistry.present
    ? await client.query('select exists (select 1 from platform.migrations where name = $1) as applied', [PLATFORM_MIGRATION])
    : { rows: [{ applied: false }] }
  if (!platform.applied) throw stop(`Destinazione: ${PLATFORM_MIGRATION} non applicata (public non e' ancora di ${TARGET_ROLE}).`)
  await client.query(`set local role ${TARGET_ROLE}`)

  const registry = await columnsOf(client, TARGET_SCHEMA, 'schema_migrations')
  const { rows } = registry ? await client.query(`select name from ${qualified(TARGET_SCHEMA, 'schema_migrations')}`) : { rows: [] }
  const applied = new Set(rows.map((r) => r.name))
  const missing = source.migrations.filter((name) => !applied.has(name))
  if (!registry || missing.length) {
    throw stop(
      `Destinazione: migrazioni del sito mancanti (${registry ? missing.join(', ') : 'nessun registro'}). ` +
        `Applica prima \`npm run migrate\` di ComfortService come ${TARGET_ROLE}.`
    )
  }
  for (const table of SITE_TABLES) {
    const target = await columnsOf(client, TARGET_SCHEMA, table)
    if (!target) throw stop(`Destinazione: la tabella ${TARGET_SCHEMA}.${table} non esiste.`)
    if (target.owner !== TARGET_ROLE) throw stop(`Destinazione: ${TARGET_SCHEMA}.${table} appartiene a ${target.owner}, non a ${TARGET_ROLE}.`)
    const expected = JSON.stringify(source.tables[table].structure.columns)
    if (JSON.stringify(target.columns) !== expected) {
      throw stop(`Colonne di ${table} diverse tra sorgente e destinazione.`)
    }
    if (!target.columns.some((c) => c.primary_key)) throw stop(`${table} non ha una chiave primaria: l'ordine delle righe non e' confrontabile.`)
  }
}

/**
 * Copia sui client dati (sorgente e destinazione come amministratore). Con `commit: false` (default) annulla alla fine.
 * Restituisce `{ committed, report }`, una voce per tabella: righe nella sorgente, nella destinazione prima e dopo,
 * `identical` (righe e sequenze uguali alla sorgente) oppure `emptied` per le tabelle in `noData`.
 */
async function copySite({ source, target, sourceSchema, commit = false, noData = [] }) {
  const unknown = noData.filter((table) => !SITE_TABLES.includes(table))
  if (unknown.length) throw stop(`--no-data: tabelle non del sito: ${unknown.join(', ')}.`)

  await source.query('begin transaction isolation level repeatable read read only')
  let read
  try {
    await source.query("set local timezone to 'UTC'")
    read = await readSource(source, sourceSchema, noData)
  } finally {
    await source.query('rollback').catch(() => {})
  }

  await target.query('begin')
  try {
    await target.query("set local timezone to 'UTC'")
    await checkTarget(target, read)

    const report = []
    for (const table of SITE_TABLES) {
      const { rows: [{ count }] } = await target.query(`select count(*)::int as count from ${qualified(TARGET_SCHEMA, table)}`)
      report.push({ table, source: read.tables[table].snapshot?.count ?? read.tables[table].count, before: count })
    }
    await target.query(`truncate ${SITE_TABLES.map((table) => qualified(TARGET_SCHEMA, table)).join(', ')} restart identity`)

    for (const entry of report) {
      const { structure, snapshot } = read.tables[entry.table]
      const name = qualified(TARGET_SCHEMA, entry.table)
      if (snapshot) {
        const columns = structure.columns.filter((c) => !c.generated).map((c) => ident(c.name)).join(', ')
        const overriding = structure.columns.some((c) => c.identity === 'a') ? ' overriding system value' : ''
        await target.query(
          `insert into ${name} (${columns})${overriding} select ${columns} from jsonb_populate_recordset(null::${name}, $1::jsonb)`,
          [snapshot.rows]
        )
        for (const [column, state] of Object.entries(snapshot.sequences)) {
          await target.query('select setval(pg_get_serial_sequence($1, $2), $3::bigint, $4)', [name, column, state.last_value, state.is_called])
        }
      }
      const copied = await snapshotOf(target, TARGET_SCHEMA, entry.table, structure.columns)
      entry.after = copied.count
      if (snapshot) {
        entry.identical =
          copied.rows === snapshot.rows && JSON.stringify(copied.sequences) === JSON.stringify(snapshot.sequences)
      } else {
        entry.emptied = copied.count === 0
      }
    }

    const different = report.filter((entry) => entry.identical === false || entry.emptied === false).map((e) => e.table)
    if (different.length) {
      throw Object.assign(stop(`Dopo la copia ${different.join(', ')} non corrisponde alla sorgente.`), { report })
    }
    await target.query(commit ? 'commit' : 'rollback')
    return { committed: commit, report }
  } catch (err) {
    await target.query('rollback').catch(() => {})
    throw err
  }
}

function formatReport(report) {
  const lines = [`${'tabella'.padEnd(22)}${'sorgente'.padStart(9)}${'prima'.padStart(8)}${'dopo'.padStart(8)}  esito`]
  for (const e of report) {
    const outcome = e.emptied !== undefined ? (e.emptied ? 'vuota (--no-data)' : 'NON VUOTA') : e.identical ? 'identica' : 'DIVERSA'
    lines.push(`${e.table.padEnd(22)}${String(e.source).padStart(9)}${String(e.before).padStart(8)}${String(e.after).padStart(8)}  ${outcome}`)
  }
  return lines.join('\n')
}

const USAGE =
  'Uso: node data-migrations/site-copy/copy.js --from <ambiente> --from-schema <schema> --env <ambiente> ' +
  '[--apply] [--no-data <tabella>]…'

function parseArgs(argv) {
  const options = { noData: [], apply: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} senza valore.\n${USAGE}`)
      return argv[++i]
    }
    if (arg === '--from') options.from = value()
    else if (arg === '--from-schema') options.fromSchema = value()
    else if (arg === '--env') options.env = value()
    else if (arg === '--no-data') options.noData.push(value())
    else if (arg === '--apply') options.apply = true
    else throw new Error(`Argomento non riconosciuto: ${arg}\n${USAGE}`)
  }
  if (!options.from || !options.fromSchema || !options.env) throw new Error(USAGE)
  if (!ENV_NAME_RE.test(options.fromSchema)) throw new Error(`--from-schema deve rispettare ${ENV_NAME_RE}.\n${USAGE}`)
  if (options.from === options.env) throw new Error('--from e --env devono essere ambienti diversi.')
  return options
}

async function connect(envName, role) {
  const { config, warnings } = connectionFromEnv(envName)
  console.log(`${role}: ${envName} - ${config.host}:${config.port}/${config.database} (utente ${config.user})`)
  for (const warning of warnings) console.warn(`Attenzione (${role}): ${warning}`)
  const client = new pg.Client({ ...config, application_name: 'comfortplatform-site-copy' })
  await client.connect()
  return client
}

async function main(argv) {
  const options = parseArgs(argv)
  const envFile = path.join(ROOT, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  const source = await connect(options.from, 'Sorgente')
  try {
    const target = await connect(options.env, 'Destinazione')
    try {
      const { committed, report } = await copySite({
        source,
        target,
        sourceSchema: options.fromSchema,
        commit: options.apply,
        noData: options.noData
      })
      console.log(`\n${formatReport(report)}\n`)
      console.log(committed ? '[site-copy] copia confermata.' : '[site-copy] prova: copia eseguita e annullata. Per confermare: --apply')
    } finally {
      await target.end()
    }
  } finally {
    await source.end()
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    if (err.report) console.error(formatReport(err.report))
    console.error(err.message)
    process.exitCode = 1
  })
}

module.exports = { SITE_TABLES, copySite, formatReport }
