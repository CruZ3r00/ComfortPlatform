'use strict'

/**
 * Fixture per 0008-0009: il database di staging com'era prima della Fase 1, senza dati.
 *
 * - `tests/fixtures/comfortables-public-schema-2026-09-17.sql.gz`: struttura dello schema `public` di staging
 *   (`pg_restore --schema-only -n public --no-owner --no-acl` del backup del 2026-09-17, senza le righe
 *   `\restrict`): 160 tabelle, 21 funzioni, 16 trigger, 3 policy, 2 tabelle nella publication `supabase_realtime`.
 * - `supabaseLike`: cio' che su Supabase esiste gia' e nel kit no: ruoli `anon`, `authenticated`, `service_role`,
 *   `auth.jwt()` (usata dalle policy dei campanelli), publication `supabase_realtime` dell'amministratore.
 * - `catalog`: fotografia confrontabile di uno schema (proprieta', RLS, permessi, funzioni, trigger, policy,
 *   publication), con i permessi normalizzati: un ACL nullo e quello esplicito del solo proprietario sono uguali; i
 *   corpi delle funzioni a parita' di fine riga (su staging due funzioni hanno CRLF, i file SQL no).
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { apply } = require('../../db/runner/runner')
const { MIGRATIONS_DIR } = require('../../testing')

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'comfortables-public-schema-2026-09-17.sql.gz')

/** Migrazioni di piattaforma fino a `last` compreso, copiate in una cartella temporanea. */
function migrationsUpTo(t, last) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'comfortplatform-migrazioni-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    if (name <= last) fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name))
  }
  return dir
}

async function supabaseLike(server, db) {
  const superuser = await db.connect()
  try {
    await superuser.query(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable
        as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      grant usage on schema auth to anon, authenticated, ${server.admin.user};`)
  } finally {
    await superuser.end()
  }
  const admin = await db.connectAdmin()
  try {
    await admin.query('create publication supabase_realtime')
  } finally {
    await admin.end()
  }
}

/** Struttura di ComforTables in public, dell'amministratore, con i permessi di staging sui campanelli. */
async function loadComfortables(admin) {
  await admin.query(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8'))
  await admin.query('reset all')
  await admin.query('grant select on public.order_realtime_events, public.table_order_realtime_events to authenticated')
}

/**
 * Cluster con piattaforma fino a 0007, ruoli e oggetti di Supabase, ComforTables in public: lo stato di staging
 * prima della Fase 1. Restituisce i client di amministratore e superutente.
 */
async function stagingBeforePhase1(t, server, { beforeLoad } = {}) {
  const db = server.database(server.cronDatabase)
  await supabaseLike(server, db)
  const admin = await db.connectAdmin()
  const superuser = await db.connect()
  await apply({ client: admin, dir: migrationsUpTo(t, '0007_account_schema.sql') })
  if (beforeLoad) await beforeLoad({ admin, superuser })
  await loadComfortables(admin)
  return { db, admin, superuser }
}

/** ACL confrontabile: nullo = default del tipo di oggetto; voci ordinate, perche' l'ordine dipende dalla storia. */
const acl = (column, kind, owner) =>
  `(select string_agg(item::text, ',' order by item::text) from unnest(coalesce(${column}, acldefault(${kind}, ${owner}))) as item)`

/** Fotografia di uno schema, per confronti prima/dopo. */
async function catalog(superuser, schema) {
  const query = async (text) => (await superuser.query(text, [schema])).rows
  return {
    schema: await query(
      `select nspowner::regrole::text as owner, ${acl('nspacl', "'n'", 'nspowner')} as acl from pg_namespace where nspname = $1`
    ),
    relations: await query(
      `select c.relname::text as name, c.relkind::text as kind, c.relowner::regrole::text as owner, c.relrowsecurity as rls,
              ${acl('c.relacl', `(case c.relkind when 'S' then 's' else 'r' end)::"char"`, 'c.relowner')} as acl
         from pg_class c where c.relnamespace = to_regnamespace($1) order by c.relname`
    ),
    functions: await query(
      `select p.proname::text as name, pg_get_function_identity_arguments(p.oid) as args, p.proowner::regrole::text as owner,
              p.prosecdef as definer, p.proconfig, md5(replace(p.prosrc, E'\\r\\n', E'\\n')) as source, ${acl('p.proacl', "'f'", 'p.proowner')} as acl
         from pg_proc p where p.pronamespace = to_regnamespace($1) order by p.proname`
    ),
    triggers: await query(
      `select c.relname::text as tabella, t.tgname::text as nome, (select p.proname::text from pg_proc p where p.oid = t.tgfoid) as funzione
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal and c.relnamespace = to_regnamespace($1) order by 1, 2`
    ),
    policies: await query(
      'select tablename::text, policyname::text, roles::text, cmd, qual, with_check from pg_policies where schemaname = $1 order by 1, 2'
    ),
    publication: await query(
      "select tablename::text from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = $1 order by 1"
    )
  }
}

module.exports = { FIXTURE, migrationsUpTo, supabaseLike, loadComfortables, stagingBeforePhase1, catalog }
