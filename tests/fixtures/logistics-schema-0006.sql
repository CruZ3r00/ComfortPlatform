-- Struttura di ComfortLogistics (schema logistics), copia delle sue migrazioni 0001-0006
-- (../ComfortLogistics/backend/migrations, 2026-09-24): la destinazione di data-migrations/logistics-copy.
-- Da applicare come cl_app. Aggiornare quando ComfortLogistics aggiunge migrazioni che la copia deve conoscere.

-- ===== 0001_identity.sql
create table logistics.organizations (
  id uuid primary key,
  legal_name text not null default '',
  entitlements jsonb not null default '{"version":0,"active":false,"products":[],"period_end":null}',
  entitlements_version bigint not null default 0,
  inactive_since timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table logistics.persons (
  organization_id uuid not null references logistics.organizations(id),
  person_id uuid not null,
  email text not null,
  name text not null default '',
  session_version bigint not null default 1,
  revoked_at timestamptz,
  primary key (organization_id, person_id)
);

create table logistics.sessions (
  token_hash text primary key,
  organization_id uuid not null,
  person_id uuid not null,
  session_version bigint not null,
  csrf_token text not null,
  authenticated_at timestamptz not null default 'epoch',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  foreign key (organization_id, person_id) references logistics.persons(organization_id, person_id)
);
create index sessions_expiry on logistics.sessions(expires_at);

create table logistics.oidc_transactions (
  state_hash text primary key,
  binding_hash text not null,
  nonce text not null,
  verifier text not null,
  return_to text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index oidc_transactions_expiry on logistics.oidc_transactions(expires_at);

-- Tombstone di sicurezza, anche prima del primo accesso: non crea un tenant.
create table logistics.auth_revocations (
  organization_id uuid not null,
  person_id uuid not null,
  revoked_at timestamptz not null,
  primary key (organization_id, person_id)
);

alter table logistics.organizations enable row level security;
alter table logistics.persons enable row level security;
alter table logistics.sessions enable row level security;
alter table logistics.oidc_transactions enable row level security;
alter table logistics.auth_revocations enable row level security;
revoke all on logistics.organizations, logistics.persons, logistics.sessions, logistics.oidc_transactions, logistics.auth_revocations from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema logistics from %I', r);
    end if;
  end loop;
end $$;

-- ===== 0002_inventory.sql
CREATE TABLE logistics.storage_locations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX storage_locations_default ON logistics.storage_locations (organization_id) WHERE is_default;

CREATE TABLE logistics.suppliers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  name_normalized text NOT NULL CHECK (length(name_normalized) > 0),
  email text,
  phone text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name_normalized)
);

CREATE TABLE logistics.articles (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  name_normalized text NOT NULL CHECK (length(name_normalized) > 0),
  unit text NOT NULL CHECK (unit IN ('g', 'ml', 'pz', 'mazzo')),
  pack_size numeric(18,6) NOT NULL DEFAULT 1 CHECK (pack_size > 0),
  pack_label text,
  low_stock_threshold numeric(18,6) NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  supplier_id uuid,
  avg_unit_cost numeric(18,8) CHECK (avg_unit_cost >= 0),
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, name_normalized),
  FOREIGN KEY (organization_id, supplier_id) REFERENCES logistics.suppliers(organization_id, id)
);

CREATE TABLE logistics.stock (
  organization_id uuid NOT NULL,
  article_id uuid NOT NULL,
  storage_location_id uuid NOT NULL,
  quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  ever_restocked boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (organization_id, article_id, storage_location_id),
  FOREIGN KEY (organization_id, article_id) REFERENCES logistics.articles(organization_id, id),
  FOREIGN KEY (organization_id, storage_location_id) REFERENCES logistics.storage_locations(organization_id, id)
);

-- Una richiesta HTTP può generare più righe: la deduplica riguarda l'intera
-- operazione, senza imporre un source_ref condiviso ai singoli movimenti.
CREATE TABLE logistics.inventory_requests (
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  request_key uuid NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, request_key)
);

