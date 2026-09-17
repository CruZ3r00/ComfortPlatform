-- Rollback di 0009 e 0008: ComforTables torna in public come prima della Fase 1, public torna all'amministratore.
--
-- ADR-0014 §14.3 «Rollback»: migrazione inversa. Si esegue come amministratore in una transazione con
-- `node db/rollback/apply.js <questo file> --env <ambiente>`, che alla fine toglie 0009 e 0008 dal registro.
-- Si ferma se in public ci sono gia' oggetti del sito (copia gia' fatta): quelli vanno tolti prima, a mano.
--
-- L'amministratore riceve per questa transazione anche INHERIT su ct_app e cs_site, perche' deve cambiare proprieta' di
-- oggetti che non sono suoi; alla fine torna a SET senza INHERIT.
-- Corpi, configurazione e permessi delle funzioni sono quelli di staging del 2026-09-17; le 19 tabelle che allora non
-- avevano RLS la perdono di nuovo. Unica differenza voluta: su staging emit_order_realtime_event e
-- purge_table_order_realtime_events hanno il corpo con fine riga CRLF, qui LF (.gitattributes fissa eol=lf sui .sql).

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
  v_without_rls constant text[] := array[
    'customer_messages',
    'customer_messages_fk_order_lnk',
    'customer_messages_fk_time_proposal_lnk',
    'customer_messages_fk_user_lnk',
    'feature_rollout_events',
    'feature_rollout_owners',
    'feature_rollouts',
    'menu_import_jobs',
    'menu_import_jobs_fk_user_lnk',
    'menu_import_leases',
    'table_order_access_points',
    'table_order_commands',
    'table_order_participants',
    'table_order_rate_limits',
    'table_order_service_requests',
    'table_order_sessions',
    'takeaway_time_proposals',
    'takeaway_time_proposals_fk_order_lnk',
    'takeaway_time_proposals_fk_user_lnk'
  ];
  v_item text;
  v_function oid;
begin
  if exists (select 1 from pg_class where relnamespace = 'public'::regnamespace)
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace) then
    raise exception 'In public ci sono gia'' oggetti (il sito?): rollback fermato.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if (select count(*) from pg_class c where c.relnamespace = to_regnamespace('tables') and c.relkind in ('r', 'p') and c.relname = any(v_tables)) <> 160
     or (select count(*) from pg_proc p where p.pronamespace = to_regnamespace('tables') and p.proname = any(v_functions)) <> 21 then
    raise exception 'ComforTables non e'' interamente nello schema tables: rollback fermato.'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  execute format('grant ct_app to %I with inherit true, set true', current_user);
  execute format('grant cs_site to %I with inherit true, set true', current_user);

  -- 0009: public all'amministratore, con i permessi di prima (nessuno oltre al proprietario).
  execute format('alter schema public owner to %I', current_user);
  execute 'alter default privileges for role cs_site grant execute on functions to public';

  -- 0008: tabelle e funzioni in public, all'amministratore.
  foreach v_item in array v_tables loop
    execute format('alter table tables.%I set schema public', v_item);
    execute format('alter table public.%I owner to %I', v_item, current_user);
  end loop;
  for v_function in select p.oid from pg_proc p where p.pronamespace = 'tables'::regnamespace and p.proname = any(v_functions) loop
    execute format('alter function %s set schema public', v_function::regprocedure);
    execute format('alter function %s owner to %I', v_function::regprocedure, current_user);
    execute format('grant execute on function %s to public', v_function::regprocedure);
  end loop;
  foreach v_item in array v_without_rls loop
    execute format('alter table public.%I disable row level security', v_item);
  end loop;
  execute 'alter default privileges for role ct_app grant execute on functions to public';

  -- classify_staff_role_for_category(text)
  execute $fn_classify_staff_role_for_category$
