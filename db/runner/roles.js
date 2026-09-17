'use strict'

/**
 * Login degli utenti applicativi (ADR-0014 §14.3 «Utenti Postgres e password»).
 *
 * Le migrazioni creano gli utenti NOLOGIN e senza password. Qui, fuori dai file SQL:
 * - `setLogin`: LOGIN e password in un'unica istruzione con il verificatore SCRAM calcolato in locale,
 *   mai la password in chiaro;
 * - `disableLogin`: NOLOGIN, poi terminazione delle sessioni, poi attesa di zero sessioni. L'ordine conta:
 *   il pooler (Supavisor) riapre subito le connessioni terminate finche' il login e' consentito.
 *
 * Solo i quattro utenti applicativi: `platform_admin` e' proprietario del bus e non deve avere login.
 */
const { setTimeout: sleep } = require('node:timers/promises')
const { scramVerifier } = require('./scram')

const APP_ROLES = ['ct_app', 'cs_site', 'cs_account', 'cl_app']
const MIN_PASSWORD_LENGTH = 32
const DISABLE_TIMEOUT_MS = 30000
const POLL_MS = 250

function roleError(code, message) {
  return Object.assign(new Error(message), { code })
}

function checkRole(role) {
  if (!APP_ROLES.includes(role)) {
    throw roleError('ROLE_NOT_ALLOWED', `Ruolo non ammesso: ${role}. Ammessi: ${APP_ROLES.join(', ')}.`)
  }
}

/** La password non compare mai nei messaggi: solo il motivo del rifiuto. */
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw roleError(
      'PASSWORD_INVALID',
      `Password troppo corta: servono almeno ${MIN_PASSWORD_LENGTH} caratteri casuali (il verificatore SCRAM finisce nei log del server).`
    )
  }
  if (/[\r\n\0]/.test(password)) {
    throw roleError('PASSWORD_INVALID', 'La password non puo\' contenere a capo o caratteri nulli.')
  }
}

/** Il ruolo deve esistere e l'amministratore deve averne l'ADMIN OPTION (chi l'ha creato ce l'ha). */
async function checkRoleManageable(client, role) {
  const { rows } = await client.query(
    "select pg_has_role(current_user, rolname, 'MEMBER WITH ADMIN OPTION') as manageable from pg_roles where rolname = $1",
    [role]
  )
  if (!rows.length) {
    throw roleError('ROLE_MISSING', `Il ruolo ${role} non esiste: applica prima le migrazioni di piattaforma.`)
  }
  if (!rows[0].manageable) {
    throw roleError('ROLE_NOT_MANAGEABLE', `L'utente corrente non ha l'ADMIN OPTION su ${role}: non puo' modificarlo.`)
  }
}

/** LOGIN e password del ruolo, con il solo verificatore SCRAM nel testo SQL. */
async function setLogin({ client, role, password }) {
  checkRole(role)
  checkPassword(password)
  await checkRoleManageable(client, role)
  await client.query(
    `alter role ${client.escapeIdentifier(role)} login password ${client.escapeLiteral(scramVerifier(password))}`
  )
  return { role }
}

/**
 * NOLOGIN, poi a ogni giro termina tutte le sessioni del ruolo e le conta, finche' non sono zero.
 * Terminare a ogni giro copre anche le autenticazioni partite prima del NOLOGIN.
 * Restituisce `{ role, terminated }` (sessioni distinte terminate); oltre il timeout errore.
 */
async function disableLogin({ client, role, timeoutMs = DISABLE_TIMEOUT_MS, pollMs = POLL_MS }) {
  checkRole(role)
  const { rows: [admin] } = await client.query(
    "select rolsuper or pg_has_role(current_user, 'pg_signal_backend', 'USAGE') as can_signal from pg_roles where rolname = current_user"
  )
  if (!admin.can_signal) {
    throw roleError(
      'ADMIN_CANNOT_SIGNAL',
      `L'utente corrente non ha pg_signal_backend: non potrebbe terminare le sessioni di ${role}. Ruolo non modificato.`
    )
  }
  await checkRoleManageable(client, role)

  await client.query(`alter role ${client.escapeIdentifier(role)} nologin`)

  const terminated = new Set()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { rows } = await client.query(
      'select pid, pg_terminate_backend(pid) as signalled from pg_stat_activity where usename = $1',
      [role]
    )
    for (const row of rows) if (row.signalled) terminated.add(row.pid)
    if (!rows.length) return { role, terminated: terminated.size }
    if (Date.now() >= deadline) {
      throw roleError(
        'SESSIONS_LEFT',
        `${role}: login disattivato ma ${rows.length} sessioni ancora attive dopo ${timeoutMs} ms.`
      )
    }
    await sleep(pollMs)
  }
}

module.exports = { APP_ROLES, MIN_PASSWORD_LENGTH, checkRole, checkPassword, setLogin, disableLogin }
