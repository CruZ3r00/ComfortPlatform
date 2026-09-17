# Contratto dei messaggi del bus

Contratto v1 (ADR-0014 §14.8, catalogo del piano 0007 §3.10.4). `require('comfort-platform/contract')` espone
`topics`, `getTopic(nome)`, `validatePayload(nome, versione, payload)`, `messageFields(nome, { organizationId,
requestId, payload })`, `ContractError`.

## File

| File | Contenuto |
|---|---|
| `catalog.json` | fonte unica degli argomenti: produttore, `sensitive`, giorni di conservazione, versioni, destinatari previsti (`recipients`), iscrizioni registrate (`subscribers`), chiave di entità, campo versione, uso di `request_id` |
| `common.schema.json` | tipi condivisi: riferimenti, uuid, email, JWE compatto, unità, piatto, ingrediente, riga di alert |
| `<argomento>/v<N>.schema.json` | JSON Schema 2020-12 del payload |
| `index.js` | caricamento e validazione (Ajv) |

## Regole

- **Campi del messaggio fuori dal payload**: `organization_id`, `request_id`, `occurred_at`, `entity_ref`,
  `entity_version` sono colonne del messaggio.
- **Campi in più ammessi**: una modifica compatibile (campo opzionale in più) resta nella stessa versione. Un destinatario
  con il pacchetto precedente non deve rifiutare il messaggio.
- **Modifica incompatibile**: nuova versione `v<N+1>` (schema, `versions` nel catalogo, migrazione che la registra in
  `bus.topic_versions`); il produttore pubblica tutte le versioni in uso; ogni destinatario passa alla nuova con una
  migrazione che aggiorna la sua iscrizione (ADR-0014 §14.8).
- **Chiave di entità**: `<prefisso>:<valore>`, con il valore preso da un campo del payload o dall'organizzazione.
  Determina l'ordine di elaborazione di `bus.next()`: due argomenti con lo stesso prefisso e valore (es.
  `item_served` e `item_voided` → `item:<item_ref>`) arrivano in ordine di pubblicazione.
- **Iscrizioni**: `subscribers` contiene solo quelle già registrate da una migrazione; `recipients` quelle previste.
  Nella v1 sono iscritte solo le app già in sviluppo (ComfortLogistics). ComforTables e l'account si iscrivono con
  la migrazione della loro integrazione.

## Aggiungere o cambiare un argomento

1. Schema e voce in `catalog.json`.
2. Migrazione di piattaforma in `db/migrations/` che registra argomento, versione e iscrizioni, **identica al
   catalogo**: `tests/platform-migrations.test.js` confronta database e catalogo.
3. Esempio valido in `tests/helpers/contract-examples.js` e casi non validi in `tests/contract.test.js`.
4. Nuova versione del pacchetto: le app la adottano quando sono pronte.