CREATE OR REPLACE FUNCTION public.classify_staff_role_for_category(p_category text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
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
CREATE OR REPLACE FUNCTION public.copy_owner_auth_role_link(p_staff_id integer, p_owner_id integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_role_id integer;
begin
  if to_regclass('public.up_users_role_lnk') is null then
    return;
  end if;

  select role_id into v_role_id
  from public.up_users_role_lnk
  where user_id = p_owner_id
  limit 1;

  if v_role_id is not null then
    insert into public.up_users_role_lnk (user_id, role_id)
    values (p_staff_id, v_role_id)
    on conflict do nothing;
  end if;
end;
$function$
$fn_copy_owner_auth_role_link$;

  -- emit_order_realtime_event()
  execute $fn_emit_order_realtime_event$
CREATE OR REPLACE FUNCTION public.emit_order_realtime_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
      from public.order_items_fk_order_lnk l
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
      from public.tables_fk_user_lnk l
     where l.table_id = v_source_id
     limit 1;
  elsif TG_TABLE_NAME = 'reservations' then
    v_source_id := coalesce(NEW.id, OLD.id);

    select l.user_id
      into v_user_id
      from public.reservations_fk_user_lnk l
     where l.reservation_id = v_source_id
     limit 1;
  else
    return coalesce(NEW, OLD);
  end if;

  if v_user_id is null and v_order_id is not null then
    select l.user_id
      into v_user_id
      from public.orders_fk_user_lnk l
     where l.order_id = v_order_id
     limit 1;
  end if;

  if v_user_id is not null then
    insert into public.order_realtime_events (user_id, source_table, source_id, event_type)
    values (v_user_id, TG_TABLE_NAME, v_source_id, TG_OP);
  end if;

  delete from public.order_realtime_events
   where created_at < now() - interval '1 day';

  return coalesce(NEW, OLD);
end;
$function$
$fn_emit_order_realtime_event$;

  -- enforce_unique_ingredient_on_rename()
  execute $fn_enforce_unique_ingredient_on_rename$
CREATE OR REPLACE FUNCTION public.enforce_unique_ingredient_on_rename()
 RETURNS trigger
 LANGUAGE plpgsql
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
CREATE OR REPLACE FUNCTION public.enforce_unique_ingredient_per_owner()
 RETURNS trigger
 LANGUAGE plpgsql
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
CREATE OR REPLACE FUNCTION public.enforce_unique_table_number_on_renumber()
 RETURNS trigger
 LANGUAGE plpgsql
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
CREATE OR REPLACE FUNCTION public.enforce_unique_table_number_per_owner()
 RETURNS trigger
 LANGUAGE plpgsql
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
CREATE OR REPLACE FUNCTION public.ensure_owner_role_link(p_staff_id integer, p_owner_id integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  if to_regclass('public.up_users_fk_owner_lnk') is not null then
    insert into public.up_users_fk_owner_lnk (user_id, inv_user_id)
    values (p_staff_id, p_owner_id)
    on conflict do nothing;
  end if;
end;
$function$
$fn_ensure_owner_role_link$;

  -- ensure_restaurant_category_routing(integer,text)
  execute $fn_ensure_restaurant_category_routing$
CREATE OR REPLACE FUNCTION public.ensure_restaurant_category_routing(p_owner_id integer, p_category text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_category text := nullif(btrim(coalesce(p_category, '')), '');
  v_role text;
begin
  if p_owner_id is null or v_category is null then
    return;
  end if;

  v_role := public.classify_staff_role_for_category(v_category);

  insert into public.restaurant_category_routing (owner_id, category, staff_role, locked)
  values (p_owner_id, v_category, v_role, false)
  on conflict (owner_id, category_key) do nothing;
end;
$function$
$fn_ensure_restaurant_category_routing$;

  -- is_active_tavolo_subscription(text,timestamp with time zone,date)
  execute $fn_is_active_tavolo_subscription$
CREATE OR REPLACE FUNCTION public.is_active_tavolo_subscription(p_status text, p_period_end timestamp with time zone, p_end_subscription date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
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
CREATE OR REPLACE FUNCTION public.owner_has_feature(p_owner_id integer, p_feature_code text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  with owner_row as (
    select *
    from public.up_users u
    where u.id = p_owner_id
      and public.is_active_tavolo_subscription(
        u.subscription_status,
        u.subscription_current_period_end,
        u.end_subscription
      )
  ),
  wanted as (
    select fd.code, fd.professional_enabled
    from public.feature_definitions fd
    where fd.code = p_feature_code
      and fd.status in ('active', 'hidden', 'deprecated')
      and coalesce(fd.system_only, false) = false
  ),
  active_grants as (
    select g.feature_code
    from public.owner_feature_grants g
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
CREATE OR REPLACE FUNCTION public.owner_has_production_routing(p_owner_id integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select public.owner_has_feature(p_owner_id, 'production.department_routing');
$function$
$fn_owner_has_production_routing$;

  -- purge_table_order_realtime_events(interval)
  execute $fn_purge_table_order_realtime_events$
CREATE OR REPLACE FUNCTION public.purge_table_order_realtime_events(p_older_than interval DEFAULT '01:00:00'::interval)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_deleted integer;
begin
  delete from public.table_order_realtime_events
  where created_at < now() - p_older_than;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$
$fn_purge_table_order_realtime_events$;

  -- route_category_from_element_link()
  execute $fn_route_category_from_element_link$
CREATE OR REPLACE FUNCTION public.route_category_from_element_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_category text;
begin
  select category into v_category
  from public.elements
  where id = new.element_id;

  perform public.ensure_restaurant_category_routing(new.user_id, v_category);
  return new;
end;
$function$
$fn_route_category_from_element_link$;

  -- route_category_from_element_update()
  execute $fn_route_category_from_element_update$
CREATE OR REPLACE FUNCTION public.route_category_from_element_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_owner_id integer;
begin
  if new.category is null or new.category is not distinct from old.category then
    return new;
  end if;

  if to_regclass('public.elements_fk_user_lnk') is not null then
    select user_id into v_owner_id
    from public.elements_fk_user_lnk
    where element_id = new.id
    limit 1;
  end if;

  perform public.ensure_restaurant_category_routing(v_owner_id, new.category);
  return new;
end;
$function$
$fn_route_category_from_element_update$;

  -- set_restaurant_staff_updated_at()
  execute $fn_set_restaurant_staff_updated_at$
CREATE OR REPLACE FUNCTION public.set_restaurant_staff_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
$fn_set_restaurant_staff_updated_at$;

  -- staff_username_for_role(integer,text,text)
  execute $fn_staff_username_for_role$
CREATE OR REPLACE FUNCTION public.staff_username_for_role(p_owner_id integer, p_owner_username text, p_role text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
declare
  v_restaurant_name text;
  v_base text;
begin
  if to_regclass('public.website_configs') is not null
     and to_regclass('public.website_configs_fk_user_lnk') is not null then
    select wc.restaurant_name into v_restaurant_name
    from public.website_configs wc
    join public.website_configs_fk_user_lnk lnk on lnk.website_config_id = wc.id
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
CREATE OR REPLACE FUNCTION public.sync_owner_staff_accounts_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if coalesce(new.staff_role, 'owner') = 'owner' then
    perform public.sync_owner_staff_accounts(new.id);
  end if;
  return new;
end;
$function$
$fn_sync_owner_staff_accounts_trigger$;

  -- sync_owner_staff_accounts(integer)
  execute $fn_sync_owner_staff_accounts$
CREATE OR REPLACE FUNCTION public.sync_owner_staff_accounts(p_owner_id integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_owner public.up_users%rowtype;
  v_has_subscription boolean;
  v_has_production_routing boolean;
  v_core_staff boolean;
  v_role text;
begin
  select * into v_owner
  from public.up_users
  where id = p_owner_id;

  if not found then
    return;
  end if;

  if coalesce(v_owner.staff_role, 'owner') <> 'owner' then
    return;
  end if;

  v_has_subscription := public.is_active_tavolo_subscription(
    v_owner.subscription_status,
    v_owner.subscription_current_period_end,
    v_owner.end_subscription
  );

  if not v_has_subscription then
    update public.up_users staff
    set blocked = true,
        updated_at = now()
    from public.restaurant_staff rs
    where rs.owner_id = v_owner.id
      and rs.user_id = staff.id;
    return;
  end if;

  v_core_staff := coalesce(v_owner.subscription_plan, '') in ('starter', 'pro', 'custom');
  v_has_production_routing := public.owner_has_feature(v_owner.id, 'production.department_routing');

  perform public.upsert_staff_account(v_owner, 'cameriere', v_core_staff);
  update public.restaurant_staff
  set active = true
  where owner_id = v_owner.id
    and role = 'cameriere';

  perform public.upsert_staff_account(v_owner, 'cucina', v_core_staff);

  update public.up_users staff
  set blocked = not (rs.active and v_core_staff),
      updated_at = now()
  from public.restaurant_staff rs
  where rs.owner_id = v_owner.id
    and rs.role in ('cameriere', 'cucina')
    and rs.user_id = staff.id;

  update public.up_users staff
  set blocked = not (rs.active and v_core_staff),
      updated_at = now()
  from public.restaurant_staff rs
  where rs.owner_id = v_owner.id
    and rs.role = 'gestione'
    and rs.user_id = staff.id;

  if v_has_production_routing then
    perform public.upsert_staff_account(v_owner, 'bar', true);
    perform public.upsert_staff_account(v_owner, 'pizzeria', true);
    perform public.upsert_staff_account(v_owner, 'cucina_sg', true);
  else
    for v_role in select unnest(array['bar', 'pizzeria', 'cucina_sg'])
    loop
      update public.up_users staff
      set blocked = true,
          updated_at = now()
      from public.restaurant_staff rs
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
CREATE OR REPLACE FUNCTION public.synthetic_staff_email(p_owner_id integer, p_role text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select concat('staff+', p_owner_id::text, '.', replace(p_role, '_', ''), '@staff.local.tavolo');
$function$
$fn_synthetic_staff_email$;

  -- upsert_staff_account(up_users,text,boolean)
  execute $fn_upsert_staff_account$
CREATE OR REPLACE FUNCTION public.upsert_staff_account(p_owner up_users, p_role text, p_enabled boolean)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  v_staff_id integer;
  v_username text;
  v_email text;
  v_active boolean;
begin
  v_username := public.staff_username_for_role(p_owner.id, p_owner.username, p_role);
  v_email := public.synthetic_staff_email(p_owner.id, p_role);

  select user_id into v_staff_id
  from public.restaurant_staff
  where owner_id = p_owner.id
    and role = p_role
  limit 1;

  if v_staff_id is null then
    select id into v_staff_id
    from public.up_users
    where username = v_username
    limit 1;
  end if;

  if v_staff_id is null then
    insert into public.up_users (
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
    update public.up_users
    set
      username = case
        when not exists (
          select 1
          from public.up_users existing
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

  perform public.ensure_owner_role_link(v_staff_id, p_owner.id);
  perform public.copy_owner_auth_role_link(v_staff_id, p_owner.id);

  insert into public.restaurant_staff (owner_id, user_id, role, active, display_name)
  values (p_owner.id, v_staff_id, p_role, true, v_username)
  on conflict (owner_id, user_id) do update
  set role = excluded.role,
      display_name = excluded.display_name;

  update public.restaurant_staff
  set active = false
  where owner_id = p_owner.id
    and role = p_role
    and user_id <> v_staff_id;

  select active into v_active
  from public.restaurant_staff
  where owner_id = p_owner.id
    and user_id = v_staff_id
  limit 1;

  update public.up_users
  set blocked = not (coalesce(v_active, true) and p_enabled),
      updated_at = now()
  where id = v_staff_id;

  return v_staff_id;
end;
$function$
$fn_upsert_staff_account$;

  execute 'drop schema tables';

  execute format('grant ct_app to %I with inherit false, set true', current_user);
  execute format('grant cs_site to %I with inherit false, set true', current_user);

  delete from platform.migrations where name in ('0008_comfortables_tables_schema.sql', '0009_site_public_schema.sql');
end
$$;
