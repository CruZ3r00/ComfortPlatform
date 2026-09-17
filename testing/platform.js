'use strict'

/**
 * Piattaforma installata come su Supabase, per i test di ComfortPlatform e delle app.
 *
 * Le migrazioni di `db/migrations` vengono applicate dall'amministratore NON superutente (`db_admin`) nel
 * database di pg_cron (`postgres`); le password degli utenti applicativi si impostano con il runner
 * (`setLogin`), e i test si collegano come quegli utenti, con la loro password.
 */
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { apply } = require('../db/runner/runner')
const { APP_ROLES, setLogin } = require('../db/runner/roles')

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'db', 'migrations')

/** Password casuale di 32 caratteri, la lunghezza minima ammessa dal runner. */
const newPassword = () => randomBytes(24).toString('base64url')

/**
 * Applica le migrazioni come `db_admin`. Con `logins` (default) imposta LOGIN e password dei quattro
 * utenti applicativi. Restituisce client di amministratore e superutente, password e `connectAs(role)`.
 */
async function installPlatform(server, { logins = true } = {}) {
  const db = server.database(server.cronDatabase)
  const admin = await db.connectAdmin()
  const superuser = await db.connect()
  const { applied } = await apply({ client: admin, dir: MIGRATIONS_DIR })

  const passwords = {}
  if (logins) {
    for (const role of APP_ROLES) {
      passwords[role] = newPassword()
      await setLogin({ client: admin, role, password: passwords[role] })
    }
  }

  const configFor = (role, password = passwords[role]) => ({
    host: server.connection.host,
    port: server.connection.port,
    database: db.name,
    user: role,
    password
  })

  return {
    db,
    admin,
    superuser,
    applied,
    passwords,
    configFor,
    connectAs: (role) => server.connect(configFor(role))
  }
}

module.exports = { APP_ROLES, MIGRATIONS_DIR, newPassword, installPlatform }
