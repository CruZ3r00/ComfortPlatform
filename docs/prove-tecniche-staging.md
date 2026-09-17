# Prove tecniche sul database di staging

**Data:** 2026-09-16, 20:50-21:04 UTC
**Ambiente:** staging (progetto Supabase `<ref>`, pooler `aws-0-eu-west-3.pooler.supabase.com`)
**Riferimenti:** ADR-0014 §14.2 (schema predefinito per utente), §14.7 (bus, `session_user`, `LISTEN`, prova tecnica); piano 0007 Fase 1
**Script:** `db/probes/` (`npm run db:probe`), da ripetere prima della replica in produzione

Negli output il ref del progetto è sostituito da `<ref>`; nessuna password compare negli output.

## 1. Come si ripetono

```bash
npm run db:probe -- all --env <ambiente>          # punti 1-4, circa 1 minuto
npm run db:probe -- notify-idle --env <ambiente>  # punto 4.6, circa 7 minuti
npm run db:probe -- leftovers --env <ambiente>    # verifica finale: nessun residuo
npm run db:probe -- cleanup --env <ambiente>      # solo se un'esecuzione si interrompe
```

- **Configurazione:** stesse variabili del runner (`PLATFORM_<AMBIENTE>_DATABASE_*`). L'utente è l'amministratore sul pooler di sessione 5432; pooler di transazione e connessione diretta sono ricavati da host e utente. TLS con verifica del certificato (CA pubblico «Supabase Root 2021 CA»).
- **Oggetti di prova:** nomi fissi, creati in una transazione con `lock_timeout` di 5 s:
  - ruoli `probe_user_a`, `probe_user_b`;
  - schemi `probe_a`, `probe_b`;
  - tabelle `probe_marker` e `probe_a.probe_queue`;
  - funzioni `probe_a.probe_whoami()` e `probe_a.probe_publish(text)`;
  - canale `probe_bus_a`.
- **Password dei ruoli:** casuali e tenute solo in memoria. Al server arriva il verificatore SCRAM.
- **Controlli preliminari:** le prove si fermano se esiste già qualunque oggetto `probe_%`, se l'amministratore non ha `pg_signal_backend` o se restano meno di 20 connessioni libere.
- **Pulizia:** gira sempre, anche dopo un errore. Elimina solo i nomi fissi, gli schemi senza `CASCADE`. Poi la verifica dei residui cerca qualunque `probe_%` e le sessioni di ruoli eliminati.
- **Test locali:** `tests/probes.test.js`, su Postgres temporaneo. Verificano il funzionamento degli script, non il comportamento di Supavisor.

## 2. Esiti

| Punto | Prova | Esito | Sintesi |
|---|---|---|---|
| 1 | Versione ed estensioni | **OK, con azione** | Postgres **17.6**, non 16: harness e `CLAUDE.md` allineati a 17. `pg_cron` 1.6.4 disponibile e precaricata, non installata. `pgcrypto` 1.3 installata in `extensions` |
| 2 | Schema predefinito per utente sul pooler 6543 | **OK** | 570/570 osservazioni corrette. Il `SET search_path` di sessione di un utente non raggiunge mai un altro utente, ma raggiunge gli altri client dello stesso utente (40/90) |
| 3 | `session_user` in funzione SECURITY DEFINER | **OK** | 120/120 chiamate: `session_user` = utente di prova, `current_user` = proprietario. `SET ROLE` e `SET SESSION AUTHORIZATION` rifiutati |
| 4 | LISTEN/NOTIFY | **OK** | Pooler di sessione e connessione diretta (solo IPv6). Avviso consegnato al commit, mai al rollback. Interruzione vista dal client in circa 30-40 ms. Messaggio perso durante la disconnessione recuperato dalla coda. Sul 6543 `LISTEN` è accettato ma non consegna nulla |
| 4.6 | Ascoltatori inattivi per 420 s | **OK** | 4/4 ascoltatori (sessione e diretta, con e senza keepalive TCP) ricevono l'avviso dopo 420 s fermi, senza chiusure |
| 5 | Realtime Supabase | **Non necessaria** | Punto 4 riuscito su entrambe le connessioni |
| Pulizia | Oggetti di prova eliminati | **OK, dopo una correzione** | Prima esecuzione: pulizia incompleta, residui per circa 2 minuti (§4). Dopo la correzione: 0 residui in ogni esecuzione |

## 3. Dettaglio

### 3.1 Versione ed estensioni (punto 1)

- **Server:** `PostgreSQL 17.6 on x86_64-pc-linux-gnu`. La versione principale diversa da quella prevista ha tre conseguenze:
  - `DEFAULT_VERSION` di `tests/helpers/postgres.js` e il fallback di `tests/postgres-harness.test.js` passano a 17;
  - `CLAUDE.md` indica `postgresql-17`;
  - i test richiedono il pacchetto `postgresql-17` installato.
- **`pg_cron`:**
  - disponibile (1.6.4) e già in `shared_preload_libraries`;
  - `cron.database_name = postgres`;
  - compresa in `supautils.privileged_extensions`: l'amministratore `postgres` può crearla in una migrazione di piattaforma;
  - non installata: nessuna azione eseguita.
- **`pgcrypto`:** 1.3, già installata nello schema `extensions`.
- **Estensioni installate:** `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`.
- **Amministratore `postgres`:** non superutente; `createrole`, `createdb`, `bypassrls`, `replication`; membro di `pg_signal_backend`.
- **Connessioni:** `max_connections = 60`, 17-20 righe in `pg_stat_activity` durante le prove.
- **Log:** `log_statement = ddl`, `pgaudit.log = none`. Ogni `CREATE/ALTER ROLE` finisce nei log di Postgres con il testo completo.
- **Event trigger presenti:**
  - `pgrst_ddl_watch`, `pgrst_drop_watch` (ricarica della cache di PostgREST);
  - `issue_pg_cron_access`, `issue_pg_net_access`, `issue_pg_graphql_access`, `issue_graphql_placeholder` (reagiscono alla creazione o eliminazione delle rispettive estensioni).
