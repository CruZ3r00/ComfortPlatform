# Todo — ComfortPlatform

## Sessione 1 — Fondamenta e runner delle migrazioni (2026-09-16)

Riferimenti: ADR-0014 §14.5-14.6 (`../ComforTables/docs/adr/0014-database-unico-e-bus-di-messaggi.md`),
piano 0007 Fase 1. Fuori perimetro: bus, contratto, confronto ambienti, backup, ruoli Postgres,
qualsiasi connessione a Supabase. Nessuna operazione git.

### Decisioni

| Tema | Decisione |
|---|---|
| Node | `engines: >=20.19` (ESLint 10 richiede ^20.19; `process.loadEnvFile` da 20.12) |
| Modulo | `"type": "commonjs"`, nessuna build, `private: true` |
| Dipendenze | `pg` ^8.23; dev: `eslint` ^10, `@eslint/js` ^10, `globals` ^17 |
| Variabili | `PLATFORM_<AMBIENTE>_DATABASE_{HOST,PORT,NAME,USERNAME,PASSWORD,SSL,SSL_CA,SSL_REJECT_UNAUTHORIZED}` |
| Ambiente | `--env <nome>` obbligatorio, nome `[a-z][a-z0-9_]*`; errori con i soli nomi delle variabili |
| `.env` | root del repo, se esiste, con `process.loadEnvFile`; l'ambiente del processo ha la precedenza |
| TLS | `SSL` default `true`; senza CA e con verifica attiva → stop; downgrade solo esplicito |
| Connessione | diretta o pooler in modalita' sessione (5432), mai pooler in modalita' transazione (6543) |
| Checksum | sha256 dei byte del file; `.gitattributes` `*.sql text eol=lf` |
| Dry-run | solo piano, nessun SQL eseguito; sessione `transaction read only` |

### Checklist

- [x] 0. Prerequisito: postgresql-16 installato, senza cluster di sistema
- [x] 1. `todo.md` (questo piano) e `lessons.md` con intestazione
- [x] 2. Cartelle §14.6 + README di una riga in `bus/contract`, `bus/client`, `data-migrations`
- [x] 3. `package.json`, `.gitignore`, `.gitattributes`, `eslint.config.js`; `node --version` contro `engines`, poi `npm install`
- [x] 4. `.env.example` con segnaposto (staging e produzione) e note sulla connessione
- [x] 5. `db/runner/files.js` + `config.js` con i test unit
- [x] 6. `db/runner/runner.js` + `cli.js`; verifica precedenza variabili con `process.loadEnvFile`
- [x] 7. `db/migrations/0001_platform_registry.sql`
- [x] 8. Harness `tests/helpers/postgres.js` + test di auto-verifica
- [x] 9. `tests/runner.test.js`:
  - [x] 1 applicazione (registro, checksum, ordine per nome)
  - [x] 2 secondo giro senza effetti; 0001 eseguita due volte
  - [x] 3 dry-run e list senza scritture
  - [x] 4 migrazione modificata rifiutata, nessun file successivo applicato
  - [x] 5 rollback di un file che fallisce a meta'
  - [x] 6 file applicato cancellato; file fuori ordine
  - [x] 7 file con `COMMIT` rifiutato
  - [x] 8 due `apply` in parallelo
  - [x] 9 parita' registro: bootstrap del runner = 0001
  - [x] 10 CLI con variabili d'ambiente
- [x] 10. Prova "rosso": disattivo checksum, rollback e controllo transazione → test rossi → ripristino
- [x] 11. `CLAUDE.md`
- [x] 12. `npm test` e `npm run lint` verdi, output mostrato; sezione Review

## Review

**Esito (2026-09-16)**: `npm test` 26/26 verdi, 0 saltati (Postgres 16.14 temporaneo); `npm run lint`
senza errori; nessun processo `postgres` o cartella `comfortplatform-*` rimasti dopo i test.

**Prodotto**
- Struttura ADR-0014 §14.6, README di una riga in `bus/contract`, `bus/client`, `data-migrations`.
- Runner `db/runner`: `list` e `dry-run` in transazione di sola lettura; `apply` con lock di sessione,
  registro `platform.migrations` (nome, sha256, data), un file per transazione, stop su file
  modificato, cancellato o fuori ordine, rifiuto dei file con controllo di transazione, errore con
  file, riga (se Postgres la fornisce) e SQLSTATE.
- `0001_platform_registry.sql` idempotente, DDL identico al bootstrap del runner (test di parita').
- Harness `tests/helpers/postgres.js`: initdb/pg_ctl, scram-sha-256 con password casuale, porta
  libera su 127.0.0.1, database nuovo per test, distruzione in `stop()` e all'uscita del processo.

**Prova "rosso"** (runner.js modificato di proposito, poi ripristinato: sha256 identico)
| Modifica | Test diventati rossi |
|---|---|
| controllo checksum disattivato | migrazione modificata |
| istruzioni confermate una a una, senza controllo transazione | rollback a meta' (tabella `parziale` rimasta), errore di sintassi, COMMIT |
| controllo id di transazione disattivato | file con COMMIT |
| errore ignorato e run proseguito | rollback a meta', errore di sintassi, COMMIT |
| lock di sessione rimosso | due apply in parallelo |

**Scostamenti dal piano**
- `inspect` sostituisce `list`/`dryRun` nell'API: stessa lettura, cambia solo il formato nella CLI.
- `select 1/0` non ha posizione nel testo: il test del rollback verifica file e SQLSTATE `22012`;
  la riga e' verificata da un test separato su errore di sintassi (`42601`, riga 3).
- Aggiunto test dell'harness con password sbagliata (`28P01`).
- Precedenza delle variabili con `process.loadEnvFile` verificata su Node 24.14.1 (quella del
  processo non viene sovrascritta).

**Da sapere**
- L'istruzione di installazione data all'utente non creava `createcluster.d`: Debian ha creato e
  avviato il cluster di sistema `16/main` (porta 5432). Non interferisce con i test; si rimuove con
  `sudo pg_dropcluster --stop 16 main`. Istruzioni corrette in `CLAUDE.md`, lezione in `lessons.md`.
- Fuori perimetro e ancora da fare (piano 0007 Fase 1): confronto struttura tra ambienti, backup,
  ruoli e permessi, bus e contratto.
