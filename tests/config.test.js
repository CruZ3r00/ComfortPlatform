'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { connectionFromEnv } = require('../db/runner/config')

const SECRET = 'S3greta-da-non-stampare'

const base = (overrides = {}) => ({
  PLATFORM_STAGING_DATABASE_HOST: 'db.example.test',
  PLATFORM_STAGING_DATABASE_USERNAME: 'postgres',
  PLATFORM_STAGING_DATABASE_PASSWORD: SECRET,
  PLATFORM_STAGING_DATABASE_SSL: 'false',
  ...overrides
})

test('costruisce la configurazione dalle variabili dell\'ambiente scelto, con i default', () => {
  const { config, warnings } = connectionFromEnv('staging', base())
  assert.deepEqual(config, {
    host: 'db.example.test',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: SECRET,
    ssl: false,
    application_name: 'comfortplatform-migrations',
    connectionTimeoutMillis: 30000
  })
  assert.deepEqual(warnings, [])
})

test('legge solo le variabili del proprio ambiente', () => {
  assert.throws(
    () => connectionFromEnv('production', base()),
    (err) =>
      err.code === 'CONFIG_INVALID' &&
      err.message.includes('PLATFORM_PRODUCTION_DATABASE_HOST mancante') &&
      err.message.includes('PLATFORM_PRODUCTION_DATABASE_USERNAME mancante') &&
      err.message.includes('PLATFORM_PRODUCTION_DATABASE_PASSWORD mancante')
  )
})

test('i segnaposto contano come mancanti e i valori non finiscono nel messaggio', () => {
  assert.throws(
    () =>
      connectionFromEnv(
        'staging',
        base({
          PLATFORM_STAGING_DATABASE_HOST: 'changeme',
          PLATFORM_STAGING_DATABASE_PORT: 'novanta',
          PLATFORM_STAGING_DATABASE_SSL: 'forse'
        })
      ),
    (err) =>
      err.code === 'CONFIG_INVALID' &&
      err.message.includes('PLATFORM_STAGING_DATABASE_HOST mancante o segnaposto') &&
      err.message.includes('PLATFORM_STAGING_DATABASE_PORT deve essere un intero') &&
      err.message.includes('PLATFORM_STAGING_DATABASE_SSL deve essere true o false') &&
      !err.message.includes(SECRET) &&
      !err.message.includes('novanta') &&
      !err.message.includes('forse')
  )
})

test('TLS di default: senza CA si ferma, a meno di un downgrade esplicito', () => {
  const tls = { PLATFORM_STAGING_DATABASE_SSL: undefined }
  assert.throws(() => connectionFromEnv('staging', base(tls)), {
    code: 'CONFIG_INVALID',
    message: /PLATFORM_STAGING_DATABASE_SSL_CA mancante/
  })
  assert.throws(
    () => connectionFromEnv('staging', base({ ...tls, PLATFORM_STAGING_DATABASE_SSL_CA: '/non/esiste.crt' })),
    { code: 'CONFIG_INVALID', message: /PLATFORM_STAGING_DATABASE_SSL_CA punta a un file inesistente/ }
  )

  const downgraded = connectionFromEnv(
    'staging',
    base({ ...tls, PLATFORM_STAGING_DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' })
  )
  assert.deepEqual(downgraded.config.ssl, { rejectUnauthorized: false })
  assert.match(downgraded.warnings[0], /NON verificato/)
})

test('TLS con CA: certificato letto dal file e verifica attiva', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'comfortplatform-ca-'))
  try {
    const caPath = path.join(dir, 'ca.crt')
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nfinto\n')
    const { config, warnings } = connectionFromEnv(
      'staging',
      base({ PLATFORM_STAGING_DATABASE_SSL: 'true', PLATFORM_STAGING_DATABASE_SSL_CA: caPath })
    )
    assert.deepEqual(config.ssl, { ca: '-----BEGIN CERTIFICATE-----\nfinto\n', rejectUnauthorized: true })
    assert.deepEqual(warnings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rifiuta nomi d\'ambiente non validi', () => {
  for (const name of [undefined, '', 'Staging', '../prod', 'stag-ing', '1staging']) {
    assert.throws(() => connectionFromEnv(name, base()), {
      code: 'CONFIG_INVALID',
      message: /il nome dell'ambiente deve rispettare/
    })
  }
})