CREATE TABLE logistics.movements (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  article_id uuid NOT NULL,
  storage_location_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('initial', 'restock', 'consumption', 'waste', 'adjustment')),
  quantity numeric(18,6) NOT NULL CHECK (quantity <> 0),
  stock_before numeric(18,6) NOT NULL CHECK (stock_before >= 0),
  stock_after numeric(18,6) NOT NULL CHECK (stock_after >= 0),
  cost numeric(18,6) CHECK (cost >= 0),
  supplier_id uuid,
  reason text,
  notes text,
  batch_id uuid,
  request_key uuid,
  created_by uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id, article_id) REFERENCES logistics.articles(organization_id, id),
  FOREIGN KEY (organization_id, storage_location_id) REFERENCES logistics.storage_locations(organization_id, id),
  FOREIGN KEY (organization_id, supplier_id) REFERENCES logistics.suppliers(organization_id, id),
  FOREIGN KEY (organization_id, request_key) REFERENCES logistics.inventory_requests(organization_id, request_key),
  CHECK (stock_after = greatest(0, stock_before + quantity)),
  CHECK (kind NOT IN ('initial', 'restock') OR quantity > 0),
  CHECK (kind NOT IN ('consumption', 'waste') OR quantity < 0),
  CHECK (cost IS NULL OR kind = 'restock')
);
CREATE INDEX movements_history ON logistics.movements (organization_id, recorded_at DESC, id DESC);
CREATE INDEX movements_article_history ON logistics.movements (organization_id, article_id, recorded_at DESC, id DESC);

CREATE FUNCTION logistics.reject_movement_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'I movimenti di magazzino sono immutabili' USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER movements_immutable BEFORE UPDATE OR DELETE ON logistics.movements
FOR EACH ROW EXECUTE FUNCTION logistics.reject_movement_mutation();
CREATE TRIGGER movements_no_truncate BEFORE TRUNCATE ON logistics.movements
FOR EACH STATEMENT EXECUTE FUNCTION logistics.reject_movement_mutation();

ALTER TABLE logistics.storage_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.inventory_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics.storage_locations, logistics.suppliers, logistics.articles,
  logistics.stock, logistics.inventory_requests, logistics.movements FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON logistics.storage_locations, logistics.suppliers, logistics.articles, logistics.stock, logistics.inventory_requests, logistics.movements FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

-- ===== 0003_catalog_recipes.sql
-- Collegamento con l'app sorgente: nessuna FK verso 'tables', solo messaggi.
CREATE TABLE logistics.links (
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  source_app text NOT NULL CHECK (source_app IN ('comfortables')),
  state text NOT NULL CHECK (state IN ('active', 'inactive')),
  activated_at timestamptz,
  deactivated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, source_app),
  CHECK (state <> 'active' OR activated_at IS NOT NULL)
);

-- Copia del catalogo ComforTables. Il proprietario resta ComforTables: qui si
-- conserva solo quanto serve a collegare articoli e ricette.
CREATE TABLE logistics.source_items (
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  kind text NOT NULL CHECK (kind IN ('dish', 'menu_ingredient')),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  name_normalized text NOT NULL CHECK (length(name_normalized) > 0),
  category text,
  price numeric(18,6) CHECK (price >= 0),
  is_beverage boolean NOT NULL DEFAULT false,
  is_beverage_advanced boolean NOT NULL DEFAULT false,
  is_addon boolean NOT NULL DEFAULT false,
  allergens text[] NOT NULL DEFAULT '{}',
  archived boolean NOT NULL DEFAULT false,
  import_state text NOT NULL DEFAULT 'new' CHECK (import_state IN ('new', 'changed', 'linked', 'ignored', 'archived')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, kind, source_ref),
  CHECK (kind = 'dish' OR (NOT is_beverage AND NOT is_beverage_advanced)),
  CHECK (kind = 'menu_ingredient' OR NOT is_addon)
);
CREATE INDEX source_items_pending ON logistics.source_items (organization_id, import_state, name_normalized);