- **Realtime:** schema `realtime` e publication `supabase_realtime` presenti.

### 3.2 Schema predefinito per utente sul pooler in modalità transazione (punto 2)

Ogni osservazione registra quattro valori:
- `current_setting('search_path')`;
- `current_schema()`;
- lo schema in cui si risolve il nome **non qualificato** `probe_marker`, con lo stesso meccanismo delle query di Strapi;
- il backend.

Nelle transazioni esplicite legge anche la riga del marker.

| Prova | Osservazioni | Esito |
|---|---|---|
| 2.1 `probe_user_a` (`search_path = probe_a, extensions`): 3 client x 40 transazioni + 40 istruzioni in autocommit, poi 20 connessioni aperte e chiuse in sequenza | 260/260 corrette, 3 backend | OK |
| 2.2 `probe_user_b` (`probe_b, extensions`) in parallelo ad A, 2 client | 180/180 corrette, 2 backend | OK |
| 2.3 `probe_user_b` esegue `SET search_path = probe_a` di sessione sul 6543 (come Strapi), poi A e B ripetono | A: 130/130 corrette. B: 40/90 osservazioni da **altri client** di B vedono `probe_a` | OK per A; informazione su B |

**Conclusione:** l'impostazione `ALTER ROLE … SET search_path` vale su ogni connessione del pooler in modalità transazione (ADR-0014 §14.2 confermato).

Un `SET` di sessione:
- non esce dal pool dell'utente che lo esegue;
- dentro quel pool **passa da un client all'altro**, perché Supavisor non ripristina lo stato di sessione dei backend.

Per `ct_app` è innocuo solo finché tutto il codice che usa quell'utente vuole lo stesso schema.

### 3.3 `session_user` in una funzione SECURITY DEFINER attraverso il pooler (punto 3)

`probe_a.probe_whoami()` è `SECURITY DEFINER` con `SET search_path = probe_a, pg_temp` e proprietario `postgres`. Restituisce `session_user` e `current_user`.

| Endpoint | Chiamate corrette | Backend |
|---|---|---|
| pooler transazione 6543 (2 client, metà in transazione esplicita) | 100/100 | 2 |
| pooler sessione 5432 | 10/10 | 1 |
| connessione diretta | 10/10 | 1 |

In tutte le chiamate:
- dentro la funzione, `session_user = probe_user_a` e `current_user = postgres`;
- fuori dalla funzione, entrambi valgono `probe_user_a`.

Controlli (3.2):

| Tentativo | Risultato |
|---|---|
| `probe_user_b` chiama la funzione | `42501 permission denied for schema probe_a` |
| `probe_user_a`: `SET LOCAL ROLE postgres` | `42501 permission denied to set role` |
| `probe_user_a`: `SET LOCAL SESSION AUTHORIZATION postgres` | `42501 permission denied to set session authorization` |

**Conclusione:** attraverso Supavisor ogni connessione server si apre con l'utente del client, senza `SET ROLE`. `session_user` identifica in modo affidabile l'app chiamante, e un'app non può assumere l'identità di un'altra.

### 3.4 LISTEN/NOTIFY (punto 4)

**Ascoltatori** (utente `probe_user_a`):
- **L1:** pooler di sessione 5432.
- **L2:** connessione diretta `db.<ref>.supabase.co`. Il DNS restituisce **solo IPv6** (IPv4 x0, IPv6 x1): raggiungibile da questa macchina, che ha IPv6 globale.

**Mittente:** `probe_user_a` sul pooler di transazione 6543.

| Prova | L1 pooler sessione | L2 diretta |
|---|---|---|
| 4.2 `BEGIN; pg_notify; attesa 3 s; COMMIT` | nulla prima del commit; ricevuto 26-28 ms dopo l'invio del COMMIT | nulla prima del commit; ricevuto 34-35 ms dopo |
| 4.3 `pg_notify` poi `ROLLBACK`, poi avviso sentinella | sentinella ricevuta, avviso annullato mai ricevuto | uguale |
| 4.4 `probe_a.probe_publish` (SECURITY DEFINER: riga + `pg_notify`, come `bus.publish`), un commit e un rollback | commit avvisato con riga in coda; rollback né avvisato né in coda | uguale |
| 4.5a chiusura dal client, pubblicazione mentre è giù, riconnessione, `LISTEN`, svuotamento della coda | messaggio recuperato dalla coda; avviso perso; avviso successivo ricevuto | uguale |
| 4.5b `pg_terminate_backend` sul backend dell'ascoltatore, poi come 4.5a | client avvisato in 28-37 ms (`error 57P01`, poi `end`); recupero come 4.5a | client avvisato in 33-36 ms (`error 57P01`); recupero come 4.5a |
| 4.7 `LISTEN` sul pooler di transazione 6543 | accettato **senza errori**, avviso **mai ricevuto** | - |

**Conclusioni:**
- Il meccanismo di ADR-0014 §14.7 funziona su Supabase sia sul pooler di sessione sia sulla connessione diretta:
  - l'avviso parte solo al commit, anche da una funzione SECURITY DEFINER chiamata dal pooler di transazione;
  - una transazione annullata non sveglia nessuno.
- **Un avviso inviato mentre l'ascoltatore è scollegato si perde.** Lo svuotamento della coda a ogni (ri)connessione è indispensabile, non un'ottimizzazione.
- **L'interruzione del backend è visibile al client** anche dietro Supavisor: la connessione viene chiusa, non riassegnata in silenzio. La libreria può riconnettersi sugli eventi `error`/`end`.
- **Sul 6543 `LISTEN` fallisce in silenzio.** Una configurazione sbagliata non darebbe errori e l'app non riceverebbe mai avvisi.
- **Il pooler di sessione riusa le connessioni server:** dopo la chiusura dal client, il nuovo ascoltatore ha ricevuto lo stesso backend. L'avviso inviato nel frattempo non è arrivato comunque.

