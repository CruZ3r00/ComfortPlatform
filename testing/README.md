# Kit di test per le app (`comfort-platform/testing`)

Postgres 17 temporaneo con **pg_cron** e un amministratore **non superutente**, come Supabase, più le migrazioni di
piattaforma e gli utenti applicativi con login. Serve ai test delle app (ComfortLogistics, ComforTables, account)
per provare le proprie migration, i permessi e il bus con gli utenti reali.

## Requisiti

Binari server di Postgres 17 e pg_cron sulla macchina (Debian/Ubuntu, repository PGDG). Il cluster di sistema non
serve: il kit ne crea uno proprio su una porta libera.

```bash
sudo mkdir -p /etc/postgresql-common/createcluster.d
echo 'create_main_cluster = false' | sudo tee /etc/postgresql-common/createcluster.d/no-main-cluster.conf
sudo apt install postgresql-17 postgresql-17-cron
```

Override: `PG_VERSION` oppure `PG_BIN_DIR`. Senza binari i test falliscono, non vengono saltati.

## Uso

```js
const { startPostgres, installPlatform } = require('comfort-platform/testing')

let server
let platform
before(async () => {
  server = await startPostgres()             // cluster nuovo, distrutto da stop()
  platform = await installPlatform(server)   // migrazioni come db_admin + login di ct_app, cs_site, cs_account, cl_app
})
after(() => server.stop())

test('migration di ComfortLogistics come cl_app', async () => {
  const cl = await platform.connectAs('cl_app')   // search_path = logistics, extensions
  await cl.query('create table articles (…)')
})
```

`installPlatform` restituisce `{ db, admin, superuser, applied, passwords, configFor(ruolo), connectAs(ruolo) }`:
- **`configFor(ruolo)`**: la configurazione `pg` per `pg.Pool`, e anche per la connessione di ascolto del consumatore;
- **`admin`**: il client dell'amministratore, per le fixture di piattaforma (es. iscrizioni non ancora nel contratto);
- **`superuser`**: solo per ispezionare il catalogo.

Il database è `postgres`, quello di pg_cron (`server.cronDatabase`). Il cluster è unico per file di test, e i ruoli
valgono per tutto il cluster: per isolare i test fra loro, svuotare le proprie tabelle.

Schemi dopo `installPlatform` (da 0.4.0): `tables` di `ct_app` (vuoto: su un database nuovo le tabelle le creano le
migration di ComforTables) e `public` di `cs_site`, senza permessi a PUBLIC; `cs_site` non ha CREATE sul database, come
su Supabase. Le migration del sito si applicano come `cs_site` con schema `public`.

## CI delle app

- **Postgres:** servono Postgres 17 con pg_cron in `shared_preload_libraries`, e un amministratore con i permessi di
  `postgres` su Supabase. L'immagine `postgres:17` non ha pg_cron. Le alternative: il kit su un runner con i
  pacchetti sopra, oppure un'immagine con pg_cron.
- **Migrazioni di piattaforma su un database esterno:** ad esempio

  ```bash
  PLATFORM_CI_DATABASE_HOST=… PLATFORM_CI_DATABASE_USERNAME=… PLATFORM_CI_DATABASE_PASSWORD=… \
  PLATFORM_CI_DATABASE_SSL=false npx comfort-platform apply --env ci
  ```

- **Login degli utenti:** `npx comfort-platform role-login cl_app --env ci`, con la password da stdin.
