'use strict'

const { before, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { startPostgres } = require('../testing')
const { apply, inspect } = require('../db/runner/runner')

const ROOT = path.resolve(__dirname, '..')
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations')
const REGISTRY_FILE = '0001_platform_registry.sql'
const REGISTRY_SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, REGISTRY_FILE), 'utf8')

let server
before(async () => {
  server = await startPostgres()
})
after(async () => {
  await server?.stop()
})

const sha256 = (content) => createHash('sha256').update(content).digest('hex')

/** Cartella di migrazioni temporanea: la vera 0001 piu' i file indicati. */
function migrationsDir(t, files = {}, { withRegistry = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfortplatform-migrations-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const write = (name, content) => fs.writeFileSync(path.join(dir, name), content)
  if (withRegistry) write(REGISTRY_FILE, REGISTRY_SQL)
  for (const [name, content] of Object.entries(files)) write(name, content)
  return {
    dir,
    write,
    read: (name) => fs.readFileSync(path.join(dir, name), 'utf8'),
    remove: (name) => fs.rmSync(path.join(dir, name))
  }
}

async function freshDatabase(t) {
  const db = await server.createDatabase()
  const client = await db.connect()
  t.after(() => client.end())
  return { db, client }
}

async function registryRows(client) {
  const { rows } = await client.query('select name, checksum, applied_at from platform.migrations order by name')
  return rows
}

async function exists(client, relation) {
  const { rows } = await client.query('select to_regclass($1) is not null as present', [relation])
  return rows[0].present
}

test('apply: esegue i file in ordine di nome e li registra con lo sha256', async (t) => {
  const { client } = await freshDatabase(t)
  // 0010 dipende da 0002: passa solo se l'ordine e' quello dei nomi.
  const migrations = migrationsDir(t, {
    '0010_ordini.sql': 'create table public.ordini (id int primary key, cliente_id int references public.clienti (id));\n',
    '0002_clienti.sql': 'create table public.clienti (id int primary key);\n'
  })

  const events = []
  const { applied } = await apply({
    client,
    dir: migrations.dir,
    onStart: (name) => events.push(`start ${name}`),
    onApplied: (name, ms) => events.push(`ok ${name} ${typeof ms}`)
  })

  const expected = [REGISTRY_FILE, '0002_clienti.sql', '0010_ordini.sql']
  assert.deepEqual(applied, expected)
  assert.deepEqual(
    events,
    expected.flatMap((name) => [`start ${name}`, `ok ${name} number`])
  )

  const rows = await registryRows(client)
  assert.deepEqual(
    rows.map(({ name, checksum }) => ({ name, checksum })),
    expected.map((name) => ({ name, checksum: sha256(fs.readFileSync(path.join(migrations.dir, name))) }))
  )
  for (const row of rows) assert.ok(row.applied_at instanceof Date)
  assert.equal(await exists(client, 'public.clienti'), true)
  assert.equal(await exists(client, 'public.ordini'), true)
})

test('secondo giro: nessun file rieseguito e registro invariato', async (t) => {
  const { client } = await freshDatabase(t)
  const migrations = migrationsDir(t, {
    '0002_esecuzioni.sql': 'create table public.esecuzioni (n int);\ninsert into public.esecuzioni values (1);\n'
  })

  await apply({ client, dir: migrations.dir })
  const before = await registryRows(client)

  const second = await apply({ client, dir: migrations.dir })
  assert.deepEqual(second.applied, [])
  assert.deepEqual(await registryRows(client), before)
  const { rows } = await client.query('select count(*)::int as n from public.esecuzioni')
  assert.equal(rows[0].n, 1)
})

test('0001 e\' idempotente: eseguita due volte direttamente non cambia nulla', async (t) => {
  const { client } = await freshDatabase(t)
  await client.query(REGISTRY_SQL)
  await client.query("insert into platform.migrations (name, checksum) values ('0001_platform_registry.sql', repeat('a', 64))")
  await client.query(REGISTRY_SQL)
  const rows = await registryRows(client)
  assert.deepEqual(rows.map((row) => row.name), [REGISTRY_FILE])
})

test('dry-run e list su database vuoto: nessuna scrittura, nemmeno lo schema platform', async (t) => {
  const { client } = await freshDatabase(t)
  const migrations = migrationsDir(t, { '0002_prova.sql': 'create table public.prova (id int);\n' })

  const state = await inspect({ client, dir: migrations.dir })
  assert.equal(state.registryExists, false)
  assert.deepEqual(state.drift, [])
  assert.deepEqual(
    state.pending.map((file) => file.name),
    [REGISTRY_FILE, '0002_prova.sql']
  )
  assert.deepEqual(
    state.entries.map(({ name, status }) => ({ name, status })),
    [
      { name: REGISTRY_FILE, status: 'pending' },
      { name: '0002_prova.sql', status: 'pending' }
    ]
  )

  const { rows } = await client.query("select to_regnamespace('platform') is null as absent")
  assert.equal(rows[0].absent, true)
  assert.equal(await exists(client, 'public.prova'), false)
})

test('dry-run e list con registro presente: registro invariato, file in attesa non eseguito', async (t) => {
  const { client } = await freshDatabase(t)
  const migrations = migrationsDir(t, { '0002_prima.sql': 'create table public.prima (id int);\n' })
  await apply({ client, dir: migrations.dir })
  const before = await registryRows(client)

  migrations.write('0003_seconda.sql', 'create table public.seconda (id int);\n')
  const state = await inspect({ client, dir: migrations.dir })

  assert.equal(state.registryExists, true)
  assert.deepEqual(state.pending.map((file) => file.name), ['0003_seconda.sql'])
  assert.deepEqual(
    state.entries.map(({ name, status }) => ({ name, status })),
    [
      { name: REGISTRY_FILE, status: 'applied' },
      { name: '0002_prima.sql', status: 'applied' },
      { name: '0003_seconda.sql', status: 'pending' }
    ]
  )
  assert.deepEqual(await registryRows(client), before)
  assert.equal(await exists(client, 'public.seconda'), false)
})

test('migrazione applicata e poi modificata: stop prima di applicare qualsiasi altro file', async (t) => {
  const { client } = await freshDatabase(t)
  const migrations = migrationsDir(t, { '0002_clienti.sql': 'create table public.clienti (id int);\n' })
  await apply({ client, dir: migrations.dir })
  const before = await registryRows(client)

  migrations.write('0002_clienti.sql', `${migrations.read('0002_clienti.sql')}-- ritocco dopo l'applicazione\n`)
  migrations.write('0003_nuova.sql', 'create table public.nuova (id int);\n')

  await assert.rejects(apply({ client, dir: migrations.dir }), (err) => {
    assert.equal(err.code, 'MIGRATION_DRIFT')
    assert.match(err.message, /0002_clienti\.sql: modificata dopo l'applicazione/)
    assert.equal(err.drift.length, 1)
    return true
  })
  assert.equal(await exists(client, 'public.nuova'), false)
  assert.deepEqual(await registryRows(client), before)

  const state = await inspect({ client, dir: migrations.dir })
  assert.equal(state.entries.find((entry) => entry.name === '0002_clienti.sql').status, 'modified')
  assert.match(state.drift[0], /0002_clienti\.sql: modificata/)
})

test('migrazione applicata e poi cancellata dal repository: stop', async (t) => {
  const { client } = await freshDatabase(t)
  const migrations = migrationsDir(t, {
    '0002_uno.sql': 'create table public.uno (id int);\n',
    '0003_due.sql': 'create table public.due (id int);\n'
  })
  await apply({ client, dir: migrations.dir })

  migrations.remove('0002_uno.sql')
  migrations.write('0004_tre.sql', 'create table public.tre (id int);\n')

  await assert.rejects(apply({ client, dir: migrations.dir }), {
    code: 'MIGRATION_DRIFT',
    message: /0002_uno\.sql: applicata ma il file non esiste piu'/
  })
  assert.equal(await exists(client, 'public.tre'), false)
  const state = await inspect({ client, dir: migrations.dir })
  assert.equal(state.entries.find((entry) => entry.name === '0002_uno.sql').status, 'missing')
})

test('file in attesa con numero precedente all\'ultima applicata: stop', async (t) => {
  const { client } = await freshDatabase(t)
  const migrations = migrationsDir(t, { '0003_dopo.sql': 'create table public.dopo (id int);\n' })
  await apply({ client, dir: migrations.dir })

  migrations.write('0002_prima.sql', 'create table public.prima (id int);\n')
  await assert.rejects(apply({ client, dir: migrations.dir }), {
    code: 'MIGRATION_DRIFT',
    message: /0002_prima\.sql: in attesa ma precede 0003_dopo\.sql/
  })
  assert.equal(await exists(client, 'public.prima'), false)
})

test('file che fallisce a meta\': rollback completo, file successivi non tentati', async (t) => {
  const { client } = await freshDatabase(t)
  const migrations = migrationsDir(t, {
    '0002_riuscita.sql': 'create table public.riuscita (id int);\n',
    '0003_parziale.sql':
      'create table public.parziale (id int);\ninsert into public.parziale values (1);\nselect 1 / 0;\n',
    '0004_mai.sql': 'create table public.mai (id int);\n'
  })

  await assert.rejects(apply({ client, dir: migrations.dir }), (err) => {
    assert.equal(err.code, 'MIGRATION_FAILED')
    assert.equal(err.migration, '0003_parziale.sql')
    assert.match(err.message, /^0003_parziale\.sql fallita/)
    assert.match(err.message, /division by zero \(SQLSTATE 22012\)/)
    return true
  })

  assert.deepEqual(
    (await registryRows(client)).map((row) => row.name),
    [REGISTRY_FILE, '0002_riuscita.sql']
  )
  assert.equal(await exists(client, 'public.riuscita'), true)
  assert.equal(await exists(client, 'public.parziale'), false)
  assert.equal(await exists(client, 'public.mai'), false)

  // Un file mai applicato si puo' correggere: il run successivo riparte da li'.
  migrations.write('0003_parziale.sql', 'create table public.parziale (id int);\n')
  const { applied } = await apply({ client, dir: migrations.dir })
  assert.deepEqual(applied, ['0003_parziale.sql', '0004_mai.sql'])
})

test('errore di sintassi: il messaggio indica la riga del file', async (t) => {
  const { client } = await freshDatabase(t)
  const migrations = migrationsDir(t, {
    '0002_refuso.sql': '-- tabella di prova\ncreate table public.a (id int);\ncreat table public.b (id int);\n'
  })

  await assert.rejects(apply({ client, dir: migrations.dir }), {
    code: 'MIGRATION_FAILED',
    message: /^0002_refuso\.sql fallita alla riga 3: .*\(SQLSTATE 42601\)/
  })
  assert.equal(await exists(client, 'public.a'), false)
})

test('file con COMMIT: rifiutato e non registrato', async (t) => {
  const { client } = await freshDatabase(t)
  const migrations = migrationsDir(t, {
    '0002_commit.sql': 'create table public.prima_del_commit (id int);\ncommit;\ncreate table public.dopo_il_commit (id int);\n',
    '0003_dopo.sql': 'create table public.dopo (id int);\n'
  })

  await assert.rejects(apply({ client, dir: migrations.dir }), {
    code: 'MIGRATION_TRANSACTION_CONTROL',
    message: /^0002_commit\.sql contiene un controllo di transazione/
  })
  assert.deepEqual((await registryRows(client)).map((row) => row.name), [REGISTRY_FILE])
  assert.equal(await exists(client, 'public.dopo'), false)
  // Il messaggio avvisa di uno stato parziale possibile: e' reale.
  assert.equal(await exists(client, 'public.prima_del_commit'), true)
})

test('due apply in parallelo sullo stesso database: ogni file eseguito una volta', async (t) => {
  const { db, client } = await freshDatabase(t)
  const other = await db.connect()
  t.after(() => other.end())
  const migrations = migrationsDir(t, {
    '0002_contatore.sql':
      'select pg_sleep(0.3);\ncreate table public.contatore (n int);\ninsert into public.contatore values (1);\n'
  })

  const results = await Promise.all([
    apply({ client, dir: migrations.dir }),
    apply({ client: other, dir: migrations.dir })
  ])

  assert.deepEqual(
    results.flatMap((result) => result.applied).sort(),
    [REGISTRY_FILE, '0002_contatore.sql']
  )
  const { rows } = await client.query('select count(*)::int as n from public.contatore')
  assert.equal(rows[0].n, 1)
  assert.equal((await registryRows(client)).length, 2)
})

test('parita\' del registro: quello creato dal runner e quello di 0001 sono identici', async (t) => {
  const describe = async (client) => {
    const columns = await client.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'platform' and table_name = 'migrations'
        order by ordinal_position`
    )
    const constraints = await client.query(
      `select conname, contype, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'platform.migrations'::regclass
        order by conname`
    )
    return { columns: columns.rows, constraints: constraints.rows }
  }

  const byRunner = await freshDatabase(t)
  await apply({ client: byRunner.client, dir: migrationsDir(t, {}, { withRegistry: false }).dir })

  const byMigration = await freshDatabase(t)
  await byMigration.client.query(REGISTRY_SQL)

  const expected = await describe(byMigration.client)
  assert.equal(expected.columns.length, 3)
  assert.equal(expected.constraints.length, 3)
  assert.deepEqual(await describe(byRunner.client), expected)
})

test('CLI: list, dry-run e apply con la connessione dalle variabili d\'ambiente', async (t) => {
  // Le migrazioni reali comprendono 0004 (pg_cron): vanno nel database di pg_cron.
  const db = server.database(server.cronDatabase)
  const client = await db.connect()
  t.after(() => client.end())
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()
  const password = server.connection.password
  const variables = {
    PLATFORM_LOCALTEST_DATABASE_HOST: server.connection.host,
    PLATFORM_LOCALTEST_DATABASE_PORT: String(server.connection.port),
    PLATFORM_LOCALTEST_DATABASE_NAME: db.name,
    PLATFORM_LOCALTEST_DATABASE_USERNAME: server.connection.user,
    PLATFORM_LOCALTEST_DATABASE_PASSWORD: password,
    PLATFORM_LOCALTEST_DATABASE_SSL: 'false'
  }
  const cli = (args, env = variables) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'db', 'runner', 'cli.js'), ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8'
    })
    assert.equal(`${result.stdout}${result.stderr}`.includes(password), false, 'password stampata')
    return result
  }

  let result = cli(['list', '--env', 'localtest'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`^Ambiente: localtest - 127\\.0\\.0\\.1:${server.connection.port}/${db.name} \\(utente postgres\\)`))
  assert.match(result.stdout, /Registro platform\.migrations: assente/)
  assert.match(result.stdout, /\[ \] 0001_platform_registry\.sql {2}in attesa/)

  result = cli(['dry-run', '--env=localtest'])
  assert.equal(result.status, 0, result.stderr)
  const checksum = sha256(fs.readFileSync(path.join(MIGRATIONS_DIR, REGISTRY_FILE)))
  assert.match(result.stdout, new RegExp(`1\\. 0001_platform_registry\\.sql {2}sha256 ${checksum}`))
  const { rows } = await client.query("select to_regnamespace('platform') is null as absent")
  assert.equal(rows[0].absent, true)

  result = cli(['apply', '--env', 'localtest'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[apply\] 0001_platform_registry\.sql \.\.\. ok \(\d+ ms\)/)
  assert.match(result.stdout, new RegExp(`\\[apply\\] ${files.length} migrazioni applicate\\.`))

  result = cli(['apply', '--env', 'localtest'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Nessuna migrazione da applicare/)

  result = cli(['list', '--env', 'localtest'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[x\] 0001_platform_registry\.sql {2}applicata \d{4}-\d{2}-\d{2}T/)
  assert.deepEqual((await registryRows(client)).map((row) => row.name), files)

  const withoutPassword = { ...variables }
  delete withoutPassword.PLATFORM_LOCALTEST_DATABASE_PASSWORD
  result = cli(['list', '--env', 'localtest'], withoutPassword)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /PLATFORM_LOCALTEST_DATABASE_PASSWORD mancante o segnaposto/)

  result = cli(['apply'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Manca --env/)
})
