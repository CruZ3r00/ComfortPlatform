-- 0008 - ComforTables da public a tables (ADR-0014 §14.1-14.3).
--
-- Sposta nello schema `tables`, di proprieta' di ct_app, gli oggetti di ComforTables che oggi vivono in `public`:
-- 160 tabelle (con sequenze, indici, vincoli, trigger e policy, che seguono la tabella) e 21 funzioni, i cui corpi
-- vengono ricreati con `tables.` e `search_path = tables, extensions`. Poi applica le regole di §14.2: RLS su ogni
-- tabella, niente ad anon e authenticated tranne i due campanelli del realtime (policy invariate, SELECT e USAGE
-- sullo schema per authenticated), nessuna funzione eseguibile da PUBLIC.
--
-- Elenco ESPLICITO: in `public` arrivera' il sito ComfortService (0009), quindi "tutto cio' che c'e' in public" non e'
-- una definizione di ComforTables. Elenco e corpi delle funzioni vengono dal database di staging del 2026-09-17
-- (inventario nel todo.md di ComfortService, sezione "Fase 1 su staging").
--
-- Stati ammessi, verificati prima di toccare qualcosa:
-- - nessuna tabella dell'elenco ne' in public ne' in tables: database nuovo (CI, sviluppo). Si crea solo lo schema;
--   le tabelle le creera' ComforTables con le sue migration;
-- - tutte le 160 tabelle e le 21 funzioni in public: si spostano;
-- - tutte in tables: migrazione gia' applicata, converge (proprieta', RLS, permessi, corpi delle funzioni).
-- Qualunque altra combinazione ferma la migrazione.
--
-- Ordine delle operazioni (l'amministratore ha SET ma non INHERIT su ct_app, come per cl_app e cs_account):
-- 1. ct_app concede USAGE e CREATE su `tables` all'amministratore, solo per questa transazione;
-- 2. l'amministratore, ancora proprietario, sposta tabelle e funzioni e ne cede la proprieta' a ct_app;
-- 3. come ct_app: revoca del permesso temporaneo; corpi delle funzioni, RLS, permessi.
-- La publication supabase_realtime riferisce le tabelle per identificativo interno: le due tabelle campanello
-- restano iscritte, e la migrazione lo verifica.
-- Su staging i corpi di emit_order_realtime_event e purge_table_order_realtime_events hanno fine riga CRLF: qui
-- diventano LF (.gitattributes fissa eol=lf sui .sql), stesso significato per plpgsql.
--
-- Rollback: db/rollback/0009-0008_comfortables_tables_schema.sql (riporta tutto in public com'era).

do $$
declare
  v_tables constant text[] := array[
    'admin_permissions',
    'admin_permissions_api_token_lnk',
    'admin_permissions_role_lnk',
    'admin_roles',
    'admin_users',
    'admin_users_roles_lnk',
    'audit_hardware_events',
    'bar_shifts',
    'bar_shifts_closed_by_lnk',
    'bar_shifts_fk_user_lnk',
    'bar_shifts_opened_by_lnk',
    'checkout_attempts',
    'checkout_attempts_fk_order_lnk',
    'checkout_attempts_fk_user_lnk',
    'ct_idempotency_keys',
    'customer_messages',
    'customer_messages_fk_order_lnk',
    'customer_messages_fk_time_proposal_lnk',
    'customer_messages_fk_user_lnk',
    'element_ingredients',
    'element_ingredients_fk_element_lnk',
    'element_ingredients_fk_ingredient_lnk',
    'elements',
    'elements_fk_user_lnk',
    'feature_definitions',
    'feature_rollout_events',
    'feature_rollout_owners',
    'feature_rollouts',
    'files',
    'files_folder_lnk',
    'files_related_mph',
    'fiscal_attempts',
    'fiscal_attempts_fk_checkout_attempt_lnk',
    'fiscal_attempts_fk_user_lnk',
    'fiscal_correction_attempts',
    'fiscal_correction_attempts_fk_checkout_attempt_lnk',
    'fiscal_correction_attempts_fk_fiscal_attempt_lnk',
    'fiscal_correction_attempts_fk_user_lnk',
    'hardware_endpoints',
    'hardware_endpoints_fk_pos_device_lnk',
    'hardware_endpoints_fk_user_lnk',
    'hardware_jobs',
    'hardware_jobs_fk_checkout_attempt_lnk',
    'hardware_jobs_fk_hardware_endpoint_lnk',
    'hardware_jobs_fk_pos_device_lnk',
    'hardware_jobs_fk_user_lnk',
    'i18n_locale',
    'ingredients',
    'ingredients_fk_user_lnk',
    'inventory_alerts',
    'inventory_alerts_acknowledged_by_lnk',
    'inventory_alerts_fk_user_lnk',
    'inventory_movements',
    'inventory_movements_fk_bar_shift_lnk',
    'inventory_movements_fk_ingredient_lnk',
    'inventory_movements_fk_order_item_lnk',
    'inventory_movements_fk_order_lnk',
    'inventory_movements_fk_restock_order_lnk',
    'inventory_movements_fk_user_lnk',
    'menu_element_stats',
    'menu_element_stats_fk_element_lnk',
    'menu_element_stats_fk_user_lnk',
    'menu_import_jobs',
    'menu_import_jobs_fk_user_lnk',
    'menu_import_leases',
    'menus',
    'menus_fk_elements_lnk',
    'menus_fk_user_lnk',
    'order_archives',
    'order_archives_fk_user_lnk',
    'order_item_addons',
    'order_item_addons_fk_ingredient_lnk',
    'order_item_addons_fk_order_item_lnk',
    'order_items',
    'order_items_fk_element_lnk',
    'order_items_fk_order_lnk',
    'order_realtime_events',
    'orders',
    'orders_fk_table_lnk',
    'orders_fk_user_lnk',
    'owner_feature_grant_events',
    'owner_feature_grants',
    'payment_attempts',
    'payment_attempts_fk_checkout_attempt_lnk',
    'payment_attempts_fk_user_lnk',
    'pos_devices',
    'pos_devices_fk_user_lnk',
    'pos_jobs',
    'pos_jobs_fk_device_lnk',
    'pos_jobs_fk_order_lnk',
    'pos_jobs_fk_user_lnk',
    'pos_pairing_tokens',
    'pos_pairing_tokens_fk_user_lnk',
    'reservations',
    'reservations_fk_order_lnk',
    'reservations_fk_table_lnk',
    'reservations_fk_user_lnk',
    'restaurant_category_routing',
    'restaurant_daily_stats',
    'restaurant_daily_stats_fk_user_lnk',
    'restaurant_printer_configs',
    'restaurant_printer_configs_fk_user_lnk',
    'restaurant_staff',
    'restock_orders',
    'restock_orders_fk_ingredient_lnk',
    'restock_orders_fk_user_lnk',
    'strapi_ai_localization_jobs',
    'strapi_ai_metadata_jobs',
    'strapi_api_token_permissions',
    'strapi_api_token_permissions_token_lnk',
    'strapi_api_tokens',
    'strapi_api_tokens_admin_user_owner_lnk',
    'strapi_core_store_settings',
    'strapi_database_schema',
    'strapi_history_versions',
    'strapi_migrations',
    'strapi_migrations_internal',
    'strapi_release_actions',
    'strapi_release_actions_release_lnk',
    'strapi_releases',
    'strapi_sessions',
    'strapi_transfer_token_permissions',
    'strapi_transfer_token_permissions_token_lnk',
    'strapi_transfer_tokens',
    'strapi_webhooks',
    'strapi_workflows',
    'strapi_workflows_stage_required_to_publish_lnk',
    'strapi_workflows_stages',
    'strapi_workflows_stages_permissions_lnk',
    'strapi_workflows_stages_workflow_lnk',
    'suppliers',
    'suppliers_fk_user_lnk',
    'sync_events',
    'sync_events_fk_user_lnk',
    'table_order_access_points',
    'table_order_commands',
    'table_order_participants',
    'table_order_rate_limits',
    'table_order_realtime_events',
    'table_order_service_requests',
    'table_order_sessions',
    'tables',
    'tables_fk_origins_lnk',
    'tables_fk_user_lnk',
    'tables_fk_zone_lnk',
    'takeaway_time_proposals',
    'takeaway_time_proposals_fk_order_lnk',
    'takeaway_time_proposals_fk_user_lnk',
    'up_permissions',
    'up_permissions_role_lnk',
    'up_roles',
    'up_users',
    'up_users_fk_owner_lnk',
    'up_users_role_lnk',
    'upload_folders',
    'upload_folders_parent_lnk',
    'website_configs',
    'website_configs_fk_user_lnk',
    'zones',
    'zones_fk_user_lnk'
  ];
  v_functions constant text[] := array[
    'classify_staff_role_for_category',
    'copy_owner_auth_role_link',
    'emit_order_realtime_event',
    'enforce_unique_ingredient_on_rename',
    'enforce_unique_ingredient_per_owner',
    'enforce_unique_table_number_on_renumber',
    'enforce_unique_table_number_per_owner',
    'ensure_owner_role_link',
    'ensure_restaurant_category_routing',
    'is_active_tavolo_subscription',
    'owner_has_feature',
    'owner_has_production_routing',
    'purge_table_order_realtime_events',
    'route_category_from_element_link',
    'route_category_from_element_update',
    'set_restaurant_staff_updated_at',
    'staff_username_for_role',
    'sync_owner_staff_accounts_trigger',
    'sync_owner_staff_accounts',
    'synthetic_staff_email',
    'upsert_staff_account'
  ];
  v_owner text;
  v_public int;
  v_moved int;
  v_functions_public int;
  v_functions_moved int;
  v_item text;
  v_function oid;
begin
  execute format('grant ct_app to %I with inherit false, set true', current_user);

  select nspowner::regrole::text into v_owner from pg_namespace where nspname = 'tables';
  if v_owner is not null and v_owner <> 'ct_app' then
    raise exception 'Lo schema tables esiste gia'' con proprietario %: migrazione fermata.', v_owner
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'Verifica chi lo ha creato prima di assegnarlo a ComforTables.';
  end if;

  -- Dal catalogo, non con to_regclass: dopo 0009 l'amministratore non ha USAGE su public, e to_regclass su uno
  -- schema non accessibile da' errore invece di NULL.
  select count(*) filter (where n.nspname = 'public'),
         count(*) filter (where n.nspname = 'tables')
    into v_public, v_moved
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and c.relname = any(v_tables) and n.nspname in ('public', 'tables');
  -- Per nome e schema, non per firma: il tipo di riga `up_users` di upsert_staff_account si risolve con il
  -- search_path, e dopo lo spostamento non sarebbe piu' visibile.
  select count(*) filter (where p.pronamespace = 'public'::regnamespace),
         count(*) filter (where p.pronamespace = to_regnamespace('tables'))
    into v_functions_public, v_functions_moved
    from pg_proc p
   where p.proname = any(v_functions);

  if not ((v_public = 0 and v_moved = 0 and v_functions_public = 0)
       or (v_public = 160 and v_moved = 0 and v_functions_public = 21 and v_functions_moved = 0)
       or (v_public = 0 and v_moved = 160 and v_functions_public = 0 and v_functions_moved = 21)) then
    raise exception 'Stato di ComforTables non previsto: tabelle in public %, in tables %; funzioni in public %, in tables %. Migrazione fermata.',
      v_public, v_moved, v_functions_public, v_functions_moved
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'Attesi 160/0 e 21/0 (da spostare), 0/160 e 0/21 (gia'' spostato) oppure nessun oggetto (database nuovo). Confronta l''elenco con il database.';
  end if;

  execute 'create schema if not exists tables authorization ct_app';
  if v_public = 0 then
    return;
  end if;

  execute 'set local role ct_app';
  execute format('grant usage, create on schema tables to %I', session_user);
  execute 'reset role';

  foreach v_item in array v_tables loop
    execute format('alter table public.%I set schema tables', v_item);
    execute format('alter table tables.%I owner to ct_app', v_item);
  end loop;
  for v_function in select p.oid from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any(v_functions) loop
    execute format('alter function %s set schema tables', v_function::regprocedure);
    execute format('alter function %s owner to ct_app', v_function::regprocedure);
  end loop;

  execute 'set local role ct_app';
  execute format('revoke usage, create on schema tables from %I', session_user);
  execute 'reset role';
end
$$;

-- Da qui in poi tutto come proprietario.
set local role ct_app;

alter default privileges for role ct_app revoke execute on functions from public;
revoke all on schema tables from public;
comment on schema tables is 'ComforTables (ADR-0014 §14.1, §14.3): tabelle e funzioni di proprieta'' di ct_app.';

do $do$
declare
  v_table text;
  v_function regprocedure;
  v_role text;
begin
  -- Database nuovo: niente da ricreare, le tabelle arriveranno con le migration di ComforTables.
  if not exists (select 1 from pg_class where relnamespace = 'tables'::regnamespace and relname = 'up_users') then
    return;
  end if;

  -- classify_staff_role_for_category(text)
  execute $fn_classify_staff_role_for_category$
CREATE OR REPLACE FUNCTION tables.classify_staff_role_for_category(p_category text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'tables', 'extensions'
AS $function$
declare
  v text := lower(coalesce(p_category, ''));
begin
  if v ~ '(bevande|bibite|drink|cocktail|vino|vini|birra|birre|amari|liquori|distillati|aperitivi|\ybar\y|caffe|caffè|acqua|soft drink|analcolic)' then
    return 'bar';
  end if;

  if v ~ '(senza glutine|gluten free|gluten-free|\ysg\y|celiac|celiach)' then
    return 'cucina_sg';
  end if;

  if v ~ '(pizza|pizze|pizzeria|focaccia|calzone)' then
    return 'pizzeria';
  end if;

  return 'cucina';
end;
$function$
$fn_classify_staff_role_for_category$;

  -- copy_owner_auth_role_link(integer,integer)
  execute $fn_copy_owner_auth_role_link$
CREATE OR REPLACE FUNCTION tables.copy_owner_auth_role_link(p_staff_id integer, p_owner_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
declare
  v_role_id integer;
begin
  if to_regclass('tables.up_users_role_lnk') is null then
    return;
  end if;

  select role_id into v_role_id
  from tables.up_users_role_lnk
  where user_id = p_owner_id
  limit 1;

  if v_role_id is not null then
    insert into tables.up_users_role_lnk (user_id, role_id)
    values (p_staff_id, v_role_id)
    on conflict do nothing;
  end if;
end;
$function$
$fn_copy_owner_auth_role_link$;

  -- emit_order_realtime_event()
  execute $fn_emit_order_realtime_event$
CREATE OR REPLACE FUNCTION tables.emit_order_realtime_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tables', 'extensions'
AS $function$
declare
  v_source_id integer;
  v_order_id integer;
  v_user_id integer;
begin
  if TG_TABLE_NAME = 'orders' then
    v_order_id := coalesce(NEW.id, OLD.id);
    v_source_id := v_order_id;
  elsif TG_TABLE_NAME = 'order_items' then
    v_source_id := coalesce(NEW.id, OLD.id);

    select l.order_id
      into v_order_id
      from tables.order_items_fk_order_lnk l
     where l.order_item_id = v_source_id
     limit 1;
  elsif TG_TABLE_NAME = 'orders_fk_user_lnk' then
    v_order_id := coalesce(NEW.order_id, OLD.order_id);
    v_source_id := v_order_id;
    v_user_id := coalesce(NEW.user_id, OLD.user_id);
  elsif TG_TABLE_NAME = 'order_items_fk_order_lnk' then
    v_source_id := coalesce(NEW.order_item_id, OLD.order_item_id);
    v_order_id := coalesce(NEW.order_id, OLD.order_id);
  elsif TG_TABLE_NAME = 'tables_fk_user_lnk' then
    v_source_id := coalesce(NEW.table_id, OLD.table_id);
    v_user_id := coalesce(NEW.user_id, OLD.user_id);
  elsif TG_TABLE_NAME = 'reservations_fk_user_lnk' then
    v_source_id := coalesce(NEW.reservation_id, OLD.reservation_id);
    v_user_id := coalesce(NEW.user_id, OLD.user_id);
  elsif TG_TABLE_NAME = 'tables' then
    v_source_id := coalesce(NEW.id, OLD.id);

    select l.user_id
      into v_user_id
      from tables.tables_fk_user_lnk l
     where l.table_id = v_source_id
     limit 1;
  elsif TG_TABLE_NAME = 'reservations' then
    v_source_id := coalesce(NEW.id, OLD.id);

    select l.user_id
      into v_user_id
      from tables.reservations_fk_user_lnk l
     where l.reservation_id = v_source_id
     limit 1;
  else
    return coalesce(NEW, OLD);
  end if;

  if v_user_id is null and v_order_id is not null then
    select l.user_id
      into v_user_id
      from tables.orders_fk_user_lnk l
     where l.order_id = v_order_id
     limit 1;
  end if;

  if v_user_id is not null then
    insert into tables.order_realtime_events (user_id, source_table, source_id, event_type)
    values (v_user_id, TG_TABLE_NAME, v_source_id, TG_OP);
  end if;

  delete from tables.order_realtime_events
   where created_at < now() - interval '1 day';

  return coalesce(NEW, OLD);
end;
$function$
$fn_emit_order_realtime_event$;

  -- enforce_unique_ingredient_on_rename()
  execute $fn_enforce_unique_ingredient_on_rename$
CREATE OR REPLACE FUNCTION tables.enforce_unique_ingredient_on_rename()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
      DECLARE
        v_owner_id INT;
        v_dup INT;
      BEGIN
        IF NEW.name_normalized IS NULL OR NEW.name_normalized = '' THEN
          RETURN NEW;
        END IF;
        IF OLD.name_normalized IS NOT NULL AND NEW.name_normalized = OLD.name_normalized THEN
          RETURN NEW;
        END IF;

        SELECT user_id INTO v_owner_id FROM ingredients_fk_user_lnk WHERE ingredient_id = NEW.id LIMIT 1;
        IF v_owner_id IS NULL THEN
          RETURN NEW;
        END IF;

        PERFORM pg_advisory_xact_lock(v_owner_id, hashtext(NEW.name_normalized));

        SELECT COUNT(*) INTO v_dup
        FROM ingredients_fk_user_lnk lnk
        JOIN ingredients i ON i.id = lnk.ingredient_id
        WHERE lnk.user_id = v_owner_id
          AND lnk.ingredient_id <> NEW.id
          AND i.name_normalized = NEW.name_normalized;

        IF v_dup > 0 THEN
          RAISE EXCEPTION 'rename to duplicate name % for user_id=%', NEW.name_normalized, v_owner_id
            USING ERRCODE = 'unique_violation';
        END IF;

        RETURN NEW;
      END;
      $function$
$fn_enforce_unique_ingredient_on_rename$;

  -- enforce_unique_ingredient_per_owner()
  execute $fn_enforce_unique_ingredient_per_owner$
CREATE OR REPLACE FUNCTION tables.enforce_unique_ingredient_per_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
      DECLARE
        v_name_norm TEXT;
        v_dup INT;
      BEGIN
        SELECT name_normalized INTO v_name_norm FROM ingredients WHERE id = NEW.ingredient_id;
        IF v_name_norm IS NULL OR v_name_norm = '' THEN
          RETURN NEW;
        END IF;

        PERFORM pg_advisory_xact_lock(NEW.user_id, hashtext(v_name_norm));

        SELECT COUNT(*) INTO v_dup
        FROM ingredients_fk_user_lnk lnk
        JOIN ingredients i ON i.id = lnk.ingredient_id
        WHERE lnk.user_id = NEW.user_id
          AND lnk.ingredient_id <> NEW.ingredient_id
          AND i.name_normalized = v_name_norm;

        IF v_dup > 0 THEN
          RAISE EXCEPTION 'duplicate ingredient name % for user_id=%', v_name_norm, NEW.user_id
            USING ERRCODE = 'unique_violation';
        END IF;

        RETURN NEW;
      END;
      $function$
$fn_enforce_unique_ingredient_per_owner$;

  -- enforce_unique_table_number_on_renumber()
  execute $fn_enforce_unique_table_number_on_renumber$
CREATE OR REPLACE FUNCTION tables.enforce_unique_table_number_on_renumber()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
      DECLARE
        v_owner_id INT;
        v_dup INT;
      BEGIN
        IF NEW.number IS NULL THEN
          RETURN NEW;
        END IF;
        IF OLD.number IS NOT DISTINCT FROM NEW.number THEN
          RETURN NEW;
        END IF;

        SELECT user_id INTO v_owner_id FROM tables_fk_user_lnk WHERE table_id = NEW.id LIMIT 1;
        IF v_owner_id IS NULL THEN
          RETURN NEW;
        END IF;

        PERFORM pg_advisory_xact_lock(v_owner_id, NEW.number);

        SELECT COUNT(*) INTO v_dup
        FROM tables_fk_user_lnk lnk
        JOIN tables t ON t.id = lnk.table_id
        WHERE lnk.user_id = v_owner_id
          AND lnk.table_id <> NEW.id
          AND t.number = NEW.number;

        IF v_dup > 0 THEN
          RAISE EXCEPTION 'duplicate table number % for user_id=%', NEW.number, v_owner_id
            USING ERRCODE = 'unique_violation';
        END IF;

        RETURN NEW;
      END;
      $function$
$fn_enforce_unique_table_number_on_renumber$;

  -- enforce_unique_table_number_per_owner()
  execute $fn_enforce_unique_table_number_per_owner$
CREATE OR REPLACE FUNCTION tables.enforce_unique_table_number_per_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
      DECLARE
        v_number INT;
        v_dup INT;
      BEGIN
        SELECT number INTO v_number FROM tables WHERE id = NEW.table_id;
        -- I derivati (merged/split_part) hanno number NULL: fuori dal vincolo.
        IF v_number IS NULL THEN
          RETURN NEW;
        END IF;

        PERFORM pg_advisory_xact_lock(NEW.user_id, v_number);

        SELECT COUNT(*) INTO v_dup
        FROM tables_fk_user_lnk lnk
        JOIN tables t ON t.id = lnk.table_id
        WHERE lnk.user_id = NEW.user_id
          AND lnk.table_id <> NEW.table_id
          AND t.number = v_number;

        IF v_dup > 0 THEN
          RAISE EXCEPTION 'duplicate table number % for user_id=%', v_number, NEW.user_id
            USING ERRCODE = 'unique_violation';
        END IF;

        RETURN NEW;
      END;
      $function$
$fn_enforce_unique_table_number_per_owner$;

  -- ensure_owner_role_link(integer,integer)
  execute $fn_ensure_owner_role_link$
CREATE OR REPLACE FUNCTION tables.ensure_owner_role_link(p_staff_id integer, p_owner_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
begin
  if to_regclass('tables.up_users_fk_owner_lnk') is not null then
    insert into tables.up_users_fk_owner_lnk (user_id, inv_user_id)
    values (p_staff_id, p_owner_id)
    on conflict do nothing;
  end if;
end;
$function$
$fn_ensure_owner_role_link$;

  -- ensure_restaurant_category_routing(integer,text)
  execute $fn_ensure_restaurant_category_routing$
CREATE OR REPLACE FUNCTION tables.ensure_restaurant_category_routing(p_owner_id integer, p_category text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
declare
  v_category text := nullif(btrim(coalesce(p_category, '')), '');
  v_role text;
begin
  if p_owner_id is null or v_category is null then
    return;
  end if;

  v_role := tables.classify_staff_role_for_category(v_category);

  insert into tables.restaurant_category_routing (owner_id, category, staff_role, locked)
  values (p_owner_id, v_category, v_role, false)
  on conflict (owner_id, category_key) do nothing;
end;
$function$
$fn_ensure_restaurant_category_routing$;

  -- is_active_tavolo_subscription(text,timestamp with time zone,date)
  execute $fn_is_active_tavolo_subscription$
CREATE OR REPLACE FUNCTION tables.is_active_tavolo_subscription(p_status text, p_period_end timestamp with time zone, p_end_subscription date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'tables', 'extensions'
AS $function$
  select coalesce(p_status, '') in ('active', 'trialing')
    and case
      when p_period_end is not null then p_period_end >= now()
      when p_end_subscription is not null then p_end_subscription >= current_date
      else true
    end;
$function$
$fn_is_active_tavolo_subscription$;

  -- owner_has_feature(integer,text)
  execute $fn_owner_has_feature$
CREATE OR REPLACE FUNCTION tables.owner_has_feature(p_owner_id integer, p_feature_code text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'tables', 'extensions'
AS $function$
  with owner_row as (
    select *
    from tables.up_users u
    where u.id = p_owner_id
      and tables.is_active_tavolo_subscription(
        u.subscription_status,
        u.subscription_current_period_end,
        u.end_subscription
      )
  ),
  wanted as (
    select fd.code, fd.professional_enabled
    from tables.feature_definitions fd
    where fd.code = p_feature_code
      and fd.status in ('active', 'hidden', 'deprecated')
      and coalesce(fd.system_only, false) = false
  ),
  active_grants as (
    select g.feature_code
    from tables.owner_feature_grants g
    join owner_row o on o.id = g.owner_id
    where g.status = 'active'
  )
  select exists (
    select 1
    from wanted w
    where exists (select 1 from active_grants g where g.feature_code = w.code)
       or (
         w.professional_enabled = true
         and exists (select 1 from active_grants g where g.feature_code = 'all.feature')
       )
  );
$function$
$fn_owner_has_feature$;

  -- owner_has_production_routing(integer)
  execute $fn_owner_has_production_routing$
CREATE OR REPLACE FUNCTION tables.owner_has_production_routing(p_owner_id integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'tables', 'extensions'
AS $function$
  select tables.owner_has_feature(p_owner_id, 'production.department_routing');
$function$
$fn_owner_has_production_routing$;

  -- purge_table_order_realtime_events(interval)
  execute $fn_purge_table_order_realtime_events$
CREATE OR REPLACE FUNCTION tables.purge_table_order_realtime_events(p_older_than interval DEFAULT '01:00:00'::interval)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tables', 'extensions'
AS $function$
declare
  v_deleted integer;
begin
  delete from tables.table_order_realtime_events
  where created_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$
$fn_purge_table_order_realtime_events$;

  -- route_category_from_element_link()
  execute $fn_route_category_from_element_link$
CREATE OR REPLACE FUNCTION tables.route_category_from_element_link()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
declare
  v_category text;
begin
  select category into v_category
  from tables.elements
  where id = new.element_id;

  perform tables.ensure_restaurant_category_routing(new.user_id, v_category);
  return new;
end;
$function$
$fn_route_category_from_element_link$;

  -- route_category_from_element_update()
  execute $fn_route_category_from_element_update$
CREATE OR REPLACE FUNCTION tables.route_category_from_element_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
declare
  v_owner_id integer;
begin
  if new.category is null or new.category is not distinct from old.category then
    return new;
  end if;

  if to_regclass('tables.elements_fk_user_lnk') is not null then
    select user_id into v_owner_id
    from tables.elements_fk_user_lnk
    where element_id = new.id
    limit 1;
  end if;

  perform tables.ensure_restaurant_category_routing(v_owner_id, new.category);
  return new;
end;
$function$
$fn_route_category_from_element_update$;

  -- set_restaurant_staff_updated_at()
  execute $fn_set_restaurant_staff_updated_at$
CREATE OR REPLACE FUNCTION tables.set_restaurant_staff_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
$fn_set_restaurant_staff_updated_at$;

  -- staff_username_for_role(integer,text,text)
  execute $fn_staff_username_for_role$
CREATE OR REPLACE FUNCTION tables.staff_username_for_role(p_owner_id integer, p_owner_username text, p_role text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'tables', 'extensions'
AS $function$
declare
  v_restaurant_name text;
  v_base text;
begin
  if to_regclass('tables.website_configs') is not null
     and to_regclass('tables.website_configs_fk_user_lnk') is not null then
    select wc.restaurant_name into v_restaurant_name
    from tables.website_configs wc
    join tables.website_configs_fk_user_lnk lnk on lnk.website_config_id = wc.id
    where lnk.user_id = p_owner_id
    order by wc.id desc
    limit 1;
  end if;

  v_base := regexp_replace(
    initcap(regexp_replace(coalesce(nullif(btrim(v_restaurant_name), ''), nullif(btrim(p_owner_username), ''), 'Ristorante'), '[^[:alnum:]]+', ' ', 'g')),
    '[^[:alnum:]]+',
    '',
    'g'
  );

  return concat(
    v_base,
    '.',
    case p_role
      when 'cucina_sg' then 'cucinasg'
      else p_role
    end
  );
end;
$function$
$fn_staff_username_for_role$;

  -- sync_owner_staff_accounts_trigger()
  execute $fn_sync_owner_staff_accounts_trigger$
CREATE OR REPLACE FUNCTION tables.sync_owner_staff_accounts_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
begin
  if coalesce(new.staff_role, 'owner') = 'owner' then
    perform tables.sync_owner_staff_accounts(new.id);
  end if;
  return new;
end;
$function$
$fn_sync_owner_staff_accounts_trigger$;

  -- sync_owner_staff_accounts(integer)
  execute $fn_sync_owner_staff_accounts$
CREATE OR REPLACE FUNCTION tables.sync_owner_staff_accounts(p_owner_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
declare
  v_owner tables.up_users%rowtype;
  v_has_subscription boolean;
  v_has_production_routing boolean;
  v_core_staff boolean;
  v_role text;
begin
  select * into v_owner
  from tables.up_users
  where id = p_owner_id;

  if not found then
    return;
  end if;

  if coalesce(v_owner.staff_role, 'owner') <> 'owner' then
    return;
  end if;

  v_has_subscription := tables.is_active_tavolo_subscription(
    v_owner.subscription_status,
    v_owner.subscription_current_period_end,
    v_owner.end_subscription
  );

  if not v_has_subscription then
    update tables.up_users staff
    set blocked = true,
        updated_at = now()
    from tables.restaurant_staff rs
    where rs.owner_id = v_owner.id
      and rs.user_id = staff.id;
    return;
  end if;

  v_core_staff := coalesce(v_owner.subscription_plan, '') in ('starter', 'pro', 'custom');
  v_has_production_routing := tables.owner_has_feature(v_owner.id, 'production.department_routing');

  perform tables.upsert_staff_account(v_owner, 'cameriere', v_core_staff);
  update tables.restaurant_staff
  set active = true
  where owner_id = v_owner.id
    and role = 'cameriere';

  perform tables.upsert_staff_account(v_owner, 'cucina', v_core_staff);

  update tables.up_users staff
  set blocked = not (rs.active and v_core_staff),
      updated_at = now()
  from tables.restaurant_staff rs
  where rs.owner_id = v_owner.id
    and rs.role in ('cameriere', 'cucina')
    and rs.user_id = staff.id;

  update tables.up_users staff
  set blocked = not (rs.active and v_core_staff),
      updated_at = now()
  from tables.restaurant_staff rs
  where rs.owner_id = v_owner.id
    and rs.role = 'gestione'
    and rs.user_id = staff.id;

  if v_has_production_routing then
    perform tables.upsert_staff_account(v_owner, 'bar', true);
    perform tables.upsert_staff_account(v_owner, 'pizzeria', true);
    perform tables.upsert_staff_account(v_owner, 'cucina_sg', true);
  else
    for v_role in select unnest(array['bar', 'pizzeria', 'cucina_sg'])
    loop
      update tables.up_users staff
      set blocked = true,
          updated_at = now()
      from tables.restaurant_staff rs
      where rs.owner_id = v_owner.id
        and rs.role = v_role
        and rs.user_id = staff.id;
    end loop;
  end if;
end;
$function$
$fn_sync_owner_staff_accounts$;

  -- synthetic_staff_email(integer,text)
  execute $fn_synthetic_staff_email$
CREATE OR REPLACE FUNCTION tables.synthetic_staff_email(p_owner_id integer, p_role text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'tables', 'extensions'
AS $function$
  select concat('staff+', p_owner_id::text, '.', replace(p_role, '_', ''), '@staff.local.tavolo');
$function$
$fn_synthetic_staff_email$;

  -- upsert_staff_account(up_users,text,boolean)
  execute $fn_upsert_staff_account$
CREATE OR REPLACE FUNCTION tables.upsert_staff_account(p_owner tables.up_users, p_role text, p_enabled boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'tables', 'extensions'
AS $function$
declare
  v_staff_id integer;
  v_username text;
  v_email text;
  v_active boolean;
begin
  v_username := tables.staff_username_for_role(p_owner.id, p_owner.username, p_role);
  v_email := tables.synthetic_staff_email(p_owner.id, p_role);

  select user_id into v_staff_id
  from tables.restaurant_staff
  where owner_id = p_owner.id
    and role = p_role
  limit 1;

  if v_staff_id is null then
    select id into v_staff_id
    from tables.up_users
    where username = v_username
    limit 1;
  end if;

  if v_staff_id is null then
    insert into tables.up_users (
      document_id,
      username,
      email,
      provider,
      password,
      confirmed,
      blocked,
      name,
      surname,
      staff_role,
      created_at,
      updated_at
    )
    values (
      replace(gen_random_uuid()::text, '-', ''),
      v_username,
      v_email,
      'local',
      p_owner.password,
      true,
      not p_enabled,
      coalesce(nullif(p_owner.name, ''), v_username),
      coalesce(nullif(p_owner.surname, ''), p_role),
      p_role,
      now(),
      now()
    )
    returning id into v_staff_id;
  else
    update tables.up_users
    set
      username = case
        when not exists (
          select 1
          from tables.up_users existing
          where existing.username = v_username
            and existing.id <> v_staff_id
        ) then v_username
        else username
      end,
      email = coalesce(nullif(email, ''), v_email),
      provider = coalesce(provider, 'local'),
      password = p_owner.password,
      confirmed = true,
      blocked = not p_enabled,
      staff_role = p_role,
      stripe_customer_id = null,
      stripe_subscription_id = null,
      subscription_status = null,
      subscription_plan = null,
      subscription_current_period_end = null,
      subscription_cancel_at_period_end = false,
      end_subscription = null,
      updated_at = now()
    where id = v_staff_id;
  end if;

  perform tables.ensure_owner_role_link(v_staff_id, p_owner.id);
  perform tables.copy_owner_auth_role_link(v_staff_id, p_owner.id);

  insert into tables.restaurant_staff (owner_id, user_id, role, active, display_name)
  values (p_owner.id, v_staff_id, p_role, true, v_username)
  on conflict (owner_id, user_id) do update
  set role = excluded.role,
      display_name = excluded.display_name;

  update tables.restaurant_staff
  set active = false
  where owner_id = p_owner.id
    and role = p_role
    and user_id <> v_staff_id;

  select active into v_active
  from tables.restaurant_staff
  where owner_id = p_owner.id
    and user_id = v_staff_id
  limit 1;

  update tables.up_users
  set blocked = not (coalesce(v_active, true) and p_enabled),
      updated_at = now()
  where id = v_staff_id;

  return v_staff_id;
end;
$function$
$fn_upsert_staff_account$;

  for v_table in select c.relname from pg_class c where c.relnamespace = 'tables'::regnamespace and c.relkind in ('r', 'p') loop
    execute format('alter table tables.%I enable row level security', v_table);
  end loop;

  for v_function in select p.oid::regprocedure from pg_proc p where p.pronamespace = 'tables'::regnamespace loop
    execute format('revoke all on function %s from public', v_function);
  end loop;

  -- anon e authenticated esistono su Supabase, non nel Postgres dei test.
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on all tables in schema tables from %I', v_role);
      execute format('revoke all on all sequences in schema tables from %I', v_role);
      execute format('revoke all on all functions in schema tables from %I', v_role);
    end if;
  end loop;

  -- Campanelli del realtime: le policy restano quelle di oggi; authenticated legge e vede lo schema.
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant usage on schema tables to authenticated';
    execute 'grant select on tables.order_realtime_events, tables.table_order_realtime_events to authenticated';
  end if;

  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and (select count(*) from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'tables'
             and tablename in ('order_realtime_events', 'table_order_realtime_events')) <> 2 then
    raise exception 'Le tabelle campanello non risultano nella publication supabase_realtime dopo lo spostamento: migrazione fermata.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end
$do$;

reset role;
