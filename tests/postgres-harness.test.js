'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const pg = require('pg')
const { startPostgres } = require('./helpers/postgres')

test('cluster temporaneo: Postgres reale su porta locale, distrutto da stop()', async () => {
  const server = await startPostgres()
  try {
    if (!process.env.PG_BIN_DIR) {
      assert.equal(server.majorVersion, Number(process.env.PG_VERSION || 16))
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
