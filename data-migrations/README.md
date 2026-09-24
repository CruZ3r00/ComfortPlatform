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

## `logistics-copy/` — il magazzino di ComforTables in ComfortLogistics

Copia il vecchio magazzino di ComforTables (`tables`) nelle tabelle di ComfortLogistics (`logistics`), nello stesso
database (ADR-0015 §15.13). Una sola transazione dell'amministratore: legge come `ct_app`, scrive come `cl_app`, e i
due schemi non si incontrano in nessuna query.

Ordine, per ambiente:

1. migrazione degli account (Fase 2): ogni titolare con dati di magazzino ha la sua riga in `tables.logistics_links`
   (titolare → organizzazione). Un titolare con dati e senza riga ferma la copia, con l'elenco;
2. migrazioni di ComfortLogistics applicate fino a 0006;
3. backup completo, poi prova e conferma:

```bash
npm run data:logistics-copy -- --env staging
npm run data:logistics-copy -- --env staging --apply
```

Che cosa diventa che cosa:

| ComforTables | ComfortLogistics |
|---|---|
| ingredienti | `articles` + `stock` (magazzino principale) + `ingredient_links` + `source_items` |
| unita' `kg`, `l` | `g`, `ml` (×1000 su giacenze, soglie, formati, movimenti, riordini, dosi; il costo medio si divide) |
| `suppliers`, e i fornitori nominati solo su ingredienti o movimenti | `suppliers`, legati per nome normalizzato come oggi |
| `inventory_movements` | `movements` identici, con la catena ricostruita; dove la giacenza era cambiata senza movimento, un `adjustment` con causale `migration_alignment`; i movimenti a zero si omettono |
| `restock_orders` | `purchase_orders`, con il movimento di ricezione |
| dosi e righe private dei piatti | ricetta `dish` (o `beverage` per le bevande avanzate), versione 1 valida da sempre, creata da `migration` |
| dose dell'aggiunta | ricetta `addon` |
| bevanda semplice con lo stesso nome di un ingrediente | ricetta `beverage`: il formato se c'e', altrimenti 1 pz (come il carico fatto di oggi) |
| alert non archiviati | `alerts`, uno per articolo e tipo |
| elementi del menu | `source_items` (`linked` se hanno una ricetta) |
| — | `links` attivo, e `tables.logistics_links` attivo |

**Anomalie** (ferma tutto, nulla scritto, elenco completo): due ingredienti con lo stesso nome normalizzato, unita'
sconosciuta, dose in un'unita' di un'altra grandezza (`unit_override`), movimento con il segno sbagliato o incoerente,
riordino ricevuto senza movimento, un'organizzazione che ha gia' articoli creati a mano in ComfortLogistics.

**Verifiche** dopo la scrittura, nella stessa transazione: giacenza e costo medio articolo per articolo, catena dei
movimenti fino alla giacenza, ricette riga per riga (articolo, dose, unita'), conteggi di fornitori, riordini, alert,
ricette e catalogo. Una differenza annulla tutto.

Rieseguibile: un'organizzazione gia' copiata (movimenti con l'autore della migrazione,
`00000000-0000-4000-8000-000000000015`) si salta. Dopo `--apply`, ComfortLogistics ricalcola disponibilita' e alert
alla prima operazione di magazzino dell'organizzazione.