### 3.5 Ascoltatori inattivi (punto 4.6)

Quattro ascoltatori sono rimasti fermi per 420 s, più dei 350 s di timeout di inattività dei bilanciatori AWS:
- pooler di sessione, senza keepalive;
- pooler di sessione, con keepalive TCP (`keepAlive: true`, primo pacchetto dopo 60 s);
- connessione diretta, senza keepalive;
- connessione diretta, con keepalive TCP.

Poi un `pg_notify` dal pooler di transazione: **tutti e quattro lo hanno ricevuto**, nessuno ha registrato eventi di chiusura.

**Conclusione:** in 420 s nessun componente tra client e database ha chiuso una connessione inattiva, con o senza keepalive. Limiti della prova:
- periodi più lunghi (ore) non sono stati provati;
- l'esito vale per la rete da cui è stata eseguita la prova.

### 3.6 Realtime Supabase (punto 5)

Non eseguita: `LISTEN` funziona su entrambe le connessioni previste. Richiederebbe comunque credenziali API di Supabase e una modifica alla publication `supabase_realtime`, fuori dai vincoli della sessione.

## 4. Incidente: pulizia incompleta alla prima esecuzione

- **Cosa è successo** (prima esecuzione di `all`, 20:51 UTC):
  - tutte le prove dei punti 1-4 sono riuscite;
  - la pulizia ha terminato le 4 sessioni di `probe_user_a` rimaste nel pool di Supavisor e **poi** ha tolto il login al ruolo;
  - nel frattempo Supavisor ha **riaperto subito** due connessioni server del ruolo (pid nuovi, 973248 e 973249);
  - dopo 15 s restavano sessioni attive, la pulizia si è fermata (KO) e la verifica ha elencato i residui: ruoli, schemi, tabelle, funzioni e le sessioni dei due ruoli.
- **Effetto:** gli oggetti `probe_` sono rimasti su staging da circa le 20:51 alle 20:53 UTC. Nessun oggetto esistente è stato modificato o bloccato; solo letture del catalogo.
- **Correzione:**
  - in `db/probes/objects.js` l'ordine è ora `ALTER ROLE … NOLOGIN` → `pg_terminate_backend` → attesa di zero sessioni;
  - `precheck` richiede `pg_signal_backend` prima di creare qualunque oggetto;
  - `cleanup` (20:53:26 UTC) ha eliminato tutto, con 0 residui.
- **Verifica:**
  - il test `cleanup dopo un'interruzione, con il pooler che riapre le sessioni terminate` simula il comportamento di Supavisor;
  - con l'ordine sbagliato (prova «rosso») fallisce con lo stesso errore visto su staging;
  - la seconda esecuzione di `all` su staging ha chiuso con 0 KO e 0 residui.
- **Lezione:** in `lessons.md` (2026-09-16).

## 5. Effetti su staging

- **Cicli di creazione ed eliminazione:** tre (`all`, `all` dopo la correzione, `notify-idle`), più un `cleanup`. Solo oggetti `probe_`, eliminati e verificati.
- **Letture del catalogo:**
  - `pg_settings`, `pg_extension`, `pg_available_extensions`, `pg_roles`, `pg_event_trigger`;
  - esistenza di `pg_publication` e dello schema `realtime`;
  - `pg_stat_activity`: conteggi e sessioni dei soli ruoli di prova.
- **Log:** il DDL di prova è registrato (`log_statement = ddl`). I ruoli sono stati creati con il verificatore SCRAM, non con la password.
- **Event trigger:** gli event trigger di Supabase scattano sul DDL. Per oggetti di prova l'effetto previsto è al più una ricarica della cache di PostgREST; non è stato osservato direttamente.
- **Connessioni:** stima, non misurata: al massimo una decina di connessioni server in più durante le prove, su 40-43 libere. Chiuse a fine prova (la pulizia ne ha terminate 4 di `probe_user_a` e 2 di `probe_user_b` rimaste nel pool).
- **Pooler di transazione:** nessun `SET` come `postgres` sul 6543, usato da Strapi di staging.

## 6. Conseguenze per la libreria del bus e per le migrazioni di piattaforma

1. **Connessione di ascolto:**
   - usare il **pooler di sessione 5432** (`<app>.<ref>`);
   - la connessione diretta è solo IPv6 e molti host non la raggiungono;
   - la diretta resta ammessa dove IPv6 è disponibile.
2. **Rifiutare il 6543 per l'ascolto:**
   - sul 6543 `LISTEN` è accettato ma non consegna nulla;
   - la libreria deve verificare l'ascolto all'avvio e a ogni riconnessione: `LISTEN`, poi `pg_notify` sul proprio canale e attesa della ricezione con un limite di tempo;
   - se la verifica fallisce, errore e nessun avvio silenzioso.
3. **Svuotare la coda a ogni (ri)connessione:** avvio, `error`, `end`. Gli avvisi persi durante la disconnessione non tornano (confermato).
4. **Riconnessione sugli eventi del client:** la terminazione del backend è visibile in circa 30-40 ms su entrambe le connessioni.
5. **Keepalive TCP (`keepAlive: true`):** non è un requisito emerso dalle prove, perché nessuna connessione inattiva è stata chiusa in 420 s, anche senza keepalive. Attivarlo comunque costa nulla e protegge da chiusure silenziose della rete su periodi più lunghi, che non sono stati provati.
6. **`session_user`:** affidabile attraverso il pooler di transazione. La scelta di ADR-0014 §14.7 è confermata.
7. **Nessun `SET search_path` di sessione nel codice applicativo sul 6543:**
   - trapela agli altri client dello stesso utente;
   - vale solo l'impostazione del ruolo, o `SET LOCAL` dentro una transazione;
   - il `SET` di Strapi è innocuo solo perché uguale all'impostazione del ruolo.
