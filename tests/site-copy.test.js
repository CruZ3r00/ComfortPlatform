'use strict'

// data-migrations/site-copy (ADR-0014 §14.1, §14.5): il sito dal database di oggi a public del database unico, come
// cs_site. Struttura reale del sito (tests/fixtures/site-public-schema-017.sql), sorgente e destinazione in due database
// dello stesso cluster. Su Supabase il sito di oggi e' in `public`; qui la sorgente usa un altro nome, cosi' il test
// prova anche che lo schema non e' fisso.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { installPlatform, startPostgres } = require('../testing')
const { SITE_TABLES, copySite, formatReport } = require('../data-migrations/site-copy/copy')

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'site-public-schema-017.sql'), 'utf8')
const MIGRATIONS = Array.from({ length: 17 }, (_, i) => `${String(i + 1).padStart(3, '0')}_sito.sql`)
const SOURCE_SCHEMA = 'sito_oggi'

/** Valori scomodi: microsecondi e fusi, HTML, Unicode, a capo e backslash, array con null e virgole, id con buchi. */
const SOURCE_ROWS = `
  insert into sito_oggi.languages (code, label, label_short, is_default, is_active, sort_order, created_at, updated_at) values
    ('it', 'Italiano', 'IT', true, true, 1, '2026-07-01 10:00:00.123456+02', '2026-08-05 22:00:00.654321+00'),
    ('en', 'English', 'EN', false, true, 2, '2026-07-01 10:00:00+02', '2026-07-01 10:00:00+02'),
    ('de', 'Deutsch', 'DE', false, false, 3, '2026-07-01 10:00:00+02', '2026-07-01 10:00:00+02');
  insert into sito_oggi.translations (id, string_key, lang_code, value, is_html) overriding system value values
    (1, 'hero.title', 'it', 'Dal caos a un sistema che <em>tiene</em>', true),
    (7, 'hero.title', 'en', 'From chaos to a system that <em>holds</em>', true),
    (42, 'nav.faq', 'it', E'perché — “virgolette” 🍝 \\\\ riga\\nnuova', false);
  select setval(pg_get_serial_sequence('sito_oggi.translations', 'id'), 100);
  insert into sito_oggi.services (id, slug, name, url, accent, sort_order, status) overriding system value values
    (1, 'tables', 'ComforTables', 'https://app.comfortables.eu', 'blue', 1, 'beta'),
    (3, 'rooms', 'ComfortRooms', null, 'turquoise', 2, 'development');
  insert into sito_oggi.service_translations (id, service_id, lang_code, kind, description, features) overriding system value values
    (1, 1, 'it', 'gestionale per ristoranti', 'Sala, cucina e cassa', array['Comande', 'Menu "digitale"', 'a,b', null]),
    (2, 3, 'en', 'hotel management', 'Rooms', array['Booking']);
  insert into sito_oggi.pages (id, page_key, kind, service_slug, sort_order) overriding system value values
    (1, 'home', 'home', null, 0),
    (2, 'tables', 'product', 'tables', 1);
  insert into sito_oggi.page_translations (id, page_id, lang_code, slug, meta_title, meta_description) overriding system value values
    (1, 1, 'it', '', 'ComfortService, software', repeat('descrizione ', 5)),
    (2, 2, 'en', 'restaurant-management-software', 'Restaurant management', repeat('description ', 5));
  insert into sito_oggi.faqs (id, faq_key, page_key, topic, sort_order) overriding system value values
    (1, 'costo', 'tables', 'prezzi', 1),
    (2, 'dati', null, 'generale', 2);
  insert into sito_oggi.faq_translations (id, faq_id, lang_code, question, answer) overriding system value values
    (1, 1, 'it', 'Quanto costa?', 'Dipende.'),
    (2, 2, 'en', 'Data?', 'EU.');
  insert into sito_oggi.contact_messages (id, name, reply_to_email, subject, body, lang_code, status, attempts, last_error, created_at, sent_at)
    overriding system value values
    (1, 'Visitatore', 'v@example.com', null, 'Ciao', 'it', 'sent', 1, null, '2026-08-05 22:00:00.000001+00', '2026-08-05 22:00:01+00'),
    (2, 'Altro', 'a@example.com', 'Info', 'Testo', null, 'failed', 3, 'ECONNREFUSED', '2026-08-05 23:00:00+00', null);`

/** Righe che le migrazioni del sito lasciano nella destinazione prima della copia. */
const TARGET_SEEDS = `
  insert into public.languages (code, label, label_short, is_default) values ('it', 'Italiano (seed)', 'IT', true);
  insert into public.translations (string_key, lang_code, value) values ('hero.title', 'it', 'seed'), ('nav.faq', 'it', 'seed');
  insert into public.services (slug, name) values ('tables', 'ComforTables (seed)');`