-- Ingrediente del menu -> articolo di magazzino. Un articolo può servire più
-- ingredienti; un ingrediente ha un solo articolo.
CREATE TABLE logistics.ingredient_links (
  organization_id uuid NOT NULL,
  source_ref text NOT NULL,
  -- Colonna fissa: serve solo a vincolare la FK agli ingredienti del menu.
  kind text NOT NULL DEFAULT 'menu_ingredient' CHECK (kind = 'menu_ingredient'),
  article_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, source_ref),
  FOREIGN KEY (organization_id, kind, source_ref)
    REFERENCES logistics.source_items(organization_id, kind, source_ref),
  FOREIGN KEY (organization_id, article_id) REFERENCES logistics.articles(organization_id, id)
);
CREATE INDEX ingredient_links_article ON logistics.ingredient_links (organization_id, article_id);

-- Una sola ricetta per elemento del catalogo: un piatto non può scaricare due volte.
CREATE TABLE logistics.recipes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  target text NOT NULL CHECK (target IN ('dish', 'addon', 'beverage')),
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_ref)
);

-- Versioni append-only: una vendita usa la versione valida al suo occurred_at.
CREATE TABLE logistics.recipe_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  recipe_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL CHECK (created_by IN ('user', 'auto_tuning', 'migration')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (recipe_id, valid_from),
  UNIQUE (recipe_id, number),
  FOREIGN KEY (organization_id, recipe_id) REFERENCES logistics.recipes(organization_id, id)
);
CREATE INDEX recipe_versions_validity ON logistics.recipe_versions (recipe_id, valid_from DESC);

CREATE TABLE logistics.recipe_lines (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  version_id uuid NOT NULL,
  article_id uuid NOT NULL,
  -- Quantità nell'unità base dell'articolo; NULL è la riga senza dose, che non scarica.
  quantity numeric(18,6) CHECK (quantity > 0),
  input_unit text NOT NULL CHECK (input_unit IN ('g', 'kg', 'ml', 'l', 'pz', 'mazzo')),
  UNIQUE (version_id, article_id),
  FOREIGN KEY (organization_id, version_id) REFERENCES logistics.recipe_versions(organization_id, id),
  FOREIGN KEY (organization_id, article_id) REFERENCES logistics.articles(organization_id, id)
);
CREATE INDEX recipe_lines_version ON logistics.recipe_lines (version_id);
CREATE INDEX recipe_lines_article ON logistics.recipe_lines (organization_id, article_id);

CREATE FUNCTION logistics.reject_recipe_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Le versioni delle ricette sono immutabili: registrarne una nuova' USING ERRCODE = '23514';
END
$$;
CREATE TRIGGER recipe_versions_immutable BEFORE UPDATE OR DELETE ON logistics.recipe_versions
FOR EACH ROW EXECUTE FUNCTION logistics.reject_recipe_history_mutation();
CREATE TRIGGER recipe_lines_immutable BEFORE UPDATE OR DELETE ON logistics.recipe_lines
FOR EACH ROW EXECUTE FUNCTION logistics.reject_recipe_history_mutation();

CREATE TABLE logistics.purchase_orders (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  article_id uuid NOT NULL,
  supplier_id uuid,
  state text NOT NULL DEFAULT 'ordered' CHECK (state IN ('ordered', 'received', 'cancelled')),
  quantity_expected numeric(18,6) NOT NULL CHECK (quantity_expected > 0),
  quantity_received numeric(18,6) CHECK (quantity_received > 0),
  cost numeric(18,6) CHECK (cost >= 0),
  notes text,
  ordered_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz,
  cancelled_at timestamptz,
  movement_id uuid REFERENCES logistics.movements(id),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, article_id) REFERENCES logistics.articles(organization_id, id),
  FOREIGN KEY (organization_id, supplier_id) REFERENCES logistics.suppliers(organization_id, id),
  CHECK (state <> 'received' OR (received_at IS NOT NULL AND quantity_received IS NOT NULL AND movement_id IS NOT NULL)),
  CHECK (state <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (state = 'received' OR (received_at IS NULL AND quantity_received IS NULL AND movement_id IS NULL))
);
CREATE INDEX purchase_orders_open ON logistics.purchase_orders (organization_id, state, ordered_at DESC);
CREATE INDEX purchase_orders_article ON logistics.purchase_orders (organization_id, article_id, ordered_at DESC);

-- Tempo di riordino: EMA dei riordini ricevuti, ricalcolata a ogni ricezione.
ALTER TABLE logistics.articles ADD COLUMN reorder_lead_days numeric(8,2) CHECK (reorder_lead_days >= 0.5);
ALTER TABLE logistics.movements ADD COLUMN purchase_order_id uuid;