8. **Nessuna password in chiaro nelle migrazioni di utenti:**
   - con `log_statement = ddl` il testo di `CREATE/ALTER ROLE … PASSWORD` finisce nei log;
   - usare verificatori SCRAM calcolati fuori dal database, oppure impostare le password fuori dai file SQL.
9. **Le connessioni del pooler sopravvivono all'app ferma:**
   - Supavisor tiene aperte e riapre le connessioni server di un utente;
   - le impostazioni di ruolo (`ALTER ROLE … SET`) valgono solo per le connessioni nuove: dopo una modifica vanno terminate quelle dell'utente;
   - per chiudere del tutto un utente: `NOLOGIN`, poi `pg_terminate_backend`.
10. **Postgres 17:** harness dei test e `CLAUDE.md` allineati. Restano da allineare, fuori da questa sessione:
    - ADR-0014 §14.6 e §7 («Postgres 16 effimero»);
    - la CI di ComforTables (piano 0007 §2: «crea un Postgres 16»).

## 7. Decisioni

- **ADR-0014 §14.7, paragrafo «Prova tecnica»: aggiornato.** L'esito cambia tre cose:
  1. il ripiego sul realtime Supabase non serve;
  2. la connessione di ascolto è il **pooler di sessione**: la diretta è solo IPv6;
  3. la libreria deve **verificare l'ascolto** all'avvio e a ogni riconnessione, perché sul 6543 `LISTEN` fallisce in silenzio.
- **Confermate senza modifiche:**
  - ADR-0014 §14.2: `ALTER ROLE … SET search_path` vale anche sul pooler in modalità transazione;
  - §14.7: `session_user` nelle funzioni SECURITY DEFINER, avviso al commit, svuotamento della coda alla riconnessione.
- **Allineati a Postgres 17:** `tests/helpers/postgres.js`, `tests/postgres-harness.test.js`, `CLAUDE.md`.
- **Non modificati**, fuori dal perimetro della sessione e da allineare:
  - ADR-0014 §14.6 e §7 («Postgres 16»);
  - CI di ComforTables (Postgres 16).

## 8. Output

Output integrali, nell'ordine di esecuzione tranne `server`. La prima esecuzione di `server` (20:50 UTC) coincide con 8.1, salvo le righe `pgaudit.log`, `log_statement` ed event trigger aggiunte dopo.

### 8.1 `server` (esecuzione finale, sola lettura)

Codice di uscita: 0.

```text
Prove tecniche ComfortPlatform - ambiente staging - comando server - 2026-09-16T20:57:58.673Z
  amministratore: aws-0-eu-west-3.pooler.supabase.com:5432 (utente postgres.<ref>)
  pooler sessione :5432: aws-0-eu-west-3.pooler.supabase.com:5432 (utente <ruolo>.<ref>)
  pooler transazione :6543: aws-0-eu-west-3.pooler.supabase.com:6543 (utente <ruolo>.<ref>)
  connessione diretta: db.<ref>.supabase.co:5432 (utente <ruolo>)
  TLS: attivo, verifica certificato si

[INFO] 1.1 PostgreSQL 17.6 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit
[INFO] 1.1 versione principale 17 (server_version_num 170006)
[OK] 1.2 pg_cron: disponibile (versione 1.6.4), non installata
[OK] 1.2 pgcrypto: installata, versione 1.3, schema extensions (disponibile 1.3)
[INFO] 1.2 estensioni installate: pg_stat_statements 1.11, pgcrypto 1.3, plpgsql 1.0, supabase_vault 0.3.1, uuid-ossp 1.1
[INFO] 1.3 shared_preload_libraries = "pg_stat_statements, pgaudit, plpgsql, plpgsql_check, pg_cron, pg_net, pgsodium, auto_explain, pg_tle, plan_filter, supabase_vault"
[INFO] 1.3 cron.database_name = "postgres"
[INFO] 1.3 supautils.privileged_extensions = "address_standardizer, address_standardizer_data_us, autoinc, bloom, btree_gin, btree_gist, citext, cube, dblink, dict_int, dict_xsyn, earthdistance, fuzzystrmatch, hstore, http, hypopg, index_advisor, insert_username, intarray, isn, ltree, moddatetime, orioledb, pg_buffercache, pg_cron, pg_graphql, pg_hashids, pg_jsonschema, pg_net, pg_prewarm, pg_repack, pg_stat_monitor, pg_stat_statements, pg_tle, pg_trgm, pg_walinspect, pgaudit, pgcrypto, pgjwt, pgroonga, pgroonga_database, pgrouting, pgrowlocks, pgsodium, pgstattuple, pgtap, plcoffee, pljava, plls, plpgsql_check, plv8, postgis, postgis_raster, postgis_sfcgal, postgis_tiger_geocoder, postgis_topology, postgres_fdw, refint, rum, seg, sslinfo, supabase_vault, supautils, tablefunc, tcn, timescaledb, tsm_system_rows, tsm_system_time, unaccent, uuid-ossp, vector, wrappers"
[INFO] 1.3 max_connections = "60"
[INFO] 1.3 password_encryption = "scram-sha-256"
[INFO] 1.3 pgaudit.log = "none"
[INFO] 1.3 log_statement = "ddl"
[INFO] 1.3 amministratore postgres: superuser false, createrole true, createdb true, bypassrls true, replication true, pg_signal_backend true
[INFO] 1.3 connessioni: max_connections 60, righe in pg_stat_activity 23
[INFO] 1.3 event trigger (scattano anche sul DDL delle prove): issue_graphql_placeholder (sql_drop, O), issue_pg_cron_access (ddl_command_end, O), issue_pg_graphql_access (ddl_command_end, O), issue_pg_net_access (ddl_command_end, O), pgrst_ddl_watch (ddl_command_end, O), pgrst_drop_watch (sql_drop, O)
[INFO] 1.3 realtime Supabase: schema realtime true, publication supabase_realtime true

Esito: 2 OK, 0 KO, 14 INFO
```

