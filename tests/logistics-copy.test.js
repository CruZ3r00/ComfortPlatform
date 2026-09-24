'use strict'

// data-migrations/logistics-copy (ADR-0015 §15.13): il vecchio magazzino di ComforTables in ComfortLogistics. Sulle
// strutture reali di entrambe le parti: ComforTables com'era su staging (fixture del 2026-09-17, spostata in `tables`
// dalla 0008) e ComfortLogistics con le sue migrazioni 0001-0006 (fixture). Amministratore non superutente.

const { before, beforeEach, after, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { MIGRATIONS_DIR, startPostgres } = require('../testing')
const { apply } = require('../db/runner/runner')
const { stagingBeforePhase1 } = require('./helpers/comfortables')
const { ALIGNMENT_REASON, MIGRATION_ACTOR, copyLogistics, formatReport, normalizedName, cents, decimal } =
  require('../data-migrations/logistics-copy/copy')

const LOGISTICS_SCHEMA = fs.readFileSync(path.join(__dirname, 'fixtures', 'logistics-schema-0006.sql'), 'utf8')

// `tables.logistics_links` come la crea ComforTables (strapi/database/migrations/202609180001_logistics_bus.js).
const LINKS_DDL = `create table tables.logistics_links (
  id serial primary key, fk_user integer not null unique, organization_id uuid not null unique,
  state varchar(16) not null default 'inactive', activated_at timestamptz, deactivated_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  availability_version bigint not null default 0)`

const LEGACY_TABLES = [
  'ingredients', 'ingredients_fk_user_lnk', 'elements', 'elements_fk_user_lnk', 'element_ingredients',
  'element_ingredients_fk_element_lnk', 'element_ingredients_fk_ingredient_lnk', 'suppliers', 'suppliers_fk_user_lnk',
  'orders', 'order_items', 'restock_orders', 'restock_orders_fk_ingredient_lnk', 'restock_orders_fk_user_lnk',
  'inventory_movements', 'inventory_movements_fk_user_lnk', 'inventory_movements_fk_ingredient_lnk',
  'inventory_movements_fk_order_item_lnk', 'inventory_movements_fk_order_lnk', 'inventory_movements_fk_restock_order_lnk',
  'inventory_alerts', 'inventory_alerts_fk_user_lnk', 'logistics_links'
]

let server
let admin
const cleanups = []

async function asRole(role, sql, values = []) {
  await admin.query('begin')
  try {
    await admin.query(`set local role ${role}`)
    const result = await admin.query(sql, values)
    await admin.query('commit')
    return result.rows
  } catch (err) {
    await admin.query('rollback')
    throw err
  }
}
const legacy = (sql, values) => asRole('ct_app', sql, values)
const logistics = (sql, values) => asRole('cl_app', sql, values)

before(async () => {
  server = await startPostgres()
  // `stagingBeforePhase1` registra la pulizia della cartella temporanea delle migrazioni con `t.after`.
  const staging = await stagingBeforePhase1({ after: (fn) => cleanups.push(fn) }, server)
  admin = staging.admin
  await apply({ client: admin, dir: MIGRATIONS_DIR })
  await legacy(LINKS_DDL)
  await logistics(LOGISTICS_SCHEMA)
})
beforeEach(async () => {
  await legacy(`truncate ${LEGACY_TABLES.map((t) => `tables.${t}`).join(', ')} restart identity cascade`)
})
after(async () => {
  await admin?.end()
  await server?.stop()
  for (const fn of cleanups) fn()
})

/** Il ristorante di prova: tutti i casi della mappatura in un titolare. */
async function seedTrattoria(owner, organizationId, { linked = true } = {}) {
  const o = owner * 1000
  await legacy(`
    insert into tables.up_users (id, feature_grants_version) values (${owner}, 0) on conflict do nothing;
    insert into tables.ingredients (id, document_id, name, name_normalized, unit, unit_size, unit_label, stock_qty,
        low_stock_threshold, reorder_lead_days, unit_cost, is_active, is_addon, addon_avg_qty, supplier_name, allergens) values
      (${o + 1}, 'ing-mozz-${owner}', 'Mozzarella', 'mozzarella', 'kg', null, null, 2.50, 1.00, 3, 8, true, false, null, 'Caseificio Rossi', '["latte"]'),
      (${o + 2}, 'ing-pomo-${owner}', 'Pomodoro', 'pomodoro', 'g', null, null, 500, 0, 3, null, true, false, null, null, '[]'),
      (${o + 3}, 'ing-aper-${owner}', 'Aperol', 'aperol', 'l', 0.70, 'bottiglia', 1.40, 0, 2, 15, true, false, null, null, null),
      (${o + 4}, 'ing-panna-${owner}', 'Panna', 'panna', 'ml', null, null, 0, 0, 3, null, true, true, 30, null, null),
      (${o + 5}, 'ing-birra-${owner}', 'Birra Moretti', 'birra moretti', 'pz', null, null, 10, 0, 3, null, true, false, null, null, null),
      (${o + 6}, 'ing-liev-${owner}', 'Lievito', 'lievito', 'g', null, null, 100, 0, 0, null, true, false, null, null, null);
    insert into tables.ingredients_fk_user_lnk (ingredient_id, user_id)
      select id, ${owner} from tables.ingredients where id between ${o + 1} and ${o + 6};
    insert into tables.elements (id, document_id, name, category, price, is_beverage, is_beverage_advanced, is_archived) values
      (${o + 10}, 'el-marg-${owner}', 'Margherita', 'Pizze', 7, false, false, false),
      (${o + 11}, 'el-spritz-${owner}', 'Spritz', 'Cocktail', 6, true, true, false),
      (${o + 12}, 'el-birra-${owner}', 'Birra Moretti', 'Birre', 4, true, false, false),
      (${o + 13}, 'el-tira-${owner}', 'Tiramisù', 'Dolci', 5, false, false, false);
    insert into tables.elements_fk_user_lnk (element_id, user_id)
      select id, ${owner} from tables.elements where id between ${o + 10} and ${o + 13};
    insert into tables.element_ingredients (id, qty_per_serving, unit_override, is_public) values
      (${o + 20}, 0.12, null, true), (${o + 21}, 80, null, true), (${o + 22}, 5, null, false),
      (${o + 23}, 0.06, null, true), (${o + 24}, null, null, true);
    insert into tables.element_ingredients_fk_element_lnk (element_ingredient_id, element_id) values
      (${o + 20}, ${o + 10}), (${o + 21}, ${o + 10}), (${o + 22}, ${o + 10}), (${o + 23}, ${o + 11}), (${o + 24}, ${o + 13});
    insert into tables.element_ingredients_fk_ingredient_lnk (element_ingredient_id, ingredient_id) values
      (${o + 20}, ${o + 1}), (${o + 21}, ${o + 2}), (${o + 22}, ${o + 6}), (${o + 23}, ${o + 3}), (${o + 24}, ${o + 4});
    insert into tables.suppliers (id, name, category, phone, is_active) values (${o + 30}, 'Caseificio Rossi', 'Latticini', '051 000', true);
    insert into tables.suppliers_fk_user_lnk (supplier_id, user_id) values (${o + 30}, ${owner});
    insert into tables.orders (id, document_id) values (${o + 40}, 'ord-${owner}');
    insert into tables.order_items (id, document_id, source, table_order_item_revision, table_order_public_id)
      values (${o + 41}, 'item-${owner}', 'staff', 1, 'pub-${owner}');
    insert into tables.restock_orders (id, status, ordered_at, received_at, expected_qty, received_qty, cost, updated_at) values
      (${o + 50}, 'received', '2026-09-01 10:00', '2026-09-02 10:00', 2.10, 2.10, 45, '2026-09-02 10:00'),
      (${o + 51}, 'ordered', '2026-09-05 10:00', null, 5, null, null, '2026-09-05 10:00');
    insert into tables.restock_orders_fk_ingredient_lnk (restock_order_id, ingredient_id) values (${o + 50}, ${o + 3}), (${o + 51}, ${o + 1});
    insert into tables.restock_orders_fk_user_lnk (restock_order_id, user_id) values (${o + 50}, ${owner}), (${o + 51}, ${owner});
    insert into tables.inventory_movements (id, kind, qty_delta, qty_after, cost, reason, supplier, batch_id, created_at) values
      (${o + 60}, 'initial', 3, 3, null, null, null, null, '2026-09-01 08:00'),
      (${o + 61}, 'consumption', -0.50, 2.50, null, null, null, null, '2026-09-03 20:00'),
      (${o + 62}, 'restock', 2.10, 2.10, 45, null, 'Distillerie Nord', '8d1c7e2a-1111-4222-8333-444455556666', '2026-09-02 10:00'),
      (${o + 63}, 'consumption', -0.70, 1.40, null, null, null, null, '2026-09-04 21:00'),
      (${o + 64}, 'restock', 200, 200, null, null, null, 'lotto-a-mano', '2026-09-01 09:00'),
      (${o + 65}, 'restock', 24, 24, null, null, null, null, '2026-09-01 09:30'),
      (${o + 66}, 'adjustment', 500, 500, null, 'manual_adjustment', null, null, '2026-09-01 07:00'),
      (${o + 67}, 'adjustment', 0, 500, null, 'manual_adjustment', null, null, '2026-09-01 07:30'),
      (${o + 68}, 'consumption', -4, 10, null, null, null, null, '2026-09-06 20:00');
    insert into tables.inventory_movements_fk_user_lnk (inventory_movement_id, user_id)
      select id, ${owner} from tables.inventory_movements where id between ${o + 60} and ${o + 68};
    insert into tables.inventory_movements_fk_ingredient_lnk (inventory_movement_id, ingredient_id) values
      (${o + 60}, ${o + 1}), (${o + 61}, ${o + 1}), (${o + 62}, ${o + 3}), (${o + 63}, ${o + 3}), (${o + 64}, ${o + 6}),
      (${o + 65}, ${o + 5}), (${o + 66}, ${o + 2}), (${o + 67}, ${o + 2}), (${o + 68}, ${o + 5});
    insert into tables.inventory_movements_fk_order_item_lnk (inventory_movement_id, order_item_id) values (${o + 61}, ${o + 41});
    insert into tables.inventory_movements_fk_order_lnk (inventory_movement_id, order_id) values (${o + 61}, ${o + 40});
    insert into tables.inventory_movements_fk_restock_order_lnk (inventory_movement_id, restock_order_id) values (${o + 62}, ${o + 50});
    insert into tables.inventory_alerts (id, alert_type, level, ingredients_payload, acknowledged_at, dismissed_by_restock, created_at) values
      (${o + 70}, 'threshold', 'warning', '[{"fk_ingredient": ${o + 1}, "name": "Mozzarella", "stock_qty": 2.5, "unit": "kg", "threshold": 3, "level": "warning"}]', null, false, '2026-09-05 12:00'),
      (${o + 71}, 'predictive', 'critical', '[{"fk_ingredient": ${o + 3}, "name": "Aperol", "stock_qty": 1.4}]', '2026-09-05 13:00', false, '2026-09-05 12:30');
    insert into tables.inventory_alerts_fk_user_lnk (inventory_alert_id, user_id) values (${o + 70}, ${owner}), (${o + 71}, ${owner});`)
  if (linked) {
    await legacy('insert into tables.logistics_links (fk_user, organization_id) values ($1, $2)', [owner, organizationId])
  }
}

const org = (n) => `a1b2c3d4-${String(n).padStart(4, '0')}-4222-8333-444455556666`
const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]))
const NOW = new Date('2026-09-24T12:00:00Z')

