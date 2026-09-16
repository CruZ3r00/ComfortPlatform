'use strict'

/**
 * Postgres temporaneo per i test.
 *
 * Un cluster vero, creato con initdb in una cartella temporanea, avviato con pg_ctl su una porta
 * libera di 127.0.0.1 e distrutto a fine test. Niente emulatori: il runner deve vedere
 * transazioni, lock, errori e cataloghi reali.
 *
 * Binari: PG_BIN_DIR, altrimenti /usr/lib/postgresql/<PG_VERSION, default 16>/bin (ADR-0014 §14.6).
 * Se mancano i test FALLISCONO: un test saltato non prova nulla.
 */
const { spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const pg = require('pg')

const DEFAULT_VERSION = '16'
const START_ATTEMPTS = 5

function resolveBinDir() {
  const version = process.env.PG_VERSION || DEFAULT_VERSION
  const dir = process.env.PG_BIN_DIR || `/usr/lib/postgresql/${version}/bin`
  const missing = ['initdb', 'pg_ctl', 'postgres'].filter((bin) => !fs.existsSync(path.join(dir, bin)))
  if (missing.length) {
    throw new Error(
      `Binari server Postgres mancanti in ${dir}: ${missing.join(', ')}.\n` +
        `Installa il server (Debian: sudo apt install postgresql-${version}; istruzioni complete ` +
        'in CLAUDE.md > Comandi) oppure indica la cartella dei binari con PG_BIN_DIR.'
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
 * Avvia un cluster. Restituisce:
 * - `connection`: host, port, user, password (senza database);
 * - `root`: cartella temporanea del cluster;
 * - `majorVersion`: versione principale del server;
 * - `createDatabase()`: database nuovo da template0, `{ name, config, connect() }`;
 * - `stop()`: chiude i client aperti dall'harness, ferma il server e cancella la cartella.
 */
async function startPostgres() {
  const binDir = resolveBinDir()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfortplatform-pg-'))
  const dataDir = path.join(root, 'data')
  const logFile = path.join(root, 'server.log')
  const password = randomBytes(24).toString('hex')
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

    const admin = await connect({ ...connection, database: 'postgres' })
    const { rows } = await admin.query("select current_setting('server_version_num')::int as num")
    const majorVersion = Math.floor(rows[0].num / 10000)
    await admin.end()

    let databases = 0
    return {
      connection,
      root,
      majorVersion,
      async createDatabase() {
        const name = `t_${++databases}`
        const client = await connect({ ...connection, database: 'postgres' })
        try {
          await client.query(`create database ${name} template template0`)
        } finally {
          await client.end()
        }
        const config = { ...connection, database: name }
        return { name, config, connect: () => connect(config) }
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
