'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const pg = require('pg')
const { startPostgres } = require('../testing')

test('cluster temporaneo: Postgres reale su porta locale, distrutto da stop()', async () => {
  const server = await startPostgres()
  try {
    if (!process.env.PG_BIN_DIR) {
      assert.equal(server.majorVersion, Number(process.env.PG_VERSION || 17))
    }
    assert.equal(server.connection.host, '127.0.0.1')
    assert.ok(fs.existsSync(server.root))

    const first = await server.createDatabase()
    const second = await server.createDatabase()
    assert.notEqual(first.name, second.name)

    const client = await first.connect()
    const { rows } = await client.query('select current_database() as name')
    assert.equal(rows[0].name, first.name)
    // Il client resta aperto apposta: stop() deve chiuderlo senza bloccare il processo.

    // Amministratore come `postgres` su Supabase: non superutente, CREATEROLE, CREATE sui database.
    const admin = await first.connectAdmin()
    const { rows: [role] } = await admin.query(`
      select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication,
             pg_has_role(current_user, 'pg_signal_backend', 'USAGE') as signal_backend,
             has_database_privilege(current_database(), 'CREATE') as create_database
        from pg_roles where rolname = current_user`)
    assert.deepEqual(role, {
      rolsuper: false,
      rolcreaterole: true,
      rolcreatedb: true,
      rolbypassrls: true,
      rolreplication: true,
      signal_backend: true,
      create_database: true
    })

    // pg_cron precaricata e gia' creata nel database `postgres`, usabile dall'amministratore.
    assert.equal(server.pgCron, true)
    const cron = await server.database('postgres').connectAdmin()
    const { rows: [state] } = await cron.query(`
      select current_setting('shared_preload_libraries') as preload,
             current_setting('cron.database_name') as cron_database,
             (select extversion from pg_extension where extname = 'pg_cron') is not null as installed,
             has_schema_privilege('cron', 'USAGE') as cron_usage`)
    assert.deepEqual(state, { preload: 'pg_cron', cron_database: 'postgres', installed: true, cron_usage: true })
  } finally {
    await server.stop()
  }

  assert.equal(fs.existsSync(server.root), false)
  const probe = new pg.Client({ ...server.connection, database: 'postgres', connectionTimeoutMillis: 2000 })
  await assert.rejects(probe.connect(), { code: 'ECONNREFUSED' })
})

test('password sbagliata rifiutata: il cluster non e\' aperto a chiunque', async () => {
  const server = await startPostgres()
  try {
    const intruder = new pg.Client({ ...server.connection, password: 'sbagliata', database: 'postgres' })
    await assert.rejects(intruder.connect(), { code: '28P01' })
  } finally {
    await server.stop()
  }
})
