-- Fase 3: ComforTables riceve i diritti dell'account (ADR-0013 §13.7).
-- Applicare solo dopo il deploy del consumer ComforTables che gestisce la v1:
-- una consegna senza handler bloccherebbe l'entita' nel bus.
insert into bus.subscriptions (app, topic, schema_version) values
  ('comfortables', 'account.entitlements_changed', 1)
on conflict (app, topic) do nothing;
