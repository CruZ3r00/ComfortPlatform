# Confronto degli schemi prima e dopo la replica (ADR-0014 §14.5)

Il comando `db:schema-compare` legge con `pg_dump --schema-only` gli schemi `account`, `bus`,
`logistics`, `platform`, `public` e `tables` di due ambienti. Include proprietari, permessi,
policy, trigger e funzioni; non legge righe delle tabelle. Normalizza solo intestazioni,
token casuali di `pg_dump` e spazi finali, poi produce un diff unificato deterministico.

Richiede PostgreSQL `pg_dump` 17 e `diff` nel PATH. Usa le stesse variabili
`PLATFORM_<AMBIENTE>_DATABASE_*` del runner, con password in un file temporaneo 600
eliminato anche se il comando fallisce. Non applica migrazioni né crea oggetti nel database.

```bash
npm run db:schema-compare -- --from staging --to production
```

Il comando esce con codice 1 per ogni differenza non approvata. Il diff va letto e
confrontato con la lista concreta delle modifiche previste per la replica. Per
registrare quella lista esatta in un file privato fuori dai repository:

```bash
umask 077
npm run db:schema-compare -- --from staging --to production > /percorso/privato/differenze-attese.diff
```

Il codice 1 della prima esecuzione e' previsto se gli schemi sono diversi. **Non usare
il file come approvazione automatica**: revisionare ogni riga e conservarlo solo se
tutte le differenze sono effettivamente attese. Il gate ripetuto e':

```bash
npm run db:schema-compare -- --from staging --to production --expected-diff /percorso/privato/differenze-attese.diff
```

Esce con codice 0 solo se il diff e' identico byte per byte. Se uno dei due ambienti
cambia, si ferma. Dopo aver applicato la replica, rieseguire senza `--expected-diff`:
l'obiettivo e' un diff vuoto, oppure un nuovo elenco esplicito e riesaminato delle sole
differenze ambientali permanenti. Il confronto non sostituisce backup, dry-run delle
migrazioni, verifica dei dati o test delle app.
