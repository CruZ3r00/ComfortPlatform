-- Iscrizione di ComforTables al bus: primo gradino dell'integrazione (ADR-0015 §15.11).
--
-- Solo `logistics.link_changed`, perche' e' il presupposto di tutto il resto: senza lo
-- stato del collegamento ComforTables non sa per quali organizzazioni pubblicare le
-- vendite. Gli altri argomenti prodotti da ComfortLogistics (disponibilita', alert,
-- riepilogo del bar) si iscrivono quando ComforTables avra' gli handler corrispondenti:
-- un'app iscritta a un argomento che non sa elaborare fa fallire quelle consegne
-- (ADR-0014 §14.8), com'e' gia' successo a ComfortLogistics con i 14 argomenti.
insert into bus.subscriptions (app, topic, schema_version) values
  ('comfortables', 'logistics.link_changed', 1)
on conflict (app, topic) do nothing;
