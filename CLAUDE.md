## WORKFLOW ORCHESTRATION
  ### 1. Plan Mode Default
  - Enter in plan mode for ANY non-trivial task (3+ steps or architectural decisions)
  - If something goes sideways, STOP and replan immediately
  - Use plan mode for verification steps, not just building
  - Write detailed specs upfront to reduce ambiguity
  ### 2. Subagent strategy
  - Use subagent (starting with PMO) to keep the main context clean
  - Offload research, exploration and parallel analysis to subagents
  - Decide by yourself when it is needed more compute and start team agent
  - One task per sub-agent, also if you need to start multiple backend agent (or others) for focused execution
  ### 3. Self-improvement loop
  - After ANY correction from the user: update lessons.md with the pattern
  - After ANY bug or error in your own code: update lessons.md with the pattern
  - Write rules for yourself that prevent the same mistake
  - ruthlessly iterate on these lessons until mistake rate drops
  - Review lessons.md on start for relevant project
  ### 4. Verification before done
  - Never mark a task complete without proving it works
  - Diff behaviour between main and your changes when relevant
  - Ask yourself: "Would a staff engineer approve this?"
  - Run tests, check logs, demonstrate correctness
  ### 5. Demand Elegance
  - For non-trivial changes: pause and ask: "is there a more elegant way?"
  - If a fix feels hacky: "Knowing everything i know now, implement the elegant solution"
  - Skip this for simple, obvious fixes -- DO NOT over-engineer
  - Challenge your own work before presenting it
  ### 6. Autonomous bug fixing
  - When given a bug report: just fix it. Don't ask for hand-holding
  - Point at logs, errors, failing tests -- then resolve them
  - Zero context switching required from the user
  - Go fix failing CI tests without told how
  ### 7. Scope Discipline (HARD RULE)
  - Every time the user asks for a modification, modify ONLY AND EXCLUSIVELY the code that the request concerns
  - Do NOT touch, refactor, reformat or "improve" unrelated code, files, configs or styles
  - No drive-by edits, no opportunistic cleanups outside the requested scope
  - If a fix genuinely requires changing something outside the obvious target, STOP and ask first
  - Investigation/analysis tasks are exempt from "modify": when asked to investigate or plan, do not edit code at all
## TASK MANAGEMENT
  1. *CONTEXT FRIENDLY*: Read the context from code-review-graph when possible or from CLAUDE.md in the projects
  2. *PLAN FIRST*: Write plan to todo.md with checkable items
  3. *VERIFY PLAN*: Check in before starting implementation
  4. *TRACK PROGRESS*: Mark items complete as you go
  5. *EXPLAIN CHANGES*: High-level summary at each step
  6. *DOCUMENT RESULTS*: Add review section to todo.md
  7. *CAPTURE LESSONS*: Update lessons after corrections
## CORE PRINCIPLES
  - *Simplicity First*: Make every change as simple as possible. Impact minimal code.
  - *No laziness*: Find root causes. No temporary fixes. Senior developer standards
  - *Minimal Impact*: Only touch what's necessary. No side effects with new bugs

## Panoramica di ComfortPlatform

Codice di piattaforma condiviso da ComfortService (sito e account), ComforTables e ComfortLogistics, che
condividono **un database per ambiente** con uno schema per applicazione. **Non è un servizio**: nessun
processo, server o dominio. Contiene:
- le **migrazioni di piattaforma** (schemi, utenti, permessi, RLS, schema `bus`, job `pg_cron`) e il loro runner;
- il **bus di messaggi** dentro Postgres: libreria CommonJS importata dalle app e contratto dei messaggi;
- gli **script di migrazione dati** una tantum.

Fonti normative (in ComforTables): `../ComforTables/docs/adr/0014-database-unico-e-bus-di-messaggi.md`
(database, bus, questo repository), `0013-account-comfortservice-accesso-unico.md`,
`0015-comfortlogistics-estrazione-magazzino.md`; piano e fasi in
`../ComforTables/docs/plans/0007-comfortservice-account-e-estrazione-magazzino.md`. Dove un dettaglio
differisce, vale l'ADR.

