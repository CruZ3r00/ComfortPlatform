-- Iscrizione di ComforTables ai quattro argomenti di ComfortLogistics che ora sa elaborare
-- (ADR-0015 §15.4, §15.8, §15.9, §15.11).
--
-- La `0010` ne aveva registrato uno solo, `logistics.link_changed`, perche' era il solo con un
-- handler. Adesso ComforTables ha anche gli altri quattro, e vanno insieme: un'app iscritta a un
-- argomento che non sa elaborare fa fallire quelle consegne (ADR-0014 §14.8), ma un argomento
-- senza iscritti e' peggio — `bus.publish` restituisce null e il messaggio non viene nemmeno
-- conservato. E' quello che accadeva a «Importa da ComforTables»: pubblicava una domanda che
-- svaniva nello stesso istante.
--
-- - `catalog.snapshot_requested` → ComforTables risponde con `tables.catalog.snapshot` a blocchi;
-- - `availability.changed`       → disponibilita' di piatti e ingredienti del menu;
-- - `alerts.updated`             → proiezione locale degli alert e campanello;
-- - `bar.preview_ready`          → dettaglio ml e bottiglie del riepilogo del bar.
insert into bus.subscriptions (app, topic, schema_version) values
  ('comfortables', 'logistics.catalog.snapshot_requested', 1),
  ('comfortables', 'logistics.availability.changed', 1),
  ('comfortables', 'logistics.alerts.updated', 1),
  ('comfortables', 'logistics.bar.preview_ready', 1)
on conflict (app, topic) do nothing;
