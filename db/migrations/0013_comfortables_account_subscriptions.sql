-- Iscrizione di ComforTables agli argomenti dell'account (sessione D dell'accesso unico, ADR-0013 §13.3 e §13.8;
-- piano in ../ComfortService/todo.md, Passo 3, decisione P7).
--
-- ComforTables diventa client dell'accesso unico e riceve dall'account:
-- - `account.session_ended`          → rifiuta le sessioni del titolare autenticate prima della revoca (P3);
-- - `account.password_changed`       → hash predefinito dello staff (JWE) e profili non personalizzati;
-- - `account.person_changed`         → copia di email e nome del titolare;
-- - `account.organization_changed`   → attivita' cancellata: locale sospeso;
-- - `account.provisioning_requested` → attivita' nuova collegata a ComforTables, nella **v2**.
-- `account.entitlements_changed` resta alla Fase 3: un argomento iscritto e non gestito fa fallire le consegne.
--
-- v2 di `provisioning_requested`: come la v1, ma `plan_code` puo' essere null. Prima dei piani (Fase 3) l'account la
-- pubblica al primo collegamento di un'attivita' a ComforTables, quando un piano non esiste ancora. La v1 resta
-- registrata: non ha iscritti ne' messaggi e non e' mai stata prodotta.
--
-- ORDINE SUGLI AMBIENTI: il consumatore di ComforTables fa fallire un argomento senza handler e una versione che il
-- suo pacchetto non conosce, e le consegne morte bloccano l'entita'. Applicare questa migrazione a un ambiente solo
-- quando li' gira ComforTables con gli handler della sessione D e `comfort-platform` >= 0.10.0: prima il deploy, poi
-- la migrazione.
insert into bus.topic_versions (topic, schema_version) values
  ('account.provisioning_requested', 2)
on conflict (topic, schema_version) do nothing;

insert into bus.subscriptions (app, topic, schema_version) values
  ('comfortables', 'account.provisioning_requested', 2),
  ('comfortables', 'account.password_changed', 1),
  ('comfortables', 'account.organization_changed', 1),
  ('comfortables', 'account.session_ended', 1),
  ('comfortables', 'account.person_changed', 1)
on conflict (app, topic) do nothing;
