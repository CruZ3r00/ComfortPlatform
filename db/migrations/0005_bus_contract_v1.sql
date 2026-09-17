-- 0005 - Contratto v1 del bus: argomenti, versioni e iscrizioni (ADR-0014 §14.8, piano 0007 §3.10.4).
--
-- Fonte unica: bus/contract/catalog.json, con i JSON Schema in bus/contract/<argomento>/v1.schema.json.
-- Un test verifica che questa migrazione registri esattamente il catalogo.
--
-- Iscrizioni: solo quelle di ComfortLogistics, il cui sviluppo parte ora. Quelle di ComforTables arrivano con
-- la sua integrazione (piano 0007 Fase 5): nel frattempo `bus.publish` non salva i messaggi senza iscritti.
-- `platform.clock.daily` e' gia' registrato da 0004 e qui converge.
--
-- Eseguita dall'amministratore, che agisce come platform_admin (0002). Idempotente: `on conflict do nothing`;
-- un'iscrizione gia' passata a un'altra versione non torna indietro.

insert into bus.topics (name, producer, sensitive, retention_days) values
  ('tables.catalog.dish_changed', 'comfortables', false, 30),
  ('tables.catalog.ingredient_changed', 'comfortables', false, 30),
  ('tables.catalog.snapshot', 'comfortables', false, 30),
  ('tables.sales.item_served', 'comfortables', false, 30),
  ('tables.sales.item_voided', 'comfortables', false, 30),
  ('tables.bar.reload_done', 'comfortables', false, 30),
  ('tables.bar.preview_requested', 'comfortables', false, 30),
  ('tables.alerts.acknowledge_requested', 'comfortables', false, 30),
  ('logistics.link_changed', 'logistics', false, 30),
  ('logistics.catalog.snapshot_requested', 'logistics', false, 30),
  ('logistics.availability.changed', 'logistics', false, 30),
  ('logistics.alerts.updated', 'logistics', false, 30),
  ('logistics.bar.preview_ready', 'logistics', false, 30),
  ('logistics.notifications.email_requested', 'logistics', false, 30),
  ('account.provisioning_requested', 'account', true, 30),
  ('account.entitlements_changed', 'account', false, 30),
  ('account.password_changed', 'account', true, 30),
  ('account.organization_changed', 'account', false, 30),
  ('account.session_ended', 'account', false, 30),
  ('account.person_changed', 'account', false, 30),
  ('platform.clock.daily', 'platform', false, 30)
on conflict (name) do nothing;

insert into bus.topic_versions (topic, schema_version) values
  ('tables.catalog.dish_changed', 1),
  ('tables.catalog.ingredient_changed', 1),
  ('tables.catalog.snapshot', 1),
  ('tables.sales.item_served', 1),
  ('tables.sales.item_voided', 1),
  ('tables.bar.reload_done', 1),
  ('tables.bar.preview_requested', 1),
  ('tables.alerts.acknowledge_requested', 1),
  ('logistics.link_changed', 1),
  ('logistics.catalog.snapshot_requested', 1),
  ('logistics.availability.changed', 1),
  ('logistics.alerts.updated', 1),
  ('logistics.bar.preview_ready', 1),
  ('logistics.notifications.email_requested', 1),
  ('account.provisioning_requested', 1),
  ('account.entitlements_changed', 1),
  ('account.password_changed', 1),
  ('account.organization_changed', 1),
  ('account.session_ended', 1),
  ('account.person_changed', 1),
  ('platform.clock.daily', 1)
on conflict (topic, schema_version) do nothing;

insert into bus.subscriptions (app, topic, schema_version) values
  ('logistics', 'tables.catalog.dish_changed', 1),
  ('logistics', 'tables.catalog.ingredient_changed', 1),
  ('logistics', 'tables.catalog.snapshot', 1),
  ('logistics', 'tables.sales.item_served', 1),
  ('logistics', 'tables.sales.item_voided', 1),
  ('logistics', 'tables.bar.reload_done', 1),
  ('logistics', 'tables.bar.preview_requested', 1),
  ('logistics', 'tables.alerts.acknowledge_requested', 1),
  ('logistics', 'logistics.notifications.email_requested', 1),
  ('logistics', 'account.entitlements_changed', 1),
  ('logistics', 'account.organization_changed', 1),
  ('logistics', 'account.session_ended', 1),
  ('logistics', 'account.person_changed', 1),
  ('logistics', 'platform.clock.daily', 1)
on conflict (app, topic) do nothing;
