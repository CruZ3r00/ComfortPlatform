'use strict'

// ADR-0014 §7 «Isolamento» e §14.2, con gli utenti applicativi reali collegati con la propria password.

const { before, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { installPlatform, startPostgres } = require('../testing')
const { createAppSchemas } = require('./helpers/platform')
const { APP_ROLES } = require('../db/runner/roles')

const BUS_TABLES = ['apps', 'topics', 'subscriptions', 'messages', 'deliveries', 'stalls']

let server
let platform
const clients = {}

before(async () => {
  server = await startPostgres()
  platform = await installPlatform(server)
  await createAppSchemas(platform)
  for (const role of APP_ROLES) clients[role] = await platform.connectAs(role)

  // Una tabella per schema applicativo, di proprieta' dell'app. In `public` crea solo il proprietario
  // del database: la tabella del sito nasce dal superutente e passa a cs_site (§14.4).
  await clients.ct_app.query('create table orders (id int primary key); insert into orders values (1)')
  await clients.cs_account.query('create table persons (id int primary key); insert into persons values (1)')
  await clients.cl_app.query('create table stock (id int primary key); insert into stock values (1)')
  await platform.superuser.query(`
    create table public.pages (id int primary key);
    insert into public.pages values (1);
    alter table public.pages owner to cs_site;`)
})
after(async () => {
  await server?.stop()
})

const denied = { code: '42501' }

test('ogni app legge il proprio schema, con lo schema predefinito del ruolo', async () => {
  const expected = {
    ct_app: ['tables, extensions', 'orders'],
    cs_site: ['public, extensions', 'pages'],
    cs_account: ['account, extensions', 'persons'],
    cl_app: ['logistics, extensions', 'stock']
  }
  for (const [role, [searchPath, table]] of Object.entries(expected)) {
    const client = clients[role]
    assert.equal((await client.query('show search_path')).rows[0].search_path, searchPath)
    assert.equal((await client.query('show statement_timeout')).rows[0].statement_timeout, '1min')
    assert.deepEqual((await client.query(`select id from ${table}`)).rows, [{ id: 1 }], `${role} non legge ${table}`)
  }
})

test('ct_app non legge account ne\' logistics, e non puo\' referenziarli', async () => {
  await assert.rejects(clients.ct_app.query('select * from account.persons'), denied)
  await assert.rejects(clients.ct_app.query('select * from logistics.stock'), denied)
  await assert.rejects(clients.ct_app.query('create table fk_account (id int references account.persons (id))'), denied)
  await assert.rejects(clients.ct_app.query('create view join_logistics as select * from logistics.stock'), denied)
})

test('schema logistics: solo cl_app crea e legge; l\'amministratore non eredita i dati di ComfortLogistics', async () => {
  for (const role of ['ct_app', 'cs_site', 'cs_account']) {
    await assert.rejects(clients[role].query('create table logistics.intrusa (id int)'), denied, `${role} crea in logistics`)
    await assert.rejects(clients[role].query('select * from logistics.stock'), denied, `${role} legge logistics`)
  }
  await assert.rejects(platform.admin.query('select * from logistics.stock'), denied)
  const { rows } = await platform.superuser.query(
    "select has_schema_privilege('public', 'logistics', 'USAGE') as public_usage, has_function_privilege('public', 'pg_catalog.now()', 'EXECUTE') as sanity"
  )
  assert.deepEqual(rows[0], { public_usage: false, sanity: true })
})

test('cs_site non legge account', async () => {
  await assert.rejects(clients.cs_site.query('select * from account.persons'), denied)
})

test('cl_app non legge tables', async () => {
  await assert.rejects(clients.cl_app.query('select * from tables.orders'), denied)
})

test('nessuna app legge, scrive o crea oggetti nel bus direttamente', async () => {
  for (const role of APP_ROLES) {
    const client = clients[role]
    for (const table of BUS_TABLES) {
      await assert.rejects(client.query(`select * from bus.${table}`), denied, `${role} legge bus.${table}`)
    }
    await assert.rejects(client.query("insert into bus.subscriptions (app, topic) values ('logistics', 'x.y')"), denied)
    await assert.rejects(client.query("update bus.stalls set closed_at = now()"), denied)
    await assert.rejects(client.query('delete from bus.deliveries'), denied)
    await assert.rejects(client.query('truncate bus.messages'), denied)
    await assert.rejects(client.query('create table bus.intrusa (id int)'), denied)
    await assert.rejects(client.query('select * from platform.migrations'), denied)
  }
})

test('le app non chiamano le funzioni interne ne\' la pulizia; cs_site non chiama il bus', async () => {
  for (const role of ['ct_app', 'cs_account', 'cl_app']) {
    const client = clients[role]
    await assert.rejects(client.query('select bus.cleanup()'), denied, `${role} esegue cleanup`)
    await assert.rejects(client.query('select bus.caller_app()'), denied)
    await assert.rejects(client.query("select bus.open_stall('logistics', 'dead', null, true)"), denied)
    await assert.rejects(client.query("select bus.close_stall_if_resolved('logistics')"), denied)
    await assert.rejects(client.query("select bus.check_banner('logistics')"), denied)
    await assert.rejects(client.query('select bus.backoff(1)'), denied)
    // Le funzioni pubbliche invece si': sanity check dei permessi concessi.
    assert.ok((await client.query('select * from bus.status()')).rows.length >= 4)
  }
  await assert.rejects(clients.cs_site.query('select * from bus.status()'), denied)
  await assert.rejects(clients.cs_site.query('select * from bus.next()'), denied)
})
