'use strict'

/**
 * Kit di test di ComfortPlatform per le app (`require('comfort-platform/testing')`).
 *
 * - `startPostgres()`: cluster Postgres 17 temporaneo con pg_cron e amministratore non superutente, come Supabase;
 * - `installPlatform(server)`: migrazioni di piattaforma e login degli utenti applicativi, con `configFor(ruolo)`
 *   e `connectAs(ruolo)`.
 *
 * Istruzioni in testing/README.md.
 */
const { startPostgres } = require('./postgres')
const { APP_ROLES, MIGRATIONS_DIR, newPassword, installPlatform } = require('./platform')

module.exports = { startPostgres, installPlatform, newPassword, APP_ROLES, MIGRATIONS_DIR }
