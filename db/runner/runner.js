'use strict'

/**
 * Runner delle migrazioni di piattaforma (ADR-0014 §14.5).
 *
 * Riprende il ciclo di `ComfortService/backend/scripts/migrate.mjs` (un file = una transazione,
 * rollback in caso di errore) e aggiunge cio' che serve a un database condiviso tra ambienti:
 * - registro `platform.migrations` con checksum: una migrazione applicata e poi modificata,
 *   cancellata o superata da un file con numero piu' basso ferma il run PRIMA di applicare altro;
 * - lock di sessione: due amministratori in parallelo non eseguono due volte lo stesso file;
 * - controllo dell'id di transazione: un file con COMMIT/ROLLBACK non viene registrato;
 * - `inspect` in una transazione di sola lettura: e' Postgres a garantire che non scriva.
 */
const { readMigrations } = require('./files')

// Identico a db/migrations/0001_platform_registry.sql, a meno dei commenti (verificato dai test).
const REGISTRY_DDL = `
create schema if not exists platform;
create table if not exists platform.migrations (
  name       text primary key check (name ~ '^[0-9]{4}_[a-z0-9]+(_[a-z0-9]+)*\\.sql$'),
  checksum   text not null check (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);
`

const LOCK_KEY = 'comfortplatform:platform.migrations'

function runnerError(code, message, { cause, ...extra } = {}) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code }, extra)
}

/** Righe del registro, oppure `null` se il registro non esiste ancora. */
async function readRegistry(client) {
  const { rows } = await client.query(
    "select to_regclass('platform.migrations') is not null as registry_exists"
  )
  if (!rows[0].registry_exists) return null
  const result = await client.query(
    'select name, checksum, applied_at from platform.migrations order by name'
  )
  return result.rows
}

/**
 * Confronta i file con il registro. Funzione pura.
 * `entries` descrive ogni nome (file o registro) con il suo stato, in ordine di nome.
 */
function planMigrations(files, registryRows) {
  const fileByName = new Map(files.map((file) => [file.name, file]))
  const rowByName = new Map(registryRows.map((row) => [row.name, row]))
  const lastApplied = registryRows.map((row) => row.name).sort().at(-1)

  const drift = []
  const pending = []
  const entries = []
  const names = [...new Set([...fileByName.keys(), ...rowByName.keys()])].sort()

  for (const name of names) {
    const file = fileByName.get(name)
    const row = rowByName.get(name)

    if (row && !file) {
      drift.push(`${name}: applicata ma il file non esiste piu' nel repository`)
      entries.push({ name, status: 'missing', appliedAt: row.applied_at, checksum: row.checksum })
    } else if (row && row.checksum !== file.checksum) {
      drift.push(
        `${name}: modificata dopo l'applicazione (registro sha256 ${row.checksum}, file sha256 ${file.checksum})`
      )
      entries.push({ name, status: 'modified', appliedAt: row.applied_at, checksum: file.checksum })
    } else if (row) {
      entries.push({ name, status: 'applied', appliedAt: row.applied_at, checksum: row.checksum })
    } else if (lastApplied && name < lastApplied) {
      drift.push(`${name}: in attesa ma precede ${lastApplied}, gia' applicata (ordine per nome violato)`)
      entries.push({ name, status: 'out_of_order', appliedAt: null, checksum: file.checksum })
    } else {
      pending.push(file)
      entries.push({ name, status: 'pending', appliedAt: null, checksum: file.checksum })
    }
  }

  return { entries, pending, drift }
}

function driftError(drift) {
  return runnerError(
    'MIGRATION_DRIFT',
    'Il registro platform.migrations non corrisponde ai file: nessuna migrazione applicata.\n' +
      drift.map((line) => `  - ${line}`).join('\n'),
    { drift }
  )
}

/** Stato di file e registro, senza scrivere nulla. Base di `list` e `dry-run`. */
async function inspect({ client, dir }) {
  const files = readMigrations(dir)
  await client.query('begin transaction isolation level repeatable read read only')
  let registry
  try {
    registry = await readRegistry(client)
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }
  return { registryExists: registry !== null, ...planMigrations(files, registry ?? []) }
}

/** Numero di riga (1-based) di un errore Postgres che riporta la posizione nel testo. */
function lineOf(sql, position) {
  const offset = Number(position)
  if (!Number.isInteger(offset) || offset < 1) return null
  return sql.slice(0, offset - 1).split('\n').length
}

async function currentXactId(client) {
  const { rows } = await client.query('select pg_current_xact_id()::text as xid')
  return rows[0].xid
}

async function applyFile(client, file) {
  await client.query('begin')
  try {
    const xid = await currentXactId(client)

    try {
      await client.query(file.sql)
    } catch (err) {
      const line = lineOf(file.sql, err.position)
      throw runnerError(
        'MIGRATION_FAILED',
        `${file.name} fallita${line ? ` alla riga ${line}` : ''}: ${err.message} (SQLSTATE ${err.code}). ` +
          'Transazione annullata: nessuna modifica di questo file e\' rimasta.',
        { migration: file.name, cause: err }
      )
    }

    if ((await currentXactId(client)) !== xid) {
      throw runnerError(
        'MIGRATION_TRANSACTION_CONTROL',
        `${file.name} contiene un controllo di transazione (COMMIT, ROLLBACK, BEGIN...): ` +
          'il runner esegue ogni file in una sola transazione. File NON registrato; le istruzioni ' +
          'precedenti al controllo potrebbero essere state confermate: verifica lo stato del database.',
        { migration: file.name }
      )
    }

    await client.query('insert into platform.migrations (name, checksum) values ($1, $2)', [
      file.name,
      file.checksum
    ])
    await client.query('commit')
  } catch (err) {
    // Fuori da una transazione ROLLBACK da' solo un WARNING. Se invece fallisce perche' la
    // connessione e' caduta, il server annulla da se' la transazione non confermata: l'errore
    // da mostrare resta quello originale.
    await client.query('rollback').catch(() => {})
    throw err
  }
}

/**
 * Applica le migrazioni in attesa, in ordine di nome, fermandosi al primo errore.
 * Restituisce `{ applied: [nome...] }`.
 */
async function apply({ client, dir, onStart = () => {}, onApplied = () => {} }) {
  const files = readMigrations(dir)

  await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [LOCK_KEY])
  const unlock = () =>
    client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [LOCK_KEY])

  const applied = []
  try {
    await client.query(REGISTRY_DDL)
    const { pending, drift } = planMigrations(files, await readRegistry(client))
    if (drift.length) throw driftError(drift)

    for (const file of pending) {
      onStart(file.name)
      const startedAt = Date.now()
      await applyFile(client, file)
      applied.push(file.name)
      onApplied(file.name, Date.now() - startedAt)
    }
  } catch (err) {
    // Se la connessione e' caduta anche l'unlock fallisce: la fine della sessione rilascia
    // comunque il lock, e l'errore da mostrare resta quello originale.
    await unlock().catch(() => {})
    throw err
  }
  await unlock()

  return { applied }
}

module.exports = { REGISTRY_DDL, LOCK_KEY, planMigrations, readRegistry, inspect, apply }
