Script di migrazione dati una tantum (account, sito, magazzino), con dry-run e report, eseguiti una volta per ambiente (ADR-0014 §14.5).

Regole comuni: di default ogni script **prova** (esegue tutto e annulla) e stampa il report; conferma solo con `--apply`.
Stesse variabili del runner (`PLATFORM_<AMBIENTE>_DATABASE_*`, `.env` nella root). Prima di `--apply` su staging o
produzione: backup completo.

## `site-copy/` — il sito ComfortService nel database unico

Copia le righe delle 9 tabelle del sito (`languages`, `translations`, `services`, `service_translations`, `pages`,
`page_translations`, `faqs`, `faq_translations`, `contact_messages`) dal database del sito di oggi a `public` del
database unico, come `cs_site` (ADR-0014 §14.1).

Ordine, per ambiente:

1. `db:apply` fino a `0009` (public di `cs_site`) e `db:role-login cs_site`;
2. da ComfortService, `npm run migrate` con le variabili `DATABASE_*` di `cs_site` sul database unico
   (`DATABASE_SCHEMA=public`, porta 5432): crea tabelle, trigger e RLS. La copia non crea struttura;
3. prova, poi conferma:

```bash
npm run data:site-copy -- --from site_live --from-schema <schema del sito di oggi> --env staging
npm run data:site-copy -- --from site_live --from-schema <schema del sito di oggi> --env staging --apply
```

- **Sorgente** `--from site_live` → `PLATFORM_SITE_LIVE_DATABASE_*`: l'utente con cui il backend del sito legge oggi
  il suo schema. Letta in una transazione `repeatable read read only`: nessuna scrittura possibile.
- **Destinazione** `--env`: l'amministratore (pooler di sessione), che scrive con `set local role cs_site`.
- **Controlli prima di scrivere**: `0009` applicata; nella destinazione tutte le migrazioni del sito registrate nella
  sorgente; stesse colonne e chiave primaria in ogni tabella; tabelle di `cs_site`.
- **Copia**: truncate di tutte le tabelle del sito, valori identici (id compresi), sequenze allo stato della sorgente.
- **Verifica**: righe (jsonb ordinato per chiave primaria, UTC) e sequenze identiche alla sorgente, altrimenti annulla.
- `--no-data <tabella>`: la tabella resta vuota. Su staging `--no-data contact_messages`: i messaggi dei visitatori
  sono dati personali e a staging non servono. Rieseguire la copia sovrascrive le righe della destinazione.

Report:

```
tabella                sorgente   prima    dopo  esito
languages                     5       2       5  identica
…
contact_messages              3       0       0  vuota (--no-data)
```
