'use strict'

/**
 * Verificatore SCRAM-SHA-256 calcolato in locale (ADR-0014 §14.3 «Utenti Postgres e password»).
 *
 * Al server arriva `ALTER ROLE … PASSWORD '<verificatore>'`: Postgres lo salva cosi' com'e', e la
 * password in chiaro non finisce ne' nel testo SQL ne' nei log delle istruzioni (`log_statement = ddl`
 * su Supabase). Il verificatore invece compare nei log: per questo le password devono essere casuali
 * e lunghe.
 */
const { createHash, createHmac, pbkdf2Sync, randomBytes } = require('node:crypto')

// Default di Postgres (`scram_iterations`).
const SCRAM_ITERATIONS = 4096

/** Verificatore nel formato di `pg_authid.rolpassword` (RFC 5802, RFC 7677). */
function scramVerifier(password, salt = randomBytes(16)) {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

module.exports = { SCRAM_ITERATIONS, scramVerifier }