test('unita\' e fattori: centesimi esatti, normalizzazione di ComfortLogistics', () => {
  assert.equal(decimal(cents('0.35') * 1000), '350.00')
  assert.equal(decimal(cents('-0.70') * 1000), '-700.00')
  assert.equal(cents('12.50'), 1250)
  assert.throws(() => cents('1.234'), /due decimali/)
  assert.equal(normalizedName('  Caffè   Espresso '), 'caffe espresso')
})

test('copia completa: articoli, giacenze, movimenti, riordini, ricette, alert, catalogo e collegamento', async () => {
  const owner = 81
  await seedTrattoria(owner, org(81))
  // Un titolare senza magazzino non conta: nessuna organizzazione richiesta.
  await legacy(`insert into tables.up_users (id, feature_grants_version) values (99, 0) on conflict do nothing;
    insert into tables.ingredients (id, document_id, name, unit, stock_qty, is_active) values (99001, 'ing-altro', 'Sale', 'g', 0, true);
    insert into tables.ingredients_fk_user_lnk (ingredient_id, user_id) values (99001, 99)`)

  const { committed, report } = await copyLogistics({ client: admin, commit: true, now: NOW })
  assert.equal(committed, true)
  assert.deepEqual(report.map((e) => [e.owner, e.outcome]), [[owner, 'copiata']])
  const [entry] = report
  assert.deepEqual(entry.problems, [])
  assert.equal(entry.notes.alignments, 2)
  assert.equal(entry.notes.zeroMovementsOmitted, 1)
  assert.equal(entry.notes.suppliersFromNames, 1)
  assert.equal(entry.notes.batchDropped, 1)
  assert.equal(entry.notes.leadDaysDropped, 1)
  assert.equal(entry.notes.beveragesMatched, 1)
  assert.match(formatReport(report), /titolare 81 → organizzazione .*: copiata/)

  const o = org(81)
  const articles = byName(await logistics(`select a.*, s.quantity, s.ever_restocked, p.name as supplier from logistics.articles a
    join logistics.stock s on s.article_id = a.id left join logistics.suppliers p on p.id = a.supplier_id
    where a.organization_id = $1`, [o]))
  assert.deepEqual(Object.keys(articles).sort(), ['Aperol', 'Birra Moretti', 'Lievito', 'Mozzarella', 'Panna', 'Pomodoro'])
  // kg → g: giacenza, soglia e costo medio (il costo per kg diventa per grammo).
  assert.deepEqual([articles.Mozzarella.unit, articles.Mozzarella.quantity, articles.Mozzarella.low_stock_threshold,
    articles.Mozzarella.avg_unit_cost, articles.Mozzarella.supplier], ['g', '2500.000000', '1000.000000', '0.00800000', 'Caseificio Rossi'])
  // l → ml, con il formato della bottiglia.
  assert.deepEqual([articles.Aperol.unit, articles.Aperol.quantity, articles.Aperol.pack_size, articles.Aperol.pack_label,
    articles.Aperol.avg_unit_cost], ['ml', '1400.000000', '700.000000', 'bottiglia', '0.01500000'])
  assert.equal(articles.Lievito.reorder_lead_days, null)
  assert.equal(articles.Mozzarella.reorder_lead_days, '3.00')
  // Mai rifornito: una rettifica non conta.
  assert.deepEqual(Object.fromEntries(Object.values(articles).map((a) => [a.name, a.ever_restocked])),
    { Mozzarella: true, Pomodoro: false, Aperol: true, Panna: false, 'Birra Moretti': true, Lievito: true })

  const suppliers = await logistics('select name, notes, phone from logistics.suppliers where organization_id = $1 order by name', [o])
  assert.deepEqual(suppliers, [
    { name: 'Caseificio Rossi', notes: 'Categoria: Latticini', phone: '051 000' },
    { name: 'Distillerie Nord', notes: null, phone: null }
  ])

  const movements = await logistics(`select a.name, m.kind, m.quantity, m.stock_before, m.stock_after, m.cost, m.reason,
      m.source_ref, m.batch_id, m.created_by, m.purchase_order_id, p.name as supplier
    from logistics.movements m join logistics.articles a on a.id = m.article_id
    left join logistics.suppliers p on p.id = m.supplier_id
    where m.organization_id = $1 order by a.name, m.occurred_at`, [o])
  assert.equal(movements.length, 10)
  assert.ok(movements.every((m) => m.created_by === MIGRATION_ACTOR))
  const mozz = movements.filter((m) => m.name === 'Mozzarella')
  assert.deepEqual(mozz.map((m) => [m.kind, m.quantity, m.stock_before, m.stock_after, m.source_ref]), [
    ['initial', '3000.000000', '0.000000', '3000.000000', null],
    ['consumption', '-500.000000', '3000.000000', '2500.000000', 'item-81']
  ])
  const aperolRestock = movements.find((m) => m.name === 'Aperol' && m.kind === 'restock')
  assert.deepEqual([aperolRestock.quantity, aperolRestock.cost, aperolRestock.supplier, aperolRestock.batch_id],
    ['2100.000000', '45.000000', 'Distillerie Nord', '8d1c7e2a-1111-4222-8333-444455556666'])
  // Il lievito e' sceso da 200 a 100 senza movimento: un allineamento lo racconta.
  const lievito = movements.filter((m) => m.name === 'Lievito')
  assert.deepEqual(lievito.map((m) => [m.kind, m.quantity, m.stock_after, m.reason]), [
    ['restock', '200.000000', '200.000000', null],
    ['adjustment', '-100.000000', '100.000000', ALIGNMENT_REASON]
  ])
  // La birra e' scesa a mano da 24 a 14 prima di un consumo: l'allineamento sta nel mezzo della catena.
  const birra = movements.filter((m) => m.name === 'Birra Moretti')
  assert.deepEqual(birra.map((m) => [m.kind, m.quantity, m.stock_before, m.stock_after]), [
    ['restock', '24.000000', '0.000000', '24.000000'],
    ['adjustment', '-10.000000', '24.000000', '14.000000'],
    ['consumption', '-4.000000', '14.000000', '10.000000']
  ])
  // Il movimento a zero del pomodoro non c'e'.
  assert.equal(movements.filter((m) => m.name === 'Pomodoro').length, 1)

  const orders = await logistics(`select po.state, po.quantity_expected, po.quantity_received, po.movement_id, m.kind as movement_kind
    from logistics.purchase_orders po left join logistics.movements m on m.id = po.movement_id
    where po.organization_id = $1 order by po.ordered_at`, [o])
  assert.deepEqual(orders.map((r) => [r.state, r.quantity_expected, r.quantity_received, r.movement_kind]), [
    ['received', '2100.000000', '2100.000000', 'restock'],
    ['ordered', '5000.000000', null, null]
  ])
  assert.equal(aperolRestock.purchase_order_id !== null, true)

  const recipes = await logistics(`select r.target, r.source_ref, a.name, l.quantity, l.input_unit, v.created_by, v.valid_from
    from logistics.recipes r join logistics.recipe_versions v on v.recipe_id = r.id
    join logistics.recipe_lines l on l.version_id = v.id join logistics.articles a on a.id = l.article_id
    where r.organization_id = $1 order by r.source_ref, a.name`, [o])
  assert.deepEqual(recipes.map((r) => [r.target, r.source_ref, r.name, r.quantity, r.input_unit]), [
    ['beverage', 'el-birra-81', 'Birra Moretti', '1.000000', 'pz'],
    ['dish', 'el-marg-81', 'Lievito', '5.000000', 'g'],
    ['dish', 'el-marg-81', 'Mozzarella', '120.000000', 'kg'],
    ['dish', 'el-marg-81', 'Pomodoro', '80.000000', 'g'],
    ['beverage', 'el-spritz-81', 'Aperol', '60.000000', 'l'],
    ['addon', 'ing-panna-81', 'Panna', '30.000000', 'ml']
  ])
  assert.ok(recipes.every((r) => r.created_by === 'migration' && r.valid_from === -Infinity))

  const items = await logistics(`select kind, source_ref, import_state, allergens, ingredient_refs from logistics.source_items
    where organization_id = $1 order by kind, source_ref`, [o])
  assert.deepEqual(items.filter((i) => i.kind === 'dish').map((i) => [i.source_ref, i.import_state]), [
    ['el-birra-81', 'linked'], ['el-marg-81', 'linked'], ['el-spritz-81', 'linked'], ['el-tira-81', 'new']
  ])
  // Solo gli ingredienti pubblici del piatto: il lievito e' di sola preparazione.
  assert.deepEqual(items.find((i) => i.source_ref === 'el-marg-81').ingredient_refs, ['ing-mozz-81', 'ing-pomo-81'])
  assert.deepEqual(items.find((i) => i.source_ref === 'ing-mozz-81').allergens, ['latte'])
  assert.equal((await logistics('select count(*)::int as n from logistics.ingredient_links where organization_id = $1', [o]))[0].n, 6)

  const alerts = await logistics(`select a.kind, a.level, a.stock_qty, a.threshold, r.name from logistics.alerts a
    join logistics.articles r on r.id = a.article_id where a.organization_id = $1`, [o])
  assert.deepEqual(alerts, [{ kind: 'threshold', level: 'warning', stock_qty: '2500.000000', threshold: '3000.000000', name: 'Mozzarella' }])

  assert.deepEqual(await logistics('select state from logistics.links where organization_id = $1', [o]), [{ state: 'active' }])
  assert.deepEqual(await legacy('select state from tables.logistics_links where fk_user = $1', [owner]), [{ state: 'active' }])

  // Seconda esecuzione: gia' copiata, nulla di nuovo.
  const again = await copyLogistics({ client: admin, commit: true, now: NOW })
  assert.deepEqual(again.report.map((e) => [e.owner, e.outcome]), [[owner, 'gia\' copiata']])
  assert.equal((await logistics('select count(*)::int as n from logistics.movements where organization_id = $1', [o]))[0].n, 10)
})

