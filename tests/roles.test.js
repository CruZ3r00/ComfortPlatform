'use strict'

const { before, after, test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { installPlatform, newPassword, startPostgres } = require('../testing')
const { poolerLikeSession, waitFor } = require('./helpers/platform')
const { disableLogin, setLogin } = require('../db/runner/roles')

const ROOT = path.resolve(__dirname, '..')

let server
let platform

before(async () => {
  server = await startPostgres()
  platform = await installPlatform(server)
})
after(async () => {
  await server?.stop()
})

async function canLogin(role, password) {
  try {
    const client = await server.connect(platform.configFor(role, password))
    const { rows } = await client.query('select session_user::text as name')
    await client.end()
    return rows[0].name
  } catch (err) {
    return err.code
  }
}

async function sessions(role) {
  const { rows } = await platform.admin.query('select count(*)::int as n from pg_stat_activity where usename = $1', [role])
  return rows[0].n
}

async function roleState(role) {
  const { rows } = await platform.superuser.query('select rolcanlogin, rolpassword from pg_authid where rolname = $1', [role])
  return rows[0]
}

/** Registra ogni testo SQL e parametro inviati dal client. */
function recordQueries(t, client) {
  const sent = []
  const original = client.query
  client.query = function (text, ...rest) {
    sent.push(`${typeof text === 'string' ? text : text.text} ${JSON.stringify(rest)}`)
    return original.call(this, text, ...rest)
  }
  t.after(() => {
    client.query = original
  })
  return sent
}

test('setLogin: login con la password, solo il verificatore SCRAM nel testo SQL e nel log del server', async (t) => {
  const role = 'cs_site'
  const password = newPassword()
  const logFile = path.join(server.root, 'server.log')

  // Come Supabase (log_statement = ddl), ma registrando tutto: la password non deve comparire mai.
  await platform.superuser.query("alter system set log_statement = 'all'")
  await platform.superuser.query('select pg_reload_conf()')
  t.after(async () => {
    await platform.superuser.query('alter system reset log_statement')
    await platform.superuser.query('select pg_reload_conf()')
  })
  await waitFor(async () => (await platform.admin.query('show log_statement')).rows[0].log_statement === 'all', {
    message: 'log_statement non ricaricato'
  })
  const logOffset = fs.statSync(logFile).size

  const sent = recordQueries(t, platform.admin)
  await setLogin({ client: platform.admin, role, password })

  const { rolcanlogin, rolpassword } = await roleState(role)
  assert.equal(rolcanlogin, true)
  assert.match(rolpassword, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)

  assert.ok(sent.length > 0)
  assert.equal(sent.some((text) => text.includes(password)), false, 'password inviata al server')
  assert.ok(sent.some((text) => text.includes(rolpassword)), 'verificatore non inviato')

  const log = fs.readFileSync(logFile, 'utf8').slice(logOffset)
  assert.match(log, /statement: alter role "cs_site" login password 'SCRAM-SHA-256\$4096:/)
  assert.equal(log.includes(password), false, 'password nel log del server')

  assert.equal(await canLogin(role, password), role)
  assert.equal(await canLogin(role, newPassword()), '28P01')
})

test('setLogin: rifiuta ruoli non applicativi e password deboli, senza mostrarle', async () => {
  const password = newPassword()
  for (const role of ['postgres', 'db_admin', 'platform_admin']) {
    await assert.rejects(setLogin({ client: platform.admin, role, password }), { code: 'ROLE_NOT_ALLOWED' })
  }
  const weak = 'x'.repeat(31)
  await assert.rejects(setLogin({ client: platform.admin, role: 'ct_app', password: weak }), (err) => {
    assert.equal(err.code, 'PASSWORD_INVALID')
    assert.equal(err.message.includes(weak), false)
    return true
  })
  await assert.rejects(setLogin({ client: platform.admin, role: 'ct_app', password: `${password}\nsecondo` }), {
    code: 'PASSWORD_INVALID'
  })
  assert.equal((await roleState('platform_admin')).rolcanlogin, false)
  assert.equal(await canLogin('ct_app', platform.passwords.ct_app), 'ct_app')
})

test('disableLogin: NOLOGIN, sessioni terminate anche se il pooler le riapre, zero sessioni', async (t) => {
  const role = 'cl_app'
  const pooled = [1, 2, 3].map(() => poolerLikeSession(platform.configFor(role)))
  t.after(() => Promise.all(pooled.map((session) => session.stop())))
  await Promise.all(pooled.map((session) => session.open()))
  assert.equal(await sessions(role), 3)

  const sent = recordQueries(t, platform.admin)
  const { terminated } = await disableLogin({ client: platform.admin, role, pollMs: 50 })

  // L'ordine e' il requisito (ADR-0014 §14.3): in locale le riaperture sono troppo lente perche' l'ordine
  // sbagliato fallisca sempre, quindi si verifica anche sulle istruzioni inviate.
  const nologin = sent.findIndex((text) => /^alter role "cl_app" nologin/.test(text))
  const firstTermination = sent.findIndex((text) => text.includes('pg_terminate_backend'))
  assert.ok(nologin >= 0 && firstTermination > nologin, 'NOLOGIN non precede la terminazione delle sessioni')
  assert.ok(terminated >= 3, `terminate ${terminated}`)
  assert.equal(await sessions(role), 0)
  assert.equal((await roleState(role)).rolcanlogin, false)
  // Ogni sessione ha provato a riaprirsi ed e' stata rifiutata: login non consentito.
  await waitFor(() => pooled.every((session) => session.refused === '28000'), { message: 'riaperture non rifiutate' })
  await sleep(200)
  assert.equal(await sessions(role), 0)
  assert.equal(await canLogin(role, platform.passwords[role]), '28000')

  // Ripristino per gli altri test.
  await setLogin({ client: platform.admin, role, password: platform.passwords[role] })
  assert.equal(await canLogin(role, platform.passwords[role]), role)
})

test('disableLogin: oltre il timeout errore con il numero di sessioni rimaste', async (t) => {
  const role = 'cs_account'
  const client = await platform.connectAs(role)
  t.after(() => client.end().catch(() => {}))
  await assert.rejects(disableLogin({ client: platform.admin, role, timeoutMs: 0 }), (err) => {
    assert.equal(err.code, 'SESSIONS_LEFT')
    assert.match(err.message, /cs_account: login disattivato ma 1 sessioni ancora attive dopo 0 ms/)
    return true
  })
  await setLogin({ client: platform.admin, role, password: platform.passwords[role] })
})

test('amministratore senza pg_signal_backend ne\' ADMIN OPTION: ruolo non modificato', async (t) => {
  const password = newPassword()
  await platform.superuser.query(`create role weak_admin login createrole password '${password}'`)
  const weak = await server.connect(platform.configFor('weak_admin', password))
  t.after(() => weak.end())

  await assert.rejects(disableLogin({ client: weak, role: 'ct_app' }), { code: 'ADMIN_CANNOT_SIGNAL' })
  assert.equal((await roleState('ct_app')).rolcanlogin, true)

  await assert.rejects(setLogin({ client: weak, role: 'ct_app', password: newPassword() }), { code: 'ROLE_NOT_MANAGEABLE' })
  assert.equal(await canLogin('ct_app', platform.passwords.ct_app), 'ct_app')
})

test('CLI: role-login con password da stdin e role-disable, senza segreti in output', async () => {
  const variables = {
    PLATFORM_LOCALTEST_DATABASE_HOST: server.connection.host,
    PLATFORM_LOCALTEST_DATABASE_PORT: String(server.connection.port),
    PLATFORM_LOCALTEST_DATABASE_NAME: platform.db.name,
    PLATFORM_LOCALTEST_DATABASE_USERNAME: server.admin.user,
    PLATFORM_LOCALTEST_DATABASE_PASSWORD: server.admin.password,
    PLATFORM_LOCALTEST_DATABASE_SSL: 'false'
  }
  const role = 'ct_app'
  const password = newPassword()
  const cli = (args, input = '') => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'db', 'runner', 'cli.js'), ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, ...variables },
      input,
      encoding: 'utf8'
    })
    const output = `${result.stdout}${result.stderr}`
    for (const secret of [password, server.admin.password, 'SCRAM-SHA-256$']) {
      assert.equal(output.includes(secret), false, `segreto in output: ${secret.slice(0, 14)}`)
    }
    return result
  }

  let result = cli(['role-login', role, '--env', 'localtest'], `${password}\n`)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[role-login\] ct_app: LOGIN attivo, password impostata con il verificatore SCRAM\./)
  assert.equal(await canLogin(role, password), role)
  assert.equal(await canLogin(role, platform.passwords[role]), '28P01')

  const open = await server.connect(platform.configFor(role, password))
  result = cli(['role-disable', role, '--env', 'localtest'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[role-disable\] ct_app: NOLOGIN, 1 sessioni terminate, nessuna sessione attiva \(\d+ ms\)\./)
  await open.end().catch(() => {})
  assert.equal(await canLogin(role, password), '28000')

  result = cli(['role-login', role, '--env', 'localtest'], 'corta')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Password troppo corta/)

  result = cli(['role-login', 'platform_admin', '--env', 'localtest'], password)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Ruolo non ammesso: platform_admin/)

  result = cli(['role-disable', '--env', 'localtest'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Indica un solo ruolo/)

  // Ripristino per gli altri test.
  result = cli(['role-login', role, '--env', 'localtest'], platform.passwords[role])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(await canLogin(role, platform.passwords[role]), role)
})
