'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { startPostgres } = require('../testing')
const { compareSchemas, normalizeDump } = require('../db/runner/schema-compare')

const CLI = path.resolve(__dirname, '..', 'db', 'runner', 'schema-compare-cli.js')

function envFor(name, config) {
  const prefix = `PLATFORM_${name.toUpperCase()}_DATABASE_`
  return {
    [`${prefix}HOST`]: config.host,
    [`${prefix}PORT`]: String(config.port),
    [`${prefix}NAME`]: config.database,
    [`${prefix}USERNAME`]: config.user,
    [`${prefix}PASSWORD`]: config.password,
    [`${prefix}SSL`]: 'false'
  }
}

test('normalizzazione elimina solo intestazioni e token casuali di pg_dump', () => {
  const dump = '-- PostgreSQL database dump\n\\restrict casuale\nCREATE TABLE t (id integer);  \n\\unrestrict casuale\n'
  assert.equal(normalizeDump(dump), 'CREATE TABLE t (id integer);\n')
})

test('confronto schemi: dati ignorati, differenze esatte approvate, deriva successiva fermata', async () => {
  const server = await startPostgres({ pgCron: false })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'comfortplatform-expected-diff-'))
  try {
    const left = await server.createDatabase()
    const right = await server.createDatabase()
    for (const db of [left, right]) {
      const root = await db.connect()
      await root.query('alter schema public owner to db_admin')
      await root.end()
      const client = await db.connectAdmin()
      for (const schema of ['account', 'bus', 'logistics', 'platform', 'tables']) {
        await client.query(`create schema ${schema} authorization db_admin`)
      }
      await client.query('create table tables.stock (id integer primary key, quantity integer not null)')
      await client.query('insert into tables.stock values (1, $1)', [db === left ? 10 : 99])
    }
    const opts = { from: 'copia', to: 'destinazione' }
    assert.equal(compareSchemas(left.adminConfig, right.adminConfig, opts), '')

    const rightClient = await right.connectAdmin()
    await rightClient.query('alter table tables.stock add column note text')
    const diff = compareSchemas(left.adminConfig, right.adminConfig, opts)
    assert.match(diff, /\+.*note.*text/i)

    const expectedFile = path.join(temp, 'expected.diff')
    fs.writeFileSync(expectedFile, diff, { mode: 0o600 })
    const env = { ...process.env, ...envFor('copia', left.adminConfig), ...envFor('destinazione', right.adminConfig) }
    const run = (extra = []) => spawnSync(process.execPath,
      [CLI, '--from', 'copia', '--to', 'destinazione', ...extra], { env, encoding: 'utf8' })
    const unapproved = run()
    assert.equal(unapproved.status, 1)
    assert.equal(unapproved.stdout, diff)
    const approved = run(['--expected-diff', expectedFile])
    assert.equal(approved.status, 0, approved.stderr)
    assert.equal(approved.stdout, diff)

    await rightClient.query('create table logistics.extra (id integer)')
    const changed = run(['--expected-diff', expectedFile])
    assert.equal(changed.status, 1)
    assert.match(changed.stderr, /differisce dal file approvato/)
    assert.notEqual(changed.stdout, diff)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
    await server.stop()
  }
})