ALTER TABLE logistics.links ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.source_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.ingredient_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.recipe_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.recipe_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.purchase_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics.links, logistics.source_items, logistics.ingredient_links, logistics.recipes,
  logistics.recipe_versions, logistics.recipe_lines, logistics.purchase_orders FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON logistics.links, logistics.source_items, logistics.ingredient_links, logistics.recipes, logistics.recipe_versions, logistics.recipe_lines, logistics.purchase_orders FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

-- ===== 0004_alerts_availability.sql
-- Registro delle vendite ricevute da ComforTables. In questa fase nessun produttore
-- lo riempie: serve al modello (ADR-0015 §15.3) e alla correzione delle dosi.
CREATE TABLE logistics.sales (
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  item_ref text NOT NULL CHECK (length(btrim(item_ref)) > 0),
  order_ref text,
  dish_ref text,
  freeform_name text,
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  is_beverage boolean NOT NULL DEFAULT false,
  outcome text NOT NULL CHECK (outcome IN ('consumed', 'no_recipe', 'pending_reload', 'voided')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, item_ref)
);
CREATE INDEX sales_history ON logistics.sales (organization_id, occurred_at DESC);
CREATE INDEX sales_dish ON logistics.sales (organization_id, dish_ref, occurred_at DESC);

CREATE TABLE logistics.alerts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  article_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('predictive', 'threshold')),
  level text NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  stock_qty numeric(18,6) NOT NULL CHECK (stock_qty >= 0),
  days_to_depletion numeric(10,2) CHECK (days_to_depletion >= 0),
  threshold numeric(18,6) CHECK (threshold >= 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  worsened_at timestamptz,
  archived_at timestamptz,
  archived_by text,
  closed_at timestamptz,
  close_reason text CHECK (close_reason IN ('restock', 'recovered')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, article_id) REFERENCES logistics.articles(organization_id, id),
  CHECK (closed_at IS NULL OR close_reason IS NOT NULL)
);
-- Un solo alert aperto per articolo e tipo: il peggioramento aggiorna, non duplica.
CREATE UNIQUE INDEX alerts_open ON logistics.alerts (organization_id, article_id, kind) WHERE closed_at IS NULL;
CREATE INDEX alerts_board ON logistics.alerts (organization_id, closed_at, archived_at, level);

-- Deduplica delle email: una per tipo ogni 24 ore, salvo peggioramento di livello.
CREATE TABLE logistics.alert_notifications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  alert_kind text NOT NULL CHECK (alert_kind IN ('predictive', 'threshold')),
  level text NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  recipient_email text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'sent', 'skipped', 'failed')),
  detail text,
  UNIQUE (organization_id, id)
);
CREATE INDEX alert_notifications_recent ON logistics.alert_notifications (organization_id, alert_kind, requested_at DESC);

-- Disponibilità calcolata qui e applicata in ComforTables. `in_stock` serve solo alla
-- chip «Terminata» delle aggiunte: guarda la giacenza, non le transizioni.
CREATE TABLE logistics.availability_state (
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  kind text NOT NULL CHECK (kind IN ('dish', 'menu_ingredient')),
  source_ref text NOT NULL,
  available boolean NOT NULL,
  in_stock boolean NOT NULL DEFAULT true,
  reason text,
  published_version bigint NOT NULL DEFAULT 0 CHECK (published_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, kind, source_ref),
  CHECK (kind = 'menu_ingredient' OR in_stock)
);

-- Versioni delle proiezioni inviate a ComforTables: crescono per organizzazione, così
-- un messaggio non più recente viene ignorato dal destinatario.
CREATE TABLE logistics.projection_versions (
  organization_id uuid PRIMARY KEY REFERENCES logistics.organizations(id),
  availability bigint NOT NULL DEFAULT 0 CHECK (availability >= 0),
  alerts bigint NOT NULL DEFAULT 0 CHECK (alerts >= 0)
);

ALTER TABLE logistics.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.alert_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.availability_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics.projection_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics.sales, logistics.alerts, logistics.alert_notifications,
  logistics.availability_state, logistics.projection_versions FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON logistics.sales, logistics.alerts, logistics.alert_notifications, logistics.availability_state, logistics.projection_versions FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