**Distribuzione**: le app lo installano come dipendenza git con versione fissa
(`git+ssh://…/ComfortPlatform.git#vX.Y.Z`). Una modifica al contratto è una nuova versione. Per questo:
JavaScript **CommonJS senza build** (importabile da Strapi CJS e dai backend Fastify ESM), Node >= 20.19.

**Stato** (2026-09-17):
- sessioni 1-3: runner, prove tecniche su staging, utenti applicativi, schema `bus`, job `pg_cron`;
- sessione 4: contratto v1 (21 argomenti), libreria `bus/client`, schema `logistics`, kit `testing/`;
- sessione 5 (account ComfortService, sessione A di ComfortService): `0007` schema `account` di `cs_account`, versione
  0.3.0. Le tabelle dell'account le crea ComfortService (`backend/migrations/account/`) come `cs_account`;
- sessione 6 (Fase 1 del piano 0007, dal todo.md di ComfortService): `0008` ComforTables da `public` a `tables` di
  `ct_app`, `0009` `public` a `cs_site`, rollback `db/rollback/0009-0008_…`, copia del sito
  `data-migrations/site-copy`, versione 0.4.0. Su staging non ancora applicate;
- **staging**: migrazioni 0001-0007 applicate il 2026-09-17 (backup prima in `~/backups/comfort/`); `cl_app` e
  `cs_account` con login, password in `~/.config/comfortplatform/staging/<ruolo>.password`; libreria provata sui pooler reali (dettagli
  in `todo.md`, sessione 4);
- **produzione**: nulla applicato. Prima serve il confronto tra ambienti (invariante 6), che non esiste ancora,
  come il backup nel runner e gli script di migrazione dati.

## Struttura (ADR-0014 §14.6)