### 8.2 `all`, prima esecuzione (pulizia incompleta, §4)

Codice di uscita: 1.

```text
Prove tecniche ComfortPlatform - ambiente staging - comando all - 2026-09-16T20:51:28.302Z
  amministratore: aws-0-eu-west-3.pooler.supabase.com:5432 (utente postgres.<ref>)
  pooler sessione :5432: aws-0-eu-west-3.pooler.supabase.com:5432 (utente <ruolo>.<ref>)
  pooler transazione :6543: aws-0-eu-west-3.pooler.supabase.com:6543 (utente <ruolo>.<ref>)
  connessione diretta: db.<ref>.supabase.co:5432 (utente <ruolo>)
  TLS: attivo, verifica certificato si

[INFO] 1.1 PostgreSQL 17.6 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit
[INFO] 1.1 versione principale 17 (server_version_num 170006)
[OK] 1.2 pg_cron: disponibile (versione 1.6.4), non installata
[OK] 1.2 pgcrypto: installata, versione 1.3, schema extensions (disponibile 1.3)
[INFO] 1.2 estensioni installate: pg_stat_statements 1.11, pgcrypto 1.3, plpgsql 1.0, supabase_vault 0.3.1, uuid-ossp 1.1
[INFO] 1.3 shared_preload_libraries = "pg_stat_statements, pgaudit, plpgsql, plpgsql_check, pg_cron, pg_net, pgsodium, auto_explain, pg_tle, plan_filter, supabase_vault"
[INFO] 1.3 cron.database_name = "postgres"
[INFO] 1.3 supautils.privileged_extensions = "address_standardizer, address_standardizer_data_us, autoinc, bloom, btree_gin, btree_gist, citext, cube, dblink, dict_int, dict_xsyn, earthdistance, fuzzystrmatch, hstore, http, hypopg, index_advisor, insert_username, intarray, isn, ltree, moddatetime, orioledb, pg_buffercache, pg_cron, pg_graphql, pg_hashids, pg_jsonschema, pg_net, pg_prewarm, pg_repack, pg_stat_monitor, pg_stat_statements, pg_tle, pg_trgm, pg_walinspect, pgaudit, pgcrypto, pgjwt, pgroonga, pgroonga_database, pgrouting, pgrowlocks, pgsodium, pgstattuple, pgtap, plcoffee, pljava, plls, plpgsql_check, plv8, postgis, postgis_raster, postgis_sfcgal, postgis_tiger_geocoder, postgis_topology, postgres_fdw, refint, rum, seg, sslinfo, supabase_vault, supautils, tablefunc, tcn, timescaledb, tsm_system_rows, tsm_system_time, unaccent, uuid-ossp, vector, wrappers"
[INFO] 1.3 max_connections = "60"
[INFO] 1.3 password_encryption = "scram-sha-256"
[INFO] 1.3 amministratore postgres: superuser false, createrole true, createdb true, bypassrls true, replication true, pg_signal_backend true
[INFO] 1.3 connessioni: max_connections 60, righe in pg_stat_activity 18
[INFO] 1.3 realtime Supabase: schema realtime true, publication supabase_realtime true
[OK] P.1 nessun oggetto probe_ presente prima della prova
[OK] P.2 margine connessioni 42 (max_connections 60, in uso 18; minimo 20)
[OK] P.3 oggetti di prova creati: ruoli probe_user_a, probe_user_b; schemi probe_a, probe_b; proprietario postgres
[OK] 2.1 probe_user_a sul pooler transazione (3 client x 40 transazioni + 40 autocommit, 20 connessioni in sequenza): 260/260 osservazioni corrette (search_path "probe_a, extensions", schema corrente e nome non qualificato in probe_a, marker "a"); valori: "probe_a, extensions" x260; backend distinti: 3
[OK] 2.2 probe_user_b sul pooler transazione, in parallelo ad A (2 client): 180/180 osservazioni corrette (search_path "probe_b, extensions", schema corrente e nome non qualificato in probe_b, marker "b"); valori: "probe_b, extensions" x180; backend distinti: 2
[OK] 2.3 probe_user_a mentre probe_user_b ha eseguito SET search_path = probe_a sul pooler: 130/130 osservazioni corrette (search_path "probe_a, extensions", schema corrente e nome non qualificato in probe_a, marker "a"); valori: "probe_a, extensions" x130; backend distinti: 3
[INFO] 2.3 probe_user_b: dopo il SET di sessione (backend 972639), 40/90 osservazioni da ALTRI client di probe_user_b vedono il valore trapelato; valori: "probe_a" x40, "probe_b, extensions" x50; backend distinti: 2
[OK] 3.1 pooler transazione :6543: 100/100 chiamate con session_user = probe_user_a e current_user = postgres dentro la funzione, probe_user_a fuori; backend distinti: 2
[OK] 3.1 pooler sessione :5432: 10/10 chiamate con session_user = probe_user_a e current_user = postgres dentro la funzione, probe_user_a fuori; backend distinti: 1
[OK] 3.1 connessione diretta: 10/10 chiamate con session_user = probe_user_a e current_user = postgres dentro la funzione, probe_user_a fuori; backend distinti: 1
[OK] 3.2 probe_user_b chiama probe_a.probe_whoami(): rifiutato (42501 permission denied for schema probe_a)
[OK] 3.2 probe_user_a: SET ROLE postgres: rifiutato (42501 permission denied to set role "postgres")
[OK] 3.2 probe_user_a: SET SESSION AUTHORIZATION postgres: rifiutato (42501 permission denied to set session authorization "postgres")
[OK] 4.1 pooler sessione :5432: LISTEN probe_bus_a attivo (backend 973239)
[INFO] 4.1 connessione diretta: DNS db.<ref>.supabase.co: IPv4 x0, IPv6 x1
[OK] 4.1 connessione diretta: LISTEN probe_bus_a attivo (backend 973243)
[OK] 4.2 pooler sessione :5432: nulla nei 3000 ms tra pg_notify e commit; ricevuto 28 ms dopo l'invio del COMMIT
[OK] 4.2 connessione diretta: nulla nei 3000 ms tra pg_notify e commit; ricevuto 35 ms dopo l'invio del COMMIT
[OK] 4.3 pooler sessione :5432: sentinella ricevuta; avviso della transazione annullata mai ricevuto
[OK] 4.3 connessione diretta: sentinella ricevuta; avviso della transazione annullata mai ricevuto
[OK] 4.4 pooler sessione :5432: probe_publish confermata avvisata, annullata mai avvisata; righe in coda: publish-commit (attesa solo publish-commit)
[OK] 4.4 connessione diretta: probe_publish confermata avvisata, annullata mai avvisata; righe in coda: publish-commit (attesa solo publish-commit)
[OK] 4.5a pooler sessione :5432: dopo la chiusura dal client riconnesso (backend 973239); lo svuotamento della coda ha recuperato il messaggio pubblicato nel frattempo; avviso successivo ricevuto
[INFO] 4.5a pooler sessione :5432: l'avviso pubblicato durante l'interruzione e' andato perso (NOTIFY non e' persistente: il recupero passa dallo svuotamento della coda alla riconnessione)
[OK] 4.5b pooler sessione :5432: backend 973239 terminato, interruzione vista dal client (error 57P01 a +37 ms, error Connection terminated unexpectedly a +40 ms, end a +41 ms)
[OK] 4.5b pooler sessione :5432: dopo la terminazione del backend riconnesso (backend 973245); lo svuotamento della coda ha recuperato il messaggio pubblicato nel frattempo; avviso successivo ricevuto
[INFO] 4.5b pooler sessione :5432: l'avviso pubblicato durante l'interruzione e' andato perso (NOTIFY non e' persistente: il recupero passa dallo svuotamento della coda alla riconnessione)
[OK] 4.5a connessione diretta: dopo la chiusura dal client riconnesso (backend 973246); lo svuotamento della coda ha recuperato il messaggio pubblicato nel frattempo; avviso successivo ricevuto
[INFO] 4.5a connessione diretta: l'avviso pubblicato durante l'interruzione e' andato perso (NOTIFY non e' persistente: il recupero passa dallo svuotamento della coda alla riconnessione)
[OK] 4.5b connessione diretta: backend 973246 terminato, interruzione vista dal client (error 57P01 a +33 ms, error Connection terminated unexpectedly a +34 ms, end a +34 ms)
[OK] 4.5b connessione diretta: dopo la terminazione del backend riconnesso (backend 973247); lo svuotamento della coda ha recuperato il messaggio pubblicato nel frattempo; avviso successivo ricevuto
[INFO] 4.5b connessione diretta: l'avviso pubblicato durante l'interruzione e' andato perso (NOTIFY non e' persistente: il recupero passa dallo svuotamento della coda alla riconnessione)
[INFO] 4.7 pooler transazione :6543: LISTEN accettato senza errori; avviso NON ricevuto. Il backend cambia a ogni transazione: l'ascolto non e' affidabile e la libreria deve rifiutare questa porta
[INFO] C probe_user_a: 4 sessioni residue terminate dall'amministratore
[KO] C pulizia non completata: probe_user_a: 2 sessioni ancora attive dopo 15000 ms. Rilanciare il comando cleanup
[KO] R residui: funzione probe_a.probe_publish; funzione probe_a.probe_whoami; impostazione di ruolo probe_user_a; impostazione di ruolo probe_user_b; relazione probe_a.probe_marker; relazione probe_a.probe_queue; relazione probe_a.probe_queue_id_seq; relazione probe_a.probe_queue_pkey; relazione probe_b.probe_marker; ruolo probe_user_a; ruolo probe_user_b; schema probe_a; schema probe_b; sessione probe_user_a pid 973248; sessione probe_user_a pid 973249; sessione probe_user_b pid 972636; sessione probe_user_b pid 972639; tipo probe_a.probe_marker; tipo probe_a.probe_queue; tipo probe_b.probe_marker

Esito: 28 OK, 2 KO, 19 INFO
```

