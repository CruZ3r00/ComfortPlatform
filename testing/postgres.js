'use strict'

/**
 * Postgres temporaneo per i test.
 *
 * Un cluster vero, creato con initdb in una cartella temporanea, avviato con pg_ctl su una porta
 * libera di 127.0.0.1 e distrutto a fine test. Niente emulatori: il runner deve vedere
 * transazioni, lock, errori e cataloghi reali.
 *
 * Binari: PG_BIN_DIR, altrimenti /usr/lib/postgresql/<PG_VERSION, default 17>/bin: la versione
 * principale di Supabase (docs/prove-tecniche-staging.md, punto 1).
 * Se mancano i test FALLISCONO: un test saltato non prova nulla.
 *
 * Il cluster imita Supabase dove conta per le migrazioni di piattaforma (ADR-0014 §14.3):
 * - `pg_cron` precaricata, con `cron.database_name = 'postgres'`;
 * - amministratore `db_admin` NON superutente, con gli attributi di `postgres` su staging (§3.1, §8.1):
 *   CREATEROLE, CREATEDB, BYPASSRLS, REPLICATION, `pg_signal_backend`, `pg_read_all_settings`;
 * - l'estensione `pg_cron` esiste gia' nel database `postgres`, creata dal superutente, con i permessi
 *   che su Supabase concede a `postgres` l'event trigger `issue_pg_cron_access`. E' un'emulazione:
 *   su Supabase la crea supautils, che in locale non c'e', e un non superutente non puo' crearla.
 * In locale i job girano in background worker (`cron.use_background_workers`), senza autenticazione
 * con password; l'identita' del job resta l'utente che lo pianifica.
 */
const { spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const pg = require('pg')

const DEFAULT_VERSION = '17'
const START_ATTEMPTS = 5
const ADMIN_USER = 'db_admin'
const CRON_DATABASE = 'postgres'

function resolveBinDir() {
  const version = process.env.PG_VERSION || DEFAULT_VERSION
  const dir = process.env.PG_BIN_DIR || `/usr/lib/postgresql/${version}/bin`
  const missing = ['initdb', 'pg_ctl', 'postgres'].filter((bin) => !fs.existsSync(path.join(dir, bin)))
  if (missing.length) {
    throw new Error(
      `Binari server Postgres mancanti in ${dir}: ${missing.join(', ')}.\n` +
        `Installa il server e pg_cron (Debian: sudo apt install postgresql-${version} postgresql-${version}-cron; ` +
        'istruzioni complete in testing/README.md di comfort-platform) oppure indica la cartella dei binari con PG_BIN_DIR.'
    )
  }
  return dir
}

function run(binDir, bin, args) {
  const result = spawnSync(path.join(binDir, bin), args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${bin} fallito (uscita ${result.status}):\n${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * Avvia un cluster. Con `pgCron: false` pg_cron non viene precaricata (solo per provare l'errore).
 * Restituisce:
 * - `connection`: host, port, user, password del superutente (senza database);
 * - `admin`: user e password dell'amministratore non superutente;
 * - `root`: cartella temporanea del cluster;
 * - `majorVersion`: versione principale del server;
 * - `pgCron`: se pg_cron e' precaricata e creata nel database `postgres`;
 * - `createDatabase()`: database nuovo da template0, con CREATE all'amministratore;
 * - `database(name)`: un database esistente (es. `postgres`, quello di pg_cron);
 *   entrambi restituiscono `{ name, config, adminConfig, connect(), connectAdmin() }`;
 * - `connect(config)`: client con una configurazione qualsiasi (es. un utente applicativo), chiuso da `stop()`;
 * - `stop()`: chiude i client aperti dall'harness, ferma il server e cancella la cartella.
 */
async function startPostgres({ pgCron = true } = {}) {
  const binDir = resolveBinDir()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfortplatform-pg-'))
  const dataDir = path.join(root, 'data')
  const logFile = path.join(root, 'server.log')
  const password = randomBytes(24).toString('hex')
  const adminPassword = randomBytes(24).toString('hex')
  const clients = new Set()
  let running = false

  const stopSync = () => {
    process.removeListener('exit', stopSync)
    if (running) {
      spawnSync(path.join(binDir, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], {
        encoding: 'utf8'
      })
      running = false
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
  // Se il processo dei test termina senza passare da stop(), il cluster non resta acceso.
  process.on('exit', stopSync)

  try {
    const pwFile = path.join(root, 'pwfile')
    fs.writeFileSync(pwFile, `${password}\n`, { mode: 0o600 })
    try {
      run(binDir, 'initdb', [
        '-D', dataDir,
        '-U', 'postgres',
        '--auth=scram-sha-256',
        `--pwfile=${pwFile}`,
        '--encoding=UTF8',
        '--locale=C',
        '--no-sync',
        '--no-instructions'
      ])
    } finally {
      fs.rmSync(pwFile, { force: true })
    }

    let port
    for (let attempt = 1; !running; attempt++) {
      port = await freePort()
      // Impostazioni in coda a postgresql.conf: vince l'ultima occorrenza, quindi un nuovo
      // tentativo con un'altra porta sovrascrive il precedente.
      fs.appendFileSync(
        path.join(dataDir, 'postgresql.conf'),
        [
          '',
          `port = ${port}`,
          "listen_addresses = '127.0.0.1'",
          `unix_socket_directories = '${root}'`,
          'fsync = off',
          'synchronous_commit = off',
          'full_page_writes = off',
          ...(pgCron
            ? [
                "shared_preload_libraries = 'pg_cron'",
                `cron.database_name = '${CRON_DATABASE}'`,
                'cron.use_background_workers = on'
              ]
            : []),
          ''
        ].join('\n')
      )
      try {
        run(binDir, 'pg_ctl', ['-D', dataDir, '-l', logFile, '-w', '-t', '60', 'start'])
        running = true
      } catch (err) {
        const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
        if (attempt >= START_ATTEMPTS || !/already in use/i.test(log)) {
          throw new Error(`${err.message}\nLog del server:\n${log}`, { cause: err })
        }
      }
    }

    const connection = { host: '127.0.0.1', port, user: 'postgres', password }

    const connect = async (config) => {
      const client = new pg.Client(config)
      // Lo stop immediato chiude le connessioni ancora aperte: non e' un errore del test.
      client.on('error', () => {})
      await client.connect()
      clients.add(client)
      const end = client.end.bind(client)
      client.end = () => {
        clients.delete(client)
        return end()
      }
      return client
    }

    const superuser = await connect({ ...connection, database: 'postgres' })
    let majorVersion
    try {
      const { rows } = await superuser.query("select current_setting('server_version_num')::int as num")
      majorVersion = Math.floor(rows[0].num / 10000)
      await superuser.query(`
        create role ${ADMIN_USER} login createrole createdb bypassrls replication password '${adminPassword}';
        grant pg_signal_backend, pg_read_all_settings to ${ADMIN_USER};
        grant create on database postgres to ${ADMIN_USER};`)
      if (pgCron) {
        await superuser.query(`
          create extension pg_cron;
          grant usage on schema cron to ${ADMIN_USER} with grant option;
          grant all privileges on all tables in schema cron to ${ADMIN_USER} with grant option;
          revoke all on table cron.job from ${ADMIN_USER};
          grant select on table cron.job to ${ADMIN_USER} with grant option;`)
      }
    } finally {
      await superuser.end()
    }

    const admin = { user: ADMIN_USER, password: adminPassword }
    const database = (name) => {
      const config = { ...connection, database: name }
      const adminConfig = { ...connection, ...admin, database: name }
      return { name, config, adminConfig, connect: () => connect(config), connectAdmin: () => connect(adminConfig) }
    }

    let databases = 0
    return {
      connection,
      admin,
      root,
      majorVersion,
      pgCron,
      cronDatabase: CRON_DATABASE,
      database,
      connect,
      async createDatabase() {
        const name = `t_${++databases}`
        const client = await connect({ ...connection, database: 'postgres' })
        try {
          await client.query(`create database ${name} template template0`)
          await client.query(`grant create on database ${name} to ${ADMIN_USER}`)
        } finally {
          await client.end()
        }
        return database(name)
      },
      async stop() {
        await Promise.all([...clients].map((client) => client.end().catch(() => {})))
        stopSync()
      }
    }
  } catch (err) {
    stopSync()
    throw err
  }
}

module.exports = { startPostgres }