| Cartella | Contenuto |
|---|---|
| `db/migrations/` | SQL di piattaforma `NNNN_nome.sql`, applicato dall'amministratore per ogni ambiente: `0001` registro, `0002` utenti, `0003` bus, `0004` job `pg_cron`, `0005` contratto v1, `0006` schema `logistics`, `0007` schema `account`, `0008` ComforTables in `tables`, `0009` `public` al sito |
| `db/rollback/` | script inversi, uno per gruppo di migrazioni (`0009-0008_…`), e `apply.js` che li esegue in una transazione con il lock del runner; lo script toglie dal registro le migrazioni che annulla |
| `db/runner/` | runner: `files.js` (nomi, checksum), `config.js` (variabili d'ambiente), `runner.js` (registro, piano, `inspect`, `apply`), `roles.js` (`setLogin`, `disableLogin`), `scram.js` (verificatore SCRAM), `cli.js` |
| `db/probes/` | prove tecniche su Supabase (search_path sul pooler, `session_user`, LISTEN/NOTIFY) con oggetti `probe_` creati ed eliminati a ogni esecuzione; da ripetere prima di ogni replica in un nuovo ambiente |
| `bus/contract/` | contratto v1: `catalog.json` (fonte unica degli argomenti), `common.schema.json`, `<argomento>/v<N>.schema.json`, `index.js` (validazione Ajv). Export `comfort-platform/contract`. Regole in `bus/contract/README.md` |
| `bus/client/` | libreria del bus: `publish.js`, `consumer.js` (ascolto verificato, svuotamento, retry, avvisi). Export `comfort-platform`. Uso in `bus/client/README.md` |
| `testing/` | kit di test per le app: `postgres.js` (Postgres 17 + pg_cron + amministratore non superutente), `platform.js` (`installPlatform`). Export `comfort-platform/testing`. Uso in `testing/README.md` |
| `data-migrations/` | script una tantum con prova (default) e report: `site-copy/` (righe del sito dal database di oggi a `public`, come `cs_site`). Uso in `data-migrations/README.md` |
| `docs/` | `prove-tecniche-staging.md`: esiti delle prove tecniche |
| `tests/` | `node:test` sul kit `testing/`; `tests/helpers/platform.js`: fixture del bus e consumatore SQL di riferimento; `tests/helpers/contract-examples.js`: un payload valido per argomento; `tests/helpers/comfortables.js`: staging prima della Fase 1 (fixture della struttura di `public`, ruoli e publication di Supabase) e fotografia del catalogo; `tests/fixtures/`: strutture reali (ComforTables su staging, sito dopo le sue migrazioni 001-017) |

## Invarianti (ADR-0014 §4)

1. Ogni applicazione scrive **solo** nel proprio schema e usa il bus **solo** tramite le sue funzioni.
2. Nessuna FK, join o vista tra schemi di applicazioni diverse.
3. Un messaggio si pubblica **nella stessa transazione** dell'operazione che lo genera; mai dopo il commit.
4. Un effetto si applica **nella stessa transazione** della conferma del messaggio.
5. Nessun polling tra applicazioni. I timer ammessi: retry delle consegne fallite, pianificazioni `pg_cron` dentro il database.
6. Le migrazioni di piattaforma si applicano solo con il runner di `ComfortPlatform`, con registro, confronto degli ambienti e backup.
7. L'API REST di Supabase resta disattivata.
8. Nessun contenuto sensibile in chiaro nel bus.

## Regole delle migrazioni di piattaforma

- **Nome** `NNNN_nome.sql` (quattro cifre, minuscole, cifre e `_`), numero unico, ordine per nome. Nomi fuori formato o numeri doppi fermano il runner.
- **Idempotenti**: ogni file converge anche su oggetti già parzialmente presenti (`if not exists`, backfill separati dall'aggiunta di colonne).
- **Un file = una transazione**: il runner apre e chiude la transazione. Nei file **niente** `BEGIN`/`COMMIT`/`ROLLBACK`: il runner li rileva, non registra il file e segnala il possibile stato parziale. Istruzioni che non possono stare in una transazione (`CREATE INDEX CONCURRENTLY`, `VACUUM`) non sono ammesse.
- **Un file applicato non si modifica e non si cancella mai**: il runner confronta lo sha256 e si ferma prima di applicare altro. Una correzione è una nuova migrazione. Un file nuovo con numero inferiore all'ultimo applicato è rifiutato.
- **Proprietà**: gli oggetti di `platform` e `bus` appartengono a `platform_admin` (NOLOGIN). Uno schema nuovo nasce con `create schema … authorization platform_admin`, gli oggetti dentro `set local role platform_admin` … `reset role` (0002 da' all'amministratore l'appartenenza con SET e INHERIT). `cron.schedule` sta **fuori** da `set role`: il job gira come l'utente che lo pianifica.
- **Utenti**: creati `nologin` senza password. **Mai `PASSWORD` nei file SQL** (`log_statement = ddl` su Supabase): login e password solo con `db:role-login`.
- **Amministratore non superutente**: ogni migrazione deve funzionare con CREATEROLE senza SUPERUSER, come `postgres` su Supabase; i test la applicano cosi'. Estensioni non "trusted" (es. `pg_cron`) solo tramite supautils su Supabase.
- **Argomenti e iscrizioni del bus**: nuova migrazione (`insert … on conflict do nothing` come amministratore), **identica a `bus/contract/catalog.json`** (verificato da `tests/platform-migrations.test.js`). Le iscrizioni di un'app si registrano quando l'app si integra.
- **Schemi applicativi**: `create schema … authorization <utente>`; permessi, default privileges e commento dentro `set local role <utente>`, perche' l'amministratore ha SET ma non INHERIT sugli utenti applicativi (0006 `logistics`, 0007 `account`). Uno schema gia' presente con un altro proprietario ferma la migrazione. RLS sulle tabelle: la attivano le migration dell'app.
- **Prima di applicare** su staging o produzione: backup completo e `dry-run` (ADR-0014 §14.5).
- `.gitattributes` fissa `eol=lf` sui `.sql`: il checksum è calcolato sui byte. Per questo i corpi di funzione copiati da un
  database con fine riga CRLF (due funzioni di ComforTables su staging) diventano LF: i confronti dei test li normalizzano.
- **Spostare oggetti esistenti** in uno schema applicativo (0008): elenco esplicito degli oggetti, stati ammessi verificati
  dal catalogo prima di toccare qualcosa (tutto da spostare, tutto gia' spostato, database nuovo), conteggi dal catalogo
  e non con `to_regclass` (su uno schema senza USAGE da' errore), funzioni per oid e nome (una firma con un tipo di riga
  non si risolve dopo lo spostamento). Rollback in `db/rollback/`, provato nei test fino alla riapplicazione.

## Runner: comportamento

- `list` / `dry-run`: una transazione `read only`, nessun SQL dei file eseguito, nessun registro creato. Uscita 1 se ci sono derive.
- `apply`: `pg_advisory_lock` di sessione (due esecuzioni parallele non applicano due volte), crea `platform.migrations` se manca (DDL identico a `0001`, verificato dai test), controlla le derive (file modificato, cancellato o fuori ordine) e poi applica un file per transazione. Al primo errore annulla il file, riporta file, riga (se Postgres la indica) e SQLSTATE, e non tenta i successivi.
- `role-login <ruolo>`: solo `ct_app`, `cs_site`, `cs_account`, `cl_app` (mai `platform_admin`). Password da **stdin in pipe** (mai argomenti o variabili; da terminale si ferma), almeno 32 caratteri; un'unica `alter role … login password '<verificatore SCRAM>'`. Le sessioni gia' aperte restano valide.
- `role-disable <ruolo>`: controlla `pg_signal_backend`, poi `NOLOGIN` → terminazione delle sessioni a ogni giro → attesa di zero sessioni (30 s, poi uscita 1). L'ordine conta: il pooler riapre le connessioni finche' il login e' consentito.

## Bus (schema `bus`, migrazione 0003)

- Accesso delle app **solo** con le funzioni pubbliche: `publish`, `next`, `ack`, `fail`, `status`, `stall_notices`, `claim_stall_notice`, `complete_stall_notice`, `release_stall_notice`. SECURITY DEFINER, `search_path = bus, pg_temp`, app ricavata da `session_user` tramite `bus.apps`. Permessi: USAGE su `bus` ed EXECUTE su quelle funzioni a `ct_app`, `cs_account`, `cl_app`; nulla a `cs_site`; nessun permesso su tabelle, sequenze e funzioni interne. `bus.cleanup()` solo per l'amministratore (job).
- App `platform` = l'amministratore che applica le migrazioni: pubblica `platform.clock.daily` dal job `pg_cron`.
- **Versioni del contratto** (ADR-0014 §14.8): la versione e' un dato. `bus.topics` (produttore, `sensitive`,
  conservazione) vale per tutte le versioni; `bus.topic_versions` elenca quelle registrate; `bus.subscriptions` ha
  chiave (app, argomento) + `schema_version`, quindi un'app riceve una sola versione. `bus.publish(topic,
  schema_version, organization_id, entity_ref, entity_version, payload, occurred_at, request_id)`: versione non
  registrata → errore; nessun iscritto a quella versione → nulla salvato, restituisce `null`. `bus.next()`
  restituisce `schema_version`. Passaggio di versione: registrazione, pubblicazione in parallelo, aggiornamento
  dell'iscrizione, eliminazione della vecchia versione quando non ha piu' iscritti ne' messaggi.
- Consegna **conclusa = `done`**. `dead` blocca le successive della stessa entita', conserva il payload sensibile e trattiene il messaggio dalla pulizia. `next` ordina per `messages.seq`.
- `fail(message_id, error, permanent)`: retry 10 s, 1 min, 5 min, 30 min, poi 1 h; `dead` al decimo tentativo o con `permanent` (messaggio non valido per il contratto).
- Blocchi (§14.9): uno aperto per app; `backlog` in `publish` (pending > 5 min), `failing` dal terzo tentativo e `dead` in `fail`, chiusura in `ack`; banner dopo 15 min; avviso `pg_notify('bus_stalls', '')`. Email `opened`/`resolved` con presa in carico atomica, abbandonata dopo 5 min.
- Canali: `bus_<codice app>` e `bus_stalls`, sempre con payload vuoto.
- **Contratto v1** (`bus/contract/`, 0005): 21 argomenti, iscrizioni registrate solo per `logistics`. Payload senza i campi
  del messaggio; campi in piu' ammessi; chiave di entita' `<prefisso>:<valore>` ricavata dalla libreria.
- **Libreria**: `publish(client, argomento, { schemaVersion, organizationId, payload, occurredAt, requestId })` sul
  client della transazione, con validazione. `createConsumer({ app, pool, listen, handlers, notices })`: `pool` sul 6543,
  `listen` sul 5432. La verifica dell'ascolto invia il `pg_notify` di prova **dal pool**: dalla connessione di ascolto
  tornava sullo stesso backend e passava anche sul 6543 (visto su staging).

## Configurazione

Variabili per ambiente, con `<AMBIENTE>` = nome passato a `--env` in maiuscolo (vedi `.env.example`):
`PLATFORM_<AMBIENTE>_DATABASE_{HOST,PORT,NAME,USERNAME,PASSWORD,SSL,SSL_CA,SSL_REJECT_UNAUTHORIZED}`.
- `--env` è **obbligatorio**, senza default.
- `.env` nella root (ignorato da git) viene caricato se esiste; le variabili già presenti nel processo hanno la precedenza.
- Utente **amministratore** (su Supabase `postgres`), mai l'utente di un'app.
- Connessione **diretta** o pooler in modalità **sessione** (5432). Mai il pooler in modalità transazione (6543): perde il lock di sessione.
- TLS attivo di default: senza `SSL_CA` il runner si ferma, salvo `SSL_REJECT_UNAUTHORIZED=false` esplicito.
- Errori e output riportano solo nomi di variabili, host e utente, mai la password.

## Comandi

- **Installazione:** `npm install`
- **Test:** `npm test` (`node --test`, scopre `tests/*.test.js`). Richiede i binari server di Postgres 17 (versione di Supabase)
  e `postgresql-17-cron`. Il kit `testing/` imita Supabase: `pg_cron` precaricata (`cron.database_name = 'postgres'`,
  job in background worker), amministratore `db_admin` non superutente (CREATEROLE, CREATEDB, BYPASSRLS,
  REPLICATION, `pg_signal_backend`, `pg_read_all_settings`), estensione `pg_cron` gia' creata dal superutente
  con i permessi che Supabase da' a `postgres` (emulazione di supautils), schema `public` dell'amministratore senza
  permessi a PUBLIC (come su Supabase). Le migrazioni reali vanno nel database `postgres`.
  Il cluster di sistema non serve: i test creano il proprio su una porta libera. Per non crearlo
  (la cartella `createcluster.d` non esiste di default):
  `sudo mkdir -p /etc/postgresql-common/createcluster.d && echo 'create_main_cluster = false' | sudo tee /etc/postgresql-common/createcluster.d/no-main-cluster.conf`,
  poi `sudo apt install postgresql-17`. Se e' gia' stato creato: `sudo pg_dropcluster --stop 17 main`.
  Override: `PG_VERSION` oppure `PG_BIN_DIR`. Senza binari i test falliscono, non vengono saltati.
- **Lint:** `npm run lint` (ESLint 10 flat config, `eslint.config.js`).
- **Rollback:** `npm run db:rollback -- db/rollback/<script>.sql --env staging --check` (esegue e annulla), poi senza
  `--check`. Stesse variabili del runner; dopo, `db:apply` riapplica le migrazioni annullate.
- **Copia del sito:** `npm run data:site-copy -- --from site_live --from-schema <schema> --env staging` (prova), poi con
  `--apply`; `--no-data contact_messages` lascia vuoti i messaggi dei visitatori. Sorgente in `PLATFORM_SITE_LIVE_DATABASE_*`.
- **Migrazioni:** `npm run db:list -- --env staging`, `npm run db:dry-run -- --env staging`, `npm run db:apply -- --env staging`.
  Da un'app che ha il pacchetto come dipendenza: `npx comfort-platform <list|dry-run|apply|role-login|role-disable> … --env <ambiente>`.
- **Utenti applicativi:** `read -rs PW; printf '%s' "$PW" | npm run db:role-login -- ct_app --env staging; unset PW`
  e `npm run db:role-disable -- ct_app --env staging`. Stesse variabili del runner (amministratore).
- **Prove tecniche:** `npm run db:probe -- <server|search-path|session-user|notify|notify-idle|all|cleanup|leftovers> --env staging`.
  Stesse variabili del runner (amministratore sul pooler di sessione); pooler di transazione e diretta ricavati
  dall'host. Servono `pg_signal_backend` e almeno 20 connessioni libere. Se un'esecuzione si interrompe:
  `cleanup`, poi `leftovers`.