### 8.3 `cleanup` dopo la correzione

Codice di uscita: 0.

```text
Prove tecniche ComfortPlatform - ambiente staging - comando cleanup - 2026-09-16T20:53:26.274Z
  amministratore: aws-0-eu-west-3.pooler.supabase.com:5432 (utente postgres.<ref>)
  pooler sessione :5432: aws-0-eu-west-3.pooler.supabase.com:5432 (utente <ruolo>.<ref>)
  pooler transazione :6543: aws-0-eu-west-3.pooler.supabase.com:6543 (utente <ruolo>.<ref>)
  connessione diretta: db.<ref>.supabase.co:5432 (utente <ruolo>)
  TLS: attivo, verifica certificato si

[INFO] C probe_user_a: login disattivato, 2 sessioni residue terminate
[INFO] C probe_user_b: login disattivato, 2 sessioni residue terminate
[OK] C pulizia eseguita (ruoli trovati: probe_user_a, probe_user_b)
[OK] R nessun residuo: 0 ruoli, schemi, relazioni, funzioni, tipi, impostazioni e sessioni probe_; 0 sessioni di ruoli eliminati

Esito: 2 OK, 0 KO, 2 INFO
```

### 8.4 `all`, seconda esecuzione con la correzione

Codice di uscita: 0.

