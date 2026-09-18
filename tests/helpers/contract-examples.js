'use strict'

/** Payload validi di esempio per ogni argomento del contratto v1, condivisi dai test. */

const ORG = '6f1c1d52-3f5e-4a0e-9d7b-2d6c1b9b0a11'
const PERSON = '0b6f2f8e-8f2a-4b0e-9a55-3c1f0a7d2e10'
const REQUEST = 'c3d5a1e2-7b8f-4c6d-9e0a-1b2c3d4e5f60'
const JWE = 'eyJhbGciOiJFQ0RILUVTK0EyNTZLVyIsImVuYyI6IkEyNTZHQ00ifQ.a2V5.aXY.Y2lwaGVy.dGFn'

const dish = { dish_ref: 'd1', version: 3, name: 'Margherita', category: 'Pizze', price: 8.5, is_beverage: false,
  is_beverage_advanced: false, is_archived: false, ingredient_refs: ['i1', 'i2'] }
// Lo stesso piatto senza il campo facoltativo: un produttore che non lo invia resta valido.
const dishWithoutIngredients = { ...dish, ingredient_refs: undefined }
delete dishWithoutIngredients.ingredient_refs
const ingredient = { ingredient_ref: 'i1', version: 2, name: 'Mozzarella', allergens: ['latte'], is_addon: true, is_archived: false }
// Annullo che descrive anche l'item: serve a scartare dalla ricetta un piatto preparato e
// mai servito, di cui il destinatario non ha ricevuto alcun item_served. I campi sono
// facoltativi, quindi l'esempio del catalogo resta quello minimo (ADR-0015 §15.6).
const itemVoidedWithItem = {
  item_ref: 'it2', order_ref: 'o1', disposition: 'waste', previous_status: 'ready',
  dish_ref: 'd1', freeform_name: null, quantity: 2, is_beverage: false,
  removed_ingredient_refs: ['i2'], addon_ingredient_refs: ['i1']
}
const alertRow = { article_ref: 'a1', name: 'Mozzarella', unit: 'g', stock_qty: 500, days_to_depletion: 1.5, threshold: null, level: 'warning' }

/** Un payload valido per ogni argomento del catalogo. */
const VALID = {
  'tables.catalog.dish_changed': dish,
  'tables.catalog.ingredient_changed': ingredient,
  'tables.catalog.snapshot': { chunk_index: 0, chunk_count: 2, dishes: [dish], ingredients: [ingredient] },
  'tables.sales.item_served': {
    item_ref: 'it1', order_ref: 'o1', dish_ref: 'd1', freeform_name: null, quantity: 2, is_beverage: false,
    removed_ingredient_refs: ['i2'], addon_ingredient_refs: [], service_type: 'table'
  },
  'tables.sales.item_voided': { item_ref: 'it1', order_ref: 'o1', disposition: 'waste', previous_status: 'served' },
  'tables.bar.reload_done': {
    shift_ref: 's1', opened_at: '2026-09-17T18:00:00Z', closed_at: '2026-09-18T01:00:00Z', beverages: [{ dish_ref: 'b1', served_count: 12 }]
  },
  'tables.bar.preview_requested': { shift_ref: 's1', beverages: [{ dish_ref: 'b1', served_count: 12 }] },
  'tables.alerts.acknowledge_requested': { alert_refs: ['al1'], acknowledged_by: { person_id: null, display_name: 'Ristorante.cucina' } },
  'logistics.link_changed': { status: 'active' },
  'logistics.catalog.snapshot_requested': {},
  'logistics.availability.changed': {
    dishes: [{ dish_ref: 'd1', available: false }], menu_ingredients: [{ ingredient_ref: 'i1', available: false, in_stock: false }],
    reason: 'movimento', version: 7
  },
  'logistics.alerts.updated': {
    version: 4, unarchived_count: 1, groups: [{ type: 'threshold', level: 'warning', alert_refs: ['al1'], rows: [alertRow] }]
  },
  'logistics.bar.preview_ready': {
    shift_ref: 's1', articles: [{ article_ref: 'a2', name: 'Gin', quantity: 700, unit: 'ml', pack_size: 700, pack_label: 'bottiglia', packs_opened: 1 }]
  },
  'logistics.notifications.email_requested': {
    recipient_email: 'titolare@example.com', kind: 'inventory_alert', alert_type: 'predictive', level: 'critical', rows: [alertRow]
  },
  'account.provisioning_requested': {
    person_id: PERSON, plan_code: 'comfortables_pro', owner_email: 'titolare@example.com', owner_name: 'Mario Rossi', staff_default_password_hash: JWE
  },
  'account.entitlements_changed': {
    version: 5, active: true, plan_code: 'comfortables_custom', period_end: '2026-10-17T00:00:00Z',
    products: [{ product: 'comfortables', config: { tier: 'custom', custom_quota: 2 } }, { product: 'logistics', config: {} }],
    feature_selections: ['table.self_service']
  },
  'account.password_changed': { person_id: PERSON, staff_default_password_hash: JWE },
  'account.organization_changed': { legal_name: 'Trattoria Srl', vat_number: 'IT01234567890', deleted_at: null },
  'account.session_ended': { person_id: PERSON, session_id: 'sess_1' },
  'account.person_changed': { person_id: PERSON, email: 'nuova@example.com', first_name: 'Mario', last_name: null },
  'platform.clock.daily': { date: '2026-09-17' }
}

module.exports = { ORG, PERSON, REQUEST, JWE, dish, dishWithoutIngredients, ingredient, itemVoidedWithItem, alertRow, VALID }