async function siteStack(t) {
  const server = await startPostgres()
  t.after(() => server.stop())
  const platform = await installPlatform(server)

  const cs = await platform.connectAs('cs_site')
  await cs.query(FIXTURE)
  await cs.query('reset all')
  await cs.query(TARGET_SEEDS)
  await cs.query('insert into public.schema_migrations (name) select unnest($1::text[])', [MIGRATIONS])

  const sourceDb = await server.createDatabase()
  const source = await sourceDb.connectAdmin()
  await source.query(`create schema ${SOURCE_SCHEMA}`)
  await source.query(FIXTURE.replace(/\bpublic\./g, `${SOURCE_SCHEMA}.`))
  await source.query('reset all')
  await source.query(SOURCE_ROWS)
  await source.query(`insert into ${SOURCE_SCHEMA}.schema_migrations (name) select unnest($1::text[])`, [MIGRATIONS.slice(0, 16)])
  const sourceSuperuser = await sourceDb.connect()

  return { server, platform, cs, source, sourceSuperuser, target: platform.admin }
}

/** Impronta indipendente dall'implementazione: testo delle righe (UTC) ordinate per chiave, e sequenze. */
async function fingerprint(client, schema) {
  await client.query('begin')
  await client.query("set local timezone to 'UTC'")
  const out = {}
  for (const table of SITE_TABLES) {
    const key = table === 'languages' ? 'code' : 'id'
    const { rows: [row] } = await client.query(
      `select count(*)::int as n, md5(coalesce(string_agg(t::text, E'\\n' order by ${key}), '')) as md5 from ${schema}.${table} t`
    )
    if (key === 'id') {
      const { rows: [seq] } = await client.query(`select last_value::text, is_called from ${schema}.${table}_id_seq`)
      row.sequence = seq
    }
    out[table] = row
  }
  await client.query('commit')
  return out
}

test('prova di default: report e destinazione invariata; --apply: righe e sequenze identiche, ripetibile', async (t) => {
  const { platform, cs, source, sourceSuperuser, target } = await siteStack(t)
  const sourceBefore = await fingerprint(sourceSuperuser, SOURCE_SCHEMA)
  const targetBefore = await fingerprint(platform.superuser, 'public')

  const dry = await copySite({ source, target, sourceSchema: SOURCE_SCHEMA })
  assert.equal(dry.committed, false)
  assert.deepEqual(dry.report.map(({ table, source: n, before, after, identical }) => [table, n, before, after, identical]), [
    ['languages', 3, 1, 3, true],
    ['translations', 3, 2, 3, true],
    ['services', 2, 1, 2, true],
    ['service_translations', 2, 0, 2, true],
    ['pages', 2, 0, 2, true],
    ['page_translations', 2, 0, 2, true],
    ['faqs', 2, 0, 2, true],
    ['faq_translations', 2, 0, 2, true],
    ['contact_messages', 2, 0, 2, true]
  ])
  assert.match(formatReport(dry.report), /^tabella +sorgente +prima +dopo +esito\nlanguages +3 +1 +3 +identica\n/)
  assert.deepEqual(await fingerprint(platform.superuser, 'public'), targetBefore, 'la prova non lascia nulla')

  const applied = await copySite({ source, target, sourceSchema: SOURCE_SCHEMA, commit: true })
  assert.equal(applied.committed, true)
  const copied = await fingerprint(platform.superuser, 'public')
  assert.deepEqual(copied, sourceBefore)
  assert.equal(copied.translations.sequence.last_value, '100')
  assert.deepEqual(await fingerprint(sourceSuperuser, SOURCE_SCHEMA), sourceBefore, 'sorgente intatta')

  // La destinazione resta del sito: proprietario, RLS; il backend (cs_site) continua dalle sequenze copiate.
  const { rows: tables } = await platform.superuser.query(
    "select relname::text as name from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and (relowner <> 'cs_site'::regrole or not relrowsecurity)"
  )
  assert.deepEqual(tables, [])
  await cs.query('begin')
  const { rows: [next] } = await cs.query("insert into translations (string_key, lang_code, value) values ('nuova', 'en', 'x') returning id")
  await cs.query('rollback')
  assert.equal(next.id, '101')
  const { rows: [array] } = await cs.query('select features from service_translations where id = 1')
  assert.deepEqual(array.features, ['Comande', 'Menu "digitale"', 'a,b', null])

  const again = await copySite({ source, target, sourceSchema: SOURCE_SCHEMA, commit: true })
  assert.deepEqual(again.report.map((e) => [e.before, e.after, e.identical]), again.report.map((e) => [e.source, e.source, true]))
  assert.deepEqual(await fingerprint(platform.superuser, 'public'), sourceBefore)
})

