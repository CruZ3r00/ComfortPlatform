# Lessons

Regole ricavate da correzioni dell'utente ed errori propri in ComfortPlatform. Le lezioni comuni al
workspace restano in `../ComforTables/lessons.md`.

## 2026-09-16 - ESLint 10: rilanciare un errore avvolto vuole `{ cause }`

- ERRORE: il primo lint dell'harness ha fallito su `preserve-caught-error` (nuova nella config
  consigliata di ESLint 10): dentro un `catch` lanciavo un `new Error(...)` arricchito senza
  collegare l'errore originale. Nello stesso giro una destrutturazione usata solo per omettere una
  chiave (`{ X: _omesso, ...resto }`) ha fatto scattare `no-unused-vars`.
- REGOLA: quando un errore catturato viene riformulato, passare sempre `new Error(msg, { cause: err })`
  (o l'equivalente nell'helper), cosi' lo stack originale resta leggibile. Per togliere una chiave da
  una copia usare `const copia = { ...obj }; delete copia.X`. Lanciare `npm run lint` subito dopo ogni
  file nuovo, non a fine sessione.

## 2026-09-16 - Un comando di sistema da far eseguire all'utente va verificato sul percorso reale

- ERRORE: per installare postgresql-16 senza il cluster di sistema ho indicato
  `echo 'create_main_cluster = false' | sudo tee /etc/postgresql-common/createcluster.d/...`.
  Avevo controllato che `createcluster.conf` includesse `createcluster.d`, ma non che la cartella
  esistesse: non esisteva, `tee` ha fallito e Debian ha creato e avviato il cluster `16/main` sulla
  porta 5432.
- REGOLA: prima di consegnare un comando che scrive in un percorso di sistema, verificare con `ls`
  che ogni cartella del percorso esista; se non e' garantita, anteporre `sudo mkdir -p`. Un comando
  che l'utente esegue con `sudo` non si puo' correggere in corsa: deve funzionare al primo colpo.
- VERIFICA: dopo l'installazione controllare anche l'effetto collaterale che il comando doveva
  evitare (`pgrep -a postgres`, `ls /etc/postgresql`), non solo la presenza dei binari.
