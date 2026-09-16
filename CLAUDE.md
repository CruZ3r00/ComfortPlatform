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

**Stato**: sessione 1 completata (struttura e runner delle migrazioni). Bus, contratto, confronto tra
ambienti e backup non esistono ancora.

## Struttura (ADR-0014 §14.6)

| Cartella | Contenuto |
|---|---|
| `db/migrations/` | SQL di piattaforma `NNNN_nome.sql`, applicato dall'amministratore per ogni ambiente |
| `db/runner/` | runner: `files.js` (nomi, checksum), `config.js` (variabili d'ambiente), `runner.js` (registro, piano, `inspect`, `apply`), `cli.js` |
| `bus/contract/` | JSON Schema per argomento e versione (da fare) |
| `bus/client/` | libreria del bus (da fare) |
| `data-migrations/` | script una tantum con dry-run e report (da fare) |
| `tests/` | `node:test` su Postgres 16 temporaneo (`tests/helpers/postgres.js`) |

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
- **Proprietà**: gli oggetti di piattaforma andranno a `platform_admin` con la migrazione di utenti e permessi; fino ad allora appartengono all'amministratore che esegue il runner.
- **Prima di applicare** su staging o produzione: backup completo e `dry-run` (ADR-0014 §14.5).
- `.gitattributes` fissa `eol=lf` sui `.sql`: il checksum è calcolato sui byte.

## Runner: comportamento

- `list` / `dry-run`: una transazione `read only`, nessun SQL dei file eseguito, nessun registro creato. Uscita 1 se ci sono derive.
- `apply`: `pg_advisory_lock` di sessione (due esecuzioni parallele non applicano due volte), crea `platform.migrations` se manca (DDL identico a `0001`, verificato dai test), controlla le derive (file modificato, cancellato o fuori ordine) e poi applica un file per transazione. Al primo errore annulla il file, riporta file, riga (se Postgres la indica) e SQLSTATE, e non tenta i successivi.

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
- **Test:** `npm test` (`node --test`, scopre `tests/*.test.js`). Richiede i binari server di Postgres 16.
  Il cluster di sistema non serve: i test creano il proprio su una porta libera. Per non crearlo
  (la cartella `createcluster.d` non esiste di default):
  `sudo mkdir -p /etc/postgresql-common/createcluster.d && echo 'create_main_cluster = false' | sudo tee /etc/postgresql-common/createcluster.d/no-main-cluster.conf`,
  poi `sudo apt install postgresql-16`. Se e' gia' stato creato: `sudo pg_dropcluster --stop 16 main`.
  Override: `PG_VERSION` oppure `PG_BIN_DIR`. Senza binari i test falliscono, non vengono saltati.
- **Lint:** `npm run lint` (ESLint 10 flat config, `eslint.config.js`).
- **Migrazioni:** `npm run db:list -- --env staging`, `npm run db:dry-run -- --env staging`, `npm run db:apply -- --env staging`.
