# Libreria del bus (`comfort-platform`)

Libreria CommonJS, senza build, per pubblicare e ricevere messaggi del bus dentro Postgres (ADR-0014 §14.7).
Importabile da CommonJS (Strapi) e da ESM (Fastify):

```js
const { publish, createConsumer } = require('comfort-platform')
import { publish, createConsumer } from 'comfort-platform'
```

Il contratto dei messaggi è in `comfort-platform/contract` ([bus/contract/README.md](../contract/README.md)); il kit di
test per le app in `comfort-platform/testing` ([testing/README.md](../../testing/README.md)).

## Installazione

Dipendenza git con versione fissa (ADR-0014 §14.6):

```json
"dependencies": { "comfort-platform": "git+ssh://…/ComfortPlatform.git#vX.Y.Z" }
```

Node >= 20.19. Dipendenze: `pg`, `ajv`, `ajv-formats`.

## Connessioni

Ogni istanza di un'app usa due cose, con l'utente dell'app (`cl_app`, `ct_app`, `cs_account`):

| Uso | Dove (Supabase) | Utente |
|---|---|---|
| `pool`: pubblicazione, elaborazione, avvisi | pooler in modalità transazione, porta **6543** | `<utente>.<ref>` |
| `listen`: connessione di ascolto dedicata | pooler in modalità **sessione**, porta **5432** (o connessione diretta) | `<utente>.<ref>` |

Il consumatore verifica l'ascolto all'avvio e a ogni riconnessione. Se `listen` punta al 6543, `start()` fallisce con
`BusListenError`: lì `LISTEN` è accettato ma non riceve gli avvisi (verificato su staging).

Lo schema predefinito arriva dal ruolo: `cl_app` vede `logistics, extensions` senza alcun `SET search_path`. Nessun
altro `SET` di sessione sul 6543 (ADR-0014 §14.2): solo `SET LOCAL` dentro una transazione.

## Pubblicare

```js
const client = await pool.connect()
try {
  await client.query('begin')
  await client.query('update stock set …')                     // operazione di dominio
  await publish(client, 'logistics.availability.changed', {
    schemaVersion: 1,
    organizationId,                                             // uuid dell'organizzazione (account)
    payload: { dishes: […], menu_ingredients: […], reason: 'movimento', version: 12 },
    occurredAt: new Date()                                      // default: adesso
  })
  await client.query('commit')                                  // l'avviso parte solo qui
} catch (err) {
  await client.query('rollback')                                // nessun messaggio, nessun avviso
  throw err
} finally {
  client.release()
}
```

- **Sempre nella transazione dell'operazione** (invariante 3). La libreria non può verificarlo.
- Il payload viene validato contro lo JSON Schema dell'argomento e della versione: se non è valido, `ContractError` e
  nulla viene scritto.
- `entity_ref` ed `entity_version` li ricava la libreria dal catalogo (es. `item:<item_ref>`). `requestId` è
  obbligatorio per richieste e risposte (`*.snapshot_requested`, `*.preview_requested`, `*.snapshot`,
  `*.preview_ready`) e vietato altrove.
- Restituisce l'id del messaggio, oppure `null` se nessuna app è iscritta a quella versione: in quel caso non viene
  salvato nulla.
- Cambio incompatibile di un argomento (ADR-0014 §14.8): una chiamata a `publish` per ogni versione in uso, nella stessa
  transazione.

## Ricevere

```js
const consumer = createConsumer({
  app: 'logistics',
  pool,                                              // pg.Pool sul 6543
  listen: { host, port: 5432, user: `cl_app.${ref}`, password, database: 'postgres', ssl },
  handlers: {
    'tables.sales.item_served': {
      1: async (tx, message) => {
        // tx: client della transazione in cui il messaggio viene confermato. Scrivi l'effetto qui,
        // senza commit ne' rollback. Un'eccezione annulla l'effetto e programma un nuovo tentativo.
        await tx.query('insert into sales (…) values (…) on conflict (organization_id, item_ref) do nothing', […])
      }
    },
    'platform.clock.daily': { 1: async (tx, message) => { /* ricalcolo giornaliero */ } }
  },
  notices: { send: async (notice) => sendAlertEmail(notice) },   // opzionale: email dei blocchi
  onStallsChanged: async () => {},                                 // opzionale: es. banner
  logger                                                           // { info, warn, error }
})

await consumer.start()   // errore se l'ascolto non funziona
// … alla chiusura del server
await consumer.stop()
```

`message`: `{ id, topic, schemaVersion, producer, organizationId, entityRef, entityVersion, requestId, payload,
occurredAt, publishedAt, attempts }`.

Cosa fa il consumatore:
- **svuota la coda** all'avvio, a ogni riconnessione e a ogni avviso: `bus.next()` → validazione del contratto →
  handler → `bus.ack` → commit, un messaggio per transazione;
- **ordine per entità**: un messaggio non arriva finché il precedente della stessa entità (es. stesso `item_ref`) non è
  concluso, anche se è fallito o `dead`;
- **handler fallito**: rollback, poi `bus.fail`. Nuovi tentativi dopo 10 s, 1 min, 5 min, 30 min, poi ogni ora;
  `dead` al decimo. Un solo timer per processo, e solo se ci sono consegne fallite;
- **payload non valido** per il contratto: `dead` subito, l'handler non viene chiamato;
- **argomento senza handler**, o versione sconosciuta a questo pacchetto: trattato come fallimento, con nuovi tentativi. Aggiornare
  il pacchetto o aggiungere l'handler lo risolve;
- **riconnessione** automatica dell'ascolto, con attesa crescente fino a 30 s;
- **email dei blocchi** (se `notices.send`): presa in carico atomica, una sola app invia; se l'invio fallisce la presa
  viene rilasciata e questa istanza aspetta 60 s prima di riprovare lo stesso avviso.

Metodi: `start()`, `stop()`, `drain()` (svuota subito), `inspect()` → `{ running, listening, retryAt }` per le pagine di
salute.

## Regole per gli handler

- **Idempotenza di dominio** in più di quella del bus: vincoli univoci come `(organization_id, item_ref)` su `sales`
  (ADR-0015 §15.3). Il bus garantisce una sola conferma, ma un effetto scritto fuori da `tx` non è protetto.
- **Niente commit, rollback o `SET` di sessione** su `tx`.
- **Nessun dato sensibile nei messaggi d'errore**: il testo dell'eccezione finisce in `bus.deliveries.last_error` e nelle email di blocco.
- **Messaggi sensibili** (`account.provisioning_requested`, `account.password_changed`): il payload contiene un JWE
  per il destinatario, e il bus lo cancella quando tutte le consegne sono concluse.
- **Durata**: `statement_timeout` dell'utente è 60 s; un handler lungo tiene aperta la transazione e il lock della consegna.

## Pubblicare da knex (Strapi)

`publish` vuole un client con `query(text, values)` che restituisca `{ rows }`, cioè la forma di `pg`. Un'app che parla
con il database tramite knex usa `knexClient`, che converte i segnaposto (`$1` → `?`) e normalizza la risposta:

```js
const { publish, knexClient } = require('comfort-platform')

await strapi.db.transaction(async ({ trx }) => {
  await trx('order_items').where({ id }).update({ status: 'served' })
  await publish(knexClient(trx), 'tables.sales.item_served', { schemaVersion: 1, organizationId, payload })
})
```

Va costruito sulla **transazione**, non sull'istanza knex: una `knex` qualunque prenderebbe un'altra connessione dal
pool, fuori dalla transazione dell'operazione, e il messaggio non nascerebbe più con essa (invariante 3).