```text
Prove tecniche ComfortPlatform - ambiente staging - comando all - 2026-09-16T20:54:45.813Z
  amministratore: aws-0-eu-west-3.pooler.supabase.com:5432 (utente postgres.<ref>)
  pooler sessione :5432: aws-0-eu-west-3.pooler.supabase.com:5432 (utente <ruolo>.<ref>)
  pooler transazione :6543: aws-0-eu-west-3.pooler.supabase.com:6543 (utente <ruolo>.<ref>)
  connessione diretta: db.<ref>.supabase.co:5432 (utente <ruolo>)
  TLS: attivo, verifica certificato si

[INFO] 1.1 PostgreSQL 17.6 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit
[INFO] 1.1 versione principale 17 (server_version_num 170006)
[OK] 1.2 pg_cron: disponibile (versione 1.6.4), non installata
[OK] 1.2 pgcrypto: installata, versione 1.3, schema extensions (disponibile 1.3)
[INFO] 1.2 estensioni installate: pg_stat_statements 1.11, pgcrypto 1.3, plpgsql 1.0, supabase_vault 0.3.1, uuid-ossp 1.1
[INFO] 1.3 shared_preload_libraries = "pg_stat_statements, pgaudit, plpgsql, plpgsql_check, pg_cron, pg_net, pgsodium, auto_explain, pg_tle, plan_filter, supabase_vault"
[INFO] 1.3 cron.database_name = "postgres"
[INFO] 1.3 supautils.privileged_extensions = "address_standardizer, address_standardizer_data_us, autoinc, bloom, btree_gin, btree_gist, citext, cube, dblink, dict_int, dict_xsyn, earthdistance, fuzzystrmatch, hstore, http, hypopg, index_advisor, insert_username, intarray, isn, ltree, moddatetime, orioledb, pg_buffercache, pg_cron, pg_graphql, pg_hashids, pg_jsonschema, pg_net, pg_prewarm, pg_repack, pg_stat_monitor, pg_stat_statements, pg_tle, pg_trgm, pg_walinspect, pgaudit, pgcrypto, pgjwt, pgroonga, pgroonga_database, pgrouting, pgrowlocks, pgsodium, pgstattuple, pgtap, plcoffee, pljava, plls, plpgsql_check, plv8, postgis, postgis_raster, postgis_sfcgal, postgis_tiger_geocoder, postgis_topology, postgres_fdw, refint, rum, seg, sslinfo, supabase_vault, supautils, tablefunc, tcn, timescaledb, tsm_system_rows, tsm_system_time, unaccent, uuid-ossp, vector, wrappers"
[INFO] 1.3 max_connections = "60"
[INFO] 1.3 password_encryption = "scram-sha-256"
[INFO] 1.3 amministratore postgres: superuser false, createrole true, createdb true, bypassrls true, replication true, pg_signal_backend true
[INFO] 1.3 connessioni: max_connections 60, righe in pg_stat_activity 17
[INFO] 1.3 realtime Supabase: schema realtime true, publication supabase_realtime true
[OK] P.1 nessun oggetto probe_ presente prima della prova
[OK] P.2 margine connessioni 43 (max_connections 60, in uso 17; minimo 20)
[OK] P.3 oggetti di prova creati: ruoli probe_user_a, probe_user_b; schemi probe_a, probe_b; proprietario postgres
[OK] 2.1 probe_user_a sul pooler transazione (3 client x 40 transazioni + 40 autocommit, 20 connessioni in sequenza): 260/260 osservazioni corrette (search_path "probe_a, extensions", schema corrente e nome non qualificato in probe_a, marker "a"); valori: "probe_a, extensions" x260; backend distinti: 3
[OK] 2.2 probe_user_b sul pooler transazione, in parallelo ad A (2 client): 180/180 osservazioni corrette (search_path "probe_b, extensions", schema corrente e nome non qualificato in probe_b, marker "b"); valori: "probe_b, extensions" x180; backend distinti: 2
[OK] 2.3 probe_user_a mentre probe_user_b ha eseguito SET search_path = probe_a sul pooler: 130/130 osservazioni corrette (search_path "probe_a, extensions", schema corrente e nome non qualificato in probe_a, marker "a"); valori: "probe_a, extensions" x130; backend distinti: 3
[INFO] 2.3 probe_user_b: dopo il SET di sessione (backend 973291), 40/90 osservazioni da ALTRI client di probe_user_b vedono il valore trapelato; valori: "probe_a" x40, "probe_b, extensions" x50; backend distinti: 2
[OK] 3.1 pooler transazione :6543: 100/100 chiamate con session_user = probe_user_a e current_user = postgres dentro la funzione, probe_user_a fuori; backend distinti: 2
[OK] 3.1 pooler sessione :5432: 10/10 chiamate con session_user = probe_user_a e current_user = postgres dentro la funzione, probe_user_a fuori; backend distinti: 1
[OK] 3.1 connessione diretta: 10/10 chiamate con session_user = probe_user_a e current_user = postgres dentro la funzione, probe_user_a fuori; backend distinti: 1
[OK] 3.2 probe_user_b chiama probe_a.probe_whoami(): rifiutato (42501 permission denied for schema probe_a)
[OK] 3.2 probe_user_a: SET ROLE postgres: rifiutato (42501 permission denied to set role "postgres")
[OK] 3.2 probe_user_a: SET SESSION AUTHORIZATION postgres: rifiutato (42501 permission denied to set session authorization "postgres")
[OK] 4.1 pooler sessione :5432: LISTEN probe_bus_a attivo (backend 973314)
[INFO] 4.1 connessione diretta: DNS db.<ref>.supabase.co: IPv4 x0, IPv6 x1
[OK] 4.1 connessione diretta: LISTEN probe_bus_a attivo (backend 973317)
[OK] 4.2 pooler sessione :5432: nulla nei 3000 ms tra pg_notify e commit; ricevuto 26 ms dopo l'invio del COMMIT
[OK] 4.2 connessione diretta: nulla nei 3000 ms tra pg_notify e commit; ricevuto 34 ms dopo l'invio del COMMIT
[OK] 4.3 pooler sessione :5432: sentinella ricevuta; avviso della transazione annullata mai ricevuto
[OK] 4.3 connessione diretta: sentinella ricevuta; avviso della transazione annullata mai ricevuto
[OK] 4.4 pooler sessione :5432: probe_publish confermata avvisata, annullata mai avvisata; righe in coda: publish-commit (attesa solo publish-commit)
[OK] 4.4 connessione diretta: probe_publish confermata avvisata, annullata mai avvisata; righe in coda: publish-commit (attesa solo publish-commit)
[OK] 4.5a pooler sessione :5432: dopo la chiusura dal client riconnesso (backend 973314); lo svuotamento della coda ha recuperato il messaggio pubblicato nel frattempo; avviso successivo ricevuto
[INFO] 4.5a pooler sessione :5432: l'avviso pubblicato durante l'interruzione e' andato perso (NOTIFY non e' persistente: il recupero passa dallo svuotamento della coda alla riconnessione)
[OK] 4.5b pooler sessione :5432: backend 973314 terminato, interruzione vista dal client (error 57P01 a +28 ms, error Connection terminated unexpectedly a +32 ms, end a +32 ms)
[OK] 4.5b pooler sessione :5432: dopo la terminazione del backend riconnesso (backend 973318); lo svuotamento della coda ha recuperato il messaggio pubblicato nel frattempo; avviso successivo ricevuto
[INFO] 4.5b pooler sessione :5432: l'avviso pubblicato durante l'interruzione e' andato perso (NOTIFY non e' persistente: il recupero passa dallo svuotamento della coda alla riconnessione)
[OK] 4.5a connessione diretta: dopo la chiusura dal client riconnesso (backend 973319); lo svuotamento della coda ha recuperato il messaggio pubblicato nel frattempo; avviso successivo ricevuto
[INFO] 4.5a connessione diretta: l'avviso pubblicato durante l'interruzione e' andato perso (NOTIFY non e' persistente: il recupero passa dallo svuotamento della coda alla riconnessione)
[OK] 4.5b connessione diretta: backend 973319 terminato, interruzione vista dal client (error 57P01 a +36 ms)
[OK] 4.5b connessione diretta: dopo la terminazione del backend riconnesso (backend 973320); lo svuotamento della coda ha recuperato il messaggio pubblicato nel frattempo; avviso successivo ricevuto
[INFO] 4.5b connessione diretta: l'avviso pubblicato durante l'interruzione e' andato perso (NOTIFY non e' persistente: il recupero passa dallo svuotamento della coda alla riconnessione)
[INFO] 4.7 pooler transazione :6543: LISTEN accettato senza errori; avviso NON ricevuto. Il backend cambia a ogni transazione: l'ascolto non e' affidabile e la libreria deve rifiutare questa porta
[INFO] C probe_user_a: login disattivato, 4 sessioni residue terminate
[INFO] C probe_user_b: login disattivato, 2 sessioni residue terminate
[OK] C pulizia eseguita (ruoli trovati: probe_user_a, probe_user_b)
[OK] R nessun residuo: 0 ruoli, schemi, relazioni, funzioni, tipi, impostazioni e sessioni probe_; 0 sessioni di ruoli eliminati

Esito: 30 OK, 0 KO, 20 INFO
```