test('prova: stesso piano e stesse verifiche, nulla resta scritto', async () => {
  await seedTrattoria(82, org(82))
  const { committed, report } = await copyLogistics({ client: admin, now: NOW })
  assert.equal(committed, false)
  assert.equal(report[0].outcome, 'copiata (prova)')
  assert.deepEqual(await logistics('select id from logistics.articles where organization_id = $1', [org(82)]), [])
  assert.deepEqual(await logistics('select id from logistics.organizations where id = $1', [org(82)]), [])
  assert.deepEqual(await legacy('select state from tables.logistics_links where fk_user = 82'), [{ state: 'inactive' }])
})

test('anomalie: la copia si ferma con l\'elenco completo e non scrive niente', async () => {
  await seedTrattoria(83, org(83))
  // Due ingredienti che in ComfortLogistics avrebbero lo stesso nome, e una dose in un'unita' di un'altra grandezza.
  await legacy(`insert into tables.ingredients (id, document_id, name, unit, stock_qty, is_active) values (83901, 'ing-dup', 'mozzarella ', 'g', 1, true);
    insert into tables.ingredients_fk_user_lnk (ingredient_id, user_id) values (83901, 83);
    update tables.element_ingredients set unit_override = 'pz' where id = 83021`)
  // Un titolare con magazzino e senza organizzazione.
  await seedTrattoria(84, org(84), { linked: false })

  await assert.rejects(copyLogistics({ client: admin, commit: true, now: NOW }), (err) => {
    assert.equal(err.code, 'LOGISTICS_COPY_STOPPED')
    assert.match(err.message, /senza organizzazione.*84/)
    return true
  })
  await legacy('delete from tables.inventory_movements_fk_user_lnk where user_id = 84; delete from tables.ingredients_fk_user_lnk where user_id = 84; delete from tables.suppliers_fk_user_lnk where user_id = 84; delete from tables.restock_orders_fk_user_lnk where user_id = 84; delete from tables.inventory_alerts_fk_user_lnk where user_id = 84; delete from tables.elements_fk_user_lnk where user_id = 84')
  await assert.rejects(copyLogistics({ client: admin, commit: true, now: NOW }), (err) => {
    assert.match(err.message, /due ingredienti con lo stesso nome: «Mozzarella» e «mozzarella»/)
    assert.match(err.message, /«Margherita»: dose di «Pomodoro» in pz, articolo in g/)
    assert.match(err.message, /Nulla e' stato scritto/)
    return true
  })
  assert.deepEqual(await logistics('select id from logistics.articles where organization_id = $1', [org(83)]), [])
})

test('un magazzino gia\' creato a mano in ComfortLogistics ferma la copia', async () => {
  await seedTrattoria(85, org(85))
  await logistics(`insert into logistics.organizations (id) values ($1);
    insert into logistics.articles (id, organization_id, name, name_normalized, unit)
      values ('b0000000-0000-4000-8000-000000000085', $1, 'Farina', 'farina', 'g')`.replace(/\$1/g, `'${org(85)}'`))
  await assert.rejects(copyLogistics({ client: admin, commit: true, now: NOW }), /ha gia' articoli creati in ComfortLogistics/)
})