test('--no-data contact_messages: tabella vuota e identita\' ripartita, il resto copiato', async (t) => {
  const { platform, cs, source, sourceSuperuser, target } = await siteStack(t)
  await cs.query("insert into contact_messages (name, reply_to_email, body) values ('staging', 's@example.com', 'x')")
  const sourceBefore = await fingerprint(sourceSuperuser, SOURCE_SCHEMA)

  const { report } = await copySite({ source, target, sourceSchema: SOURCE_SCHEMA, commit: true, noData: ['contact_messages'] })
  assert.deepEqual(report.at(-1), { table: 'contact_messages', source: 2, before: 1, after: 0, emptied: true })
  assert.match(formatReport(report), /contact_messages +2 +1 +0 +vuota \(--no-data\)$/)
  const copied = await fingerprint(platform.superuser, 'public')
  assert.deepEqual({ ...copied, contact_messages: undefined }, { ...sourceBefore, contact_messages: undefined })
  assert.equal(copied.contact_messages.n, 0)
  assert.deepEqual(copied.contact_messages.sequence, { last_value: '1', is_called: false })

  await assert.rejects(
    copySite({ source, target, sourceSchema: SOURCE_SCHEMA, noData: ['persons'] }),
    { code: 'SITE_COPY_STOPPED', message: "--no-data: tabelle non del sito: persons. Nulla e' stato scritto." }
  )
})

test('stop prima di scrivere: colonne diverse, migrazioni del sito mancanti, 0009 assente, tabella mancante', async (t) => {
  const { server, platform, cs, source, target } = await siteStack(t)
  const before = await fingerprint(platform.superuser, 'public')
  const stopped = (message) => ({ code: 'SITE_COPY_STOPPED', message })

  await cs.query('alter table faqs add column extra text')
  await assert.rejects(copySite({ source, target, sourceSchema: SOURCE_SCHEMA, commit: true }),
    stopped("Colonne di faqs diverse tra sorgente e destinazione. Nulla e' stato scritto."))
  await cs.query('alter table faqs drop column extra')

  await cs.query("delete from schema_migrations where name in ('010_sito.sql', '012_sito.sql')")
  await assert.rejects(copySite({ source, target, sourceSchema: SOURCE_SCHEMA, commit: true }),
    stopped("Destinazione: migrazioni del sito mancanti (010_sito.sql, 012_sito.sql). Applica prima `npm run migrate` di ComfortService come cs_site. Nulla e' stato scritto."))
  await cs.query("insert into schema_migrations (name) values ('010_sito.sql'), ('012_sito.sql')")

  await assert.rejects(copySite({ source, target, sourceSchema: 'altro_schema', commit: true }),
    stopped("Sorgente: la tabella altro_schema.languages non esiste. Nulla e' stato scritto."))

  const empty = await (await server.createDatabase()).connectAdmin()
  await assert.rejects(copySite({ source, target: empty, sourceSchema: SOURCE_SCHEMA, commit: true }),
    stopped("Destinazione: 0009_site_public_schema.sql non applicata (public non e' ancora di cs_site). Nulla e' stato scritto."))

  assert.deepEqual(await fingerprint(platform.superuser, 'public'), before)
})

test('errore o differenza durante la copia: tutto annullato', async (t) => {
  const { platform, cs, source, target } = await siteStack(t)
  const before = await fingerprint(platform.superuser, 'public')

  // Un vincolo in piu' nella destinazione che una riga della sorgente viola: l'insert fallisce a meta'.
  await cs.query("alter table services add constraint niente_rooms check (slug <> 'rooms')")
  await assert.rejects(copySite({ source, target, sourceSchema: SOURCE_SCHEMA, commit: true }), /niente_rooms/)
  assert.deepEqual(await fingerprint(platform.superuser, 'public'), before)
  await cs.query('alter table services drop constraint niente_rooms')

  // Un trigger che altera i valori: la copia arriva in fondo, il confronto lo vede e annulla.
  await cs.query(`
    create function maiuscole() returns trigger language plpgsql as $$ begin new.value = upper(new.value); return new; end $$;
    create trigger maiuscole before insert on translations for each row execute function maiuscole();`)
  await assert.rejects(copySite({ source, target, sourceSchema: SOURCE_SCHEMA, commit: true }), (err) => {
    assert.equal(err.message, "Dopo la copia translations non corrisponde alla sorgente. Nulla e' stato scritto.")
    assert.match(formatReport(err.report), /translations +3 +2 +3 +DIVERSA/)
    return true
  })
  assert.deepEqual(await fingerprint(platform.superuser, 'public'), before)
})
