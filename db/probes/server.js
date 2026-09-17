'use strict'

/**
 * Punto 1: versione di Postgres, estensioni richieste dal bus (ADR-0014 §14.7) e contesto del
 * server. Solo letture del catalogo, con l'utente amministratore.
 */
const REQUIRED_EXTENSIONS = ['pg_cron', 'pgcrypto']
const SETTINGS = [
  'shared_preload_libraries',
  'cron.database_name',
  'supautils.privileged_extensions',
  'max_connections',
  'password_encryption',
  'pgaudit.log',
  'log_statement'
]

async function probeServer(ctx) {
  const { admin, report } = ctx
  const lit = (value) => admin.escapeLiteral(value)
  const list = (values) => values.map(lit).join(', ')

  const { rows: [server] } = await admin.query(
    "select version() as version, current_setting('server_version_num')::int as num"
  )
  report.info('1.1', server.version)
  report.info('1.1', `versione principale ${Math.floor(server.num / 10000)} (server_version_num ${server.num})`)

  const { rows: extensions } = await admin.query(`
    select a.name::text, a.default_version::text, e.extversion::text as installed_version, n.nspname::text as schema
      from pg_available_extensions a
      left join pg_extension e on e.extname = a.name
      left join pg_namespace n on n.oid = e.extnamespace
     where a.name in (${list(REQUIRED_EXTENSIONS)})`)
  for (const name of REQUIRED_EXTENSIONS) {
    const ext = extensions.find((row) => row.name === name)
    if (!ext) report.ko('1.2', `${name}: non disponibile sul server`)
    else if (ext.installed_version) {
      report.ok('1.2', `${name}: installata, versione ${ext.installed_version}, schema ${ext.schema} (disponibile ${ext.default_version})`)
    } else report.ok('1.2', `${name}: disponibile (versione ${ext.default_version}), non installata`)
  }

  const { rows: [installed] } = await admin.query(
    "select coalesce(string_agg(extname || ' ' || extversion, ', ' order by extname), 'nessuna') as list from pg_extension"
  )
  report.info('1.2', `estensioni installate: ${installed.list}`)

  const { rows: settings } = await admin.query(
    `select name::text, setting::text from pg_settings where name in (${list(SETTINGS)})`
  )
  for (const name of SETTINGS) {
    const setting = settings.find((row) => row.name === name)
    report.info('1.3', `${name} = ${setting ? `"${setting.setting}"` : '(non definita o non leggibile)'}`)
  }

  const { rows: [role] } = await admin.query(`
    select current_user::text as name, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication,
           pg_has_role(current_user, 'pg_signal_backend', 'USAGE') as signal_backend
      from pg_roles where rolname = current_user`)
  report.info(
    '1.3',
    `amministratore ${role.name}: superuser ${role.rolsuper}, createrole ${role.rolcreaterole}, ` +
      `createdb ${role.rolcreatedb}, bypassrls ${role.rolbypassrls}, replication ${role.rolreplication}, ` +
      `pg_signal_backend ${role.signal_backend}`
  )

  const { rows: [conn] } = await admin.query(
    "select current_setting('max_connections')::int as max, count(*)::int as used from pg_stat_activity"
  )
  report.info('1.3', `connessioni: max_connections ${conn.max}, righe in pg_stat_activity ${conn.used}`)

  const { rows: [triggers] } = await admin.query(`
    select coalesce(string_agg(evtname::text || ' (' || evtevent::text || ', ' || evtenabled::text || ')', ', ' order by evtname), 'nessuno') as list
      from pg_event_trigger`)
  report.info('1.3', `event trigger (scattano anche sul DDL delle prove): ${triggers.list}`)

  const { rows: [realtime] } = await admin.query(`
    select exists (select 1 from pg_namespace where nspname = 'realtime') as schema,
           exists (select 1 from pg_publication where pubname = 'supabase_realtime') as publication`)
  report.info('1.3', `realtime Supabase: schema realtime ${realtime.schema}, publication supabase_realtime ${realtime.publication}`)
}

/** Le prove aprono una decina di connessioni: senza margine si fermano prima di iniziare. */
async function checkHeadroom(ctx) {
  const { admin, report, options } = ctx
  const { rows: [conn] } = await admin.query(
    "select current_setting('max_connections')::int as max, count(*)::int as used from pg_stat_activity"
  )
  const free = conn.max - conn.used
  const text = `margine connessioni ${free} (max_connections ${conn.max}, in uso ${conn.used}; minimo ${options.minFreeConnections})`
  if (free < options.minFreeConnections) throw new Error(`Prove non avviate: ${text}`)
  report.ok('P.2', text)
}

module.exports = { probeServer, checkHeadroom }