-- ===== 0005_dish_ingredients.sql
-- Ingredienti pubblici del piatto, come li manda ComforTables (contratto v1, campo
-- facoltativo): servono solo a precompilare la ricetta, le dosi restano qui.
ALTER TABLE logistics.source_items ADD COLUMN ingredient_refs text[] NOT NULL DEFAULT '{}';

-- ===== 0006_sales_discharge.sql
-- Scarico delle vendite (ADR-0015 §15.6). Completa il modello v1 dei movimenti con
-- l'origine in ComforTables e l'ora del servizio, e aggiunge il registro dei carichi
-- fatti del bar.

-- `source_ref` è l'item, l'ordine o il turno di ComforTables; `message_id` il messaggio
-- del bus che ha prodotto il movimento, per risalire dall'una all'altra parte.
ALTER TABLE logistics.movements ADD COLUMN source_ref text CHECK (source_ref IS NULL OR length(btrim(source_ref)) > 0);
ALTER TABLE logistics.movements ADD COLUMN message_id uuid;

-- Un movimento scritto dal bus non ha una persona: la colonna diventa annullabile e
-- NULL significa «scritto da un messaggio», non «autore sconosciuto».
ALTER TABLE logistics.movements ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE logistics.movements ADD CONSTRAINT movements_author
  CHECK (created_by IS NOT NULL OR message_id IS NOT NULL);

-- ADR-0015 §15.3 chiede `UNIQUE (organization_id, source_ref, kind)`, ma una sola vendita
-- genera un movimento per ogni articolo della sua ricetta, tutti con lo stesso `item_ref`.
-- La chiave scende quindi fino all'articolo e all'ubicazione (piano §6): le righe
-- semanticamente equivalenti (stesso articolo dalla ricetta del piatto e da un'aggiunta)
-- vengono aggregate in un movimento solo, e un doppio scarico lo respinge il database,
-- non soltanto il controllo in JavaScript.
CREATE UNIQUE INDEX movements_source ON logistics.movements
  (organization_id, source_ref, kind, article_id, storage_location_id) WHERE source_ref IS NOT NULL;
CREATE INDEX movements_message ON logistics.movements (organization_id, message_id) WHERE message_id IS NOT NULL;

-- Carichi fatti del bar già elaborati: la chiave primaria è l'invariante «ogni carico
-- fatto scarica al massimo una volta» (ADR-0015 §4.2), scritta nel database.
CREATE TABLE logistics.bar_reloads (
  organization_id uuid NOT NULL REFERENCES logistics.organizations(id),
  shift_ref text NOT NULL CHECK (length(btrim(shift_ref)) > 0),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz NOT NULL,
  served_total integer NOT NULL DEFAULT 0 CHECK (served_total >= 0),
  sales_consumed integer NOT NULL DEFAULT 0 CHECK (sales_consumed >= 0),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, shift_ref),
  CHECK (closed_at >= opened_at)
);
CREATE INDEX bar_reloads_history ON logistics.bar_reloads (organization_id, closed_at DESC);

-- Un annullo descrive l'item solo se il produttore manda i campi facoltativi: di un item
-- mai servito possiamo registrare l'annullo senza conoscerne la quantità. Negli altri
-- esiti la quantità resta obbligatoria.
ALTER TABLE logistics.sales ALTER COLUMN quantity DROP NOT NULL;
ALTER TABLE logistics.sales DROP CONSTRAINT sales_quantity_check;
ALTER TABLE logistics.sales ADD CONSTRAINT sales_quantity_check
  CHECK (quantity IS NULL OR quantity > 0);
ALTER TABLE logistics.sales ADD CONSTRAINT sales_quantity_required
  CHECK (outcome = 'voided' OR quantity IS NOT NULL);

-- Elenco delle bevande in attesa del carico fatto e dei piatti che non scaricano.
CREATE INDEX sales_outcome ON logistics.sales (organization_id, outcome, occurred_at DESC);

ALTER TABLE logistics.bar_reloads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics.bar_reloads FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON logistics.bar_reloads FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;