### 8.5 `notify-idle`

Codice di uscita: 0.

```text
Prove tecniche ComfortPlatform - ambiente staging - comando notify-idle - 2026-09-16T20:55:46.341Z
  amministratore: aws-0-eu-west-3.pooler.supabase.com:5432 (utente postgres.<ref>)
  pooler sessione :5432: aws-0-eu-west-3.pooler.supabase.com:5432 (utente <ruolo>.<ref>)
  pooler transazione :6543: aws-0-eu-west-3.pooler.supabase.com:6543 (utente <ruolo>.<ref>)
  connessione diretta: db.<ref>.supabase.co:5432 (utente <ruolo>)
  TLS: attivo, verifica certificato si

[OK] P.1 nessun oggetto probe_ presente prima della prova
[OK] P.2 margine connessioni 40 (max_connections 60, in uso 20; minimo 20)
[OK] P.3 oggetti di prova creati: ruoli probe_user_a, probe_user_b; schemi probe_a, probe_b; proprietario postgres
[OK] 4.6 pooler sessione :5432: LISTEN probe_bus_a attivo (backend 973328)
[OK] 4.6 pooler sessione :5432 (keepalive TCP): LISTEN probe_bus_a attivo (backend 973329)
[INFO] 4.6 connessione diretta: DNS db.<ref>.supabase.co: IPv4 x0, IPv6 x1
[OK] 4.6 connessione diretta: LISTEN probe_bus_a attivo (backend 973331)
[OK] 4.6 connessione diretta (keepalive TCP): LISTEN probe_bus_a attivo (backend 973332)
[INFO] 4.6 4 ascoltatori inattivi per 420 s
[OK] 4.6 pooler sessione :5432: avviso ricevuto dopo 420 s di inattivita'
[OK] 4.6 pooler sessione :5432 (keepalive TCP): avviso ricevuto dopo 420 s di inattivita'
[OK] 4.6 connessione diretta: avviso ricevuto dopo 420 s di inattivita'
[OK] 4.6 connessione diretta (keepalive TCP): avviso ricevuto dopo 420 s di inattivita'
[INFO] C probe_user_a: login disattivato, 3 sessioni residue terminate
[OK] C pulizia eseguita (ruoli trovati: probe_user_a, probe_user_b)
[OK] R nessun residuo: 0 ruoli, schemi, relazioni, funzioni, tipi, impostazioni e sessioni probe_; 0 sessioni di ruoli eliminati

Esito: 13 OK, 0 KO, 3 INFO
```

