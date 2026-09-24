#!/usr/bin/env node
'use strict'

/**
 * Copia del magazzino di ComforTables in ComfortLogistics (ADR-0015 §15.13): dal vecchio magazzino in `tables` alle
 * tabelle di ComfortLogistics in `logistics`, nello stesso database.
 *
 *   node data-migrations/logistics-copy/copy.js --env <ambiente>            prova: copia, verifica, report, annulla
 *   node data-migrations/logistics-copy/copy.js --env <ambiente> --apply    copia, verifica e conferma
 *
 * Una sola transazione dell'amministratore: legge come ct_app, scrive come cl_app (`set local role`), e i due schemi
 * non si incontrano mai in una query (ADR-0014, invariante 2). Prima di scrivere si pianifica tutto: un'anomalia
 * (due articoli con lo stesso nome, un'unita' non convertibile, un movimento con il segno sbagliato, un titolare con
 * dati e senza organizzazione…) ferma la copia con l'elenco completo e nulla viene scritto. Dopo aver scritto si
 * rilegge e si confronta: giacenze e costi medi articolo per articolo, catena dei movimenti, ricette riga per riga,
 * conteggi. Una differenza annulla tutto.
 *
 * Prerequisiti, verificati: ComforTables con `tables.logistics_links` (la riga titolare → organizzazione la crea il
 * provisioning della Fase 2), migrazioni di ComfortLogistics fino a 0006. Backup completo prima di `--apply`
 * (ADR-0014 §14.5).
 *
 * Rieseguibile: un'organizzazione gia' copiata da questo script si salta; una che ha articoli creati a mano in
 * ComfortLogistics ferma la copia, perche' unire due magazzini e' una decisione, non una migrazione.
 */
const { existsSync } = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const pg = require('pg')
const { connectionFromEnv } = require('../../db/runner/config')

const ROOT = path.resolve(__dirname, '..', '..')
const SOURCE_ROLE = 'ct_app'
const TARGET_ROLE = 'cl_app'

/**
 * Autore dei movimenti e dei riordini copiati. ComfortLogistics vuole un autore o un messaggio del bus; questi non
 * hanno ne' l'uno ne' l'altro. E' anche il segno che un'organizzazione e' gia' stata copiata.
 */
const MIGRATION_ACTOR = '00000000-0000-4000-8000-000000000015'
const ALIGNMENT_REASON = 'migration_alignment'
const DEFAULT_LOCATION = 'Magazzino principale'

/** Unita' di ComforTables → unita' base di ComfortLogistics e fattore. */
const UNITS = {
  g: { base: 'g', factor: 1 },
  kg: { base: 'g', factor: 1000 },
  ml: { base: 'ml', factor: 1 },
  l: { base: 'ml', factor: 1000 },
  pz: { base: 'pz', factor: 1 },
  mazzo: { base: 'mazzo', factor: 1 }
}
const MOVEMENT_KINDS = ['initial', 'restock', 'consumption', 'waste', 'adjustment']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function stop(message, extra = {}) {
  return Object.assign(new Error(`${message} Nulla e' stato scritto.`), { code: 'LOGISTICS_COPY_STOPPED', ...extra })
}

/** La normalizzazione di ComfortLogistics (`backend/src/lib/text.mjs`): unicita' e collegamenti usano questa. */
function normalizedName(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('it').replace(/\s+/gu, ' ').trim()
}

/*
 * Quantita' in centesimi interi. Nel vecchio magazzino sono tutte `numeric(10,2)`: moltiplicare per 1000 in centesimi
 * resta esatto, cosa che con i float non e' garantita (0.35 kg non fa 350 g).
 */
function cents(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text)
  if (!match) throw new Error(`quantita' non numerica: ${text}`)
  const [, sign, int, frac = ''] = match
  const hundredths = Number(int || '0') * 100 + Number((frac + '00').slice(0, 2))
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) throw new Error(`piu' di due decimali: ${text}`)
  return sign ? -hundredths : hundredths
}

function decimal(hundredths) {
  if (hundredths === null) return null
  const sign = hundredths < 0 ? '-' : ''
  const abs = Math.abs(hundredths)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Lettura del vecchio magazzino, come ct_app                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

const OWNERS_WITH_DATA = `
  select l.user_id as owner_id from tables.ingredients i join tables.ingredients_fk_user_lnk l on l.ingredient_id = i.id
   where coalesce(i.stock_qty, 0) > 0 or coalesce(i.low_stock_threshold, 0) > 0 or i.unit_cost is not null
      or nullif(btrim(i.supplier_name), '') is not null or coalesce(i.addon_avg_qty, 0) > 0
  union select l.user_id from tables.inventory_movements_fk_user_lnk l
  union select l.user_id from tables.restock_orders_fk_user_lnk l
  union select l.user_id from tables.suppliers_fk_user_lnk l
  union select l.user_id from tables.inventory_alerts a join tables.inventory_alerts_fk_user_lnk l on l.inventory_alert_id = a.id
   where a.acknowledged_at is null and not coalesce(a.dismissed_by_restock, false)
  union select eu.user_id from tables.element_ingredients ei
    join tables.element_ingredients_fk_element_lnk el on el.element_ingredient_id = ei.id
    join tables.elements_fk_user_lnk eu on eu.element_id = el.element_id
   where coalesce(ei.qty_per_serving, 0) > 0 or ei.is_public = false`

async function readOwners(client) {
  const { rows: [links] } = await client.query("select to_regclass('tables.logistics_links') is not null as present")
  if (!links.present) {
    throw stop('ComforTables senza tables.logistics_links: manca la sua migrazione 202609180001_logistics_bus.')
  }
  const { rows: owners } = await client.query(`select distinct owner_id from (${OWNERS_WITH_DATA}) o order by owner_id`)
  const { rows: linkRows } = await client.query('select fk_user, organization_id::text as organization_id from tables.logistics_links')
  const organizations = new Map(linkRows.map((row) => [row.fk_user, row.organization_id]))
  return owners.map((row) => ({ ownerId: row.owner_id, organizationId: organizations.get(row.owner_id) ?? null }))
}

const utc = (column) => `(${column} at time zone 'UTC')`

async function readOwnerData(client, ownerId) {
  const one = async (text) => (await client.query(text, [ownerId])).rows
  const ingredients = await one(`
    select i.id, i.document_id, i.name, i.unit, i.unit_size::text, i.unit_label, i.stock_qty::text,
           i.low_stock_threshold::text, i.reorder_lead_days::text, i.unit_cost, i.is_active, i.is_addon,
           i.addon_avg_qty::text, i.supplier_name, i.supplier_email, i.notes, i.allergens
      from tables.ingredients i join tables.ingredients_fk_user_lnk l on l.ingredient_id = i.id
     where l.user_id = $1 order by i.id`)
  const elements = await one(`
    select e.id, e.document_id, e.name, e.category, e.price::text, e.is_beverage, e.is_beverage_advanced, e.is_archived
      from tables.elements e join tables.elements_fk_user_lnk l on l.element_id = e.id
     where l.user_id = $1 order by e.id`)
  const lines = await one(`
    select ei.id, el.element_id, il.ingredient_id, ei.qty_per_serving::text, ei.unit_override, ei.is_public
      from tables.element_ingredients ei
      join tables.element_ingredients_fk_element_lnk el on el.element_ingredient_id = ei.id
      join tables.element_ingredients_fk_ingredient_lnk il on il.element_ingredient_id = ei.id
      join tables.elements_fk_user_lnk eu on eu.element_id = el.element_id
     where eu.user_id = $1 order by ei.id`)
  const movements = await one(`
    select m.id, m.kind, m.qty_delta::text, m.qty_after::text, m.cost::text, m.reason, m.note, m.supplier, m.batch_id,
           ${utc('m.created_at')} as created_at, il.ingredient_id, oi.document_id as item_ref, o.document_id as order_ref,
           bs.document_id as shift_ref, rl.restock_order_id
      from tables.inventory_movements m
      join tables.inventory_movements_fk_user_lnk ul on ul.inventory_movement_id = m.id
      left join tables.inventory_movements_fk_ingredient_lnk il on il.inventory_movement_id = m.id
      left join tables.inventory_movements_fk_order_item_lnk oil on oil.inventory_movement_id = m.id
      left join tables.order_items oi on oi.id = oil.order_item_id
      left join tables.inventory_movements_fk_order_lnk ol on ol.inventory_movement_id = m.id
      left join tables.orders o on o.id = ol.order_id
      left join tables.inventory_movements_fk_bar_shift_lnk bl on bl.inventory_movement_id = m.id
      left join tables.bar_shifts bs on bs.id = bl.bar_shift_id
      left join tables.inventory_movements_fk_restock_order_lnk rl on rl.inventory_movement_id = m.id
     where ul.user_id = $1 order by m.created_at, m.id`)
  const restocks = await one(`
    select r.id, r.status, ${utc('r.ordered_at')} as ordered_at, ${utc('r.received_at')} as received_at,
           ${utc('r.cancelled_at')} as cancelled_at, ${utc('r.updated_at')} as updated_at, r.expected_qty::text,
           r.received_qty::text, r.cost::text, r.note, il.ingredient_id
      from tables.restock_orders r
      join tables.restock_orders_fk_user_lnk ul on ul.restock_order_id = r.id
      left join tables.restock_orders_fk_ingredient_lnk il on il.restock_order_id = r.id
     where ul.user_id = $1 order by r.ordered_at, r.id`)
  const suppliers = await one(`
    select s.id, s.name, s.email, s.phone, s.category, s.lead_time, s.order_days, s.notes, s.is_active
      from tables.suppliers s join tables.suppliers_fk_user_lnk l on l.supplier_id = s.id
     where l.user_id = $1 order by s.id`)
  const alerts = await one(`
    select a.id, a.alert_type, a.level, a.ingredients_payload, ${utc('a.created_at')} as created_at
      from tables.inventory_alerts a join tables.inventory_alerts_fk_user_lnk l on l.inventory_alert_id = a.id
     where l.user_id = $1 and a.acknowledged_at is null and not coalesce(a.dismissed_by_restock, false)
     order by a.created_at, a.id`)
  return { ingredients, elements, lines, movements, restocks, suppliers, alerts }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Piano: le righe di ComfortLogistics, calcolate senza scrivere                                                     */
/* ---------------------------------------------------------------------------------------------------------------- */

const allergenList = (value) => {
  const list = typeof value === 'string' ? JSON.parse(value) : value
  return Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : []
}

/**
 * Piano di un titolare. Funzione pura: dai dati letti alle righe da scrivere, alle anomalie che fermano la copia e
 * alle note (trasformazioni dichiarate, contate nel report). `now` e `uuid` si iniettano per i test.
 */
function planOwner(data, { organizationId, now = new Date(), uuid = randomUUID } = {}) {
  const anomalies = []
  const notes = { alignments: 0, zeroMovementsOmitted: 0, costDropped: 0, batchDropped: 0, leadDaysDropped: 0,
    suppliersFromNames: 0, sharedSourceRefs: 0, beveragesMatched: 0, beveragesUnmatched: 0, alertsSuperseded: 0 }
  const plan = { suppliers: [], articles: [], stock: [], movements: [], purchaseOrders: [], recipes: [], versions: [],
    recipeLines: [], alerts: [], sourceItems: [], ingredientLinks: [] }

  // Fornitori: le righe, poi i nomi che compaiono solo su ingredienti e movimenti (legati per nome, come oggi).
  const supplierByName = new Map()
  const addSupplier = (row) => {
    const key = normalizedName(row.name)
    if (!key) return null
    if (supplierByName.has(key)) return supplierByName.get(key)
    const supplier = { id: uuid(), organization_id: organizationId, name: row.name.trim(), name_normalized: key,
      email: row.email || null, phone: row.phone || null, notes: row.notes || null, active: row.active !== false }
    supplierByName.set(key, supplier)
    plan.suppliers.push(supplier)
    return supplier
  }
  const seenSuppliers = new Set()
  for (const s of data.suppliers) {
    const key = normalizedName(s.name)
    if (!key) { anomalies.push(`fornitore ${s.id} senza nome`); continue }
    if (seenSuppliers.has(key)) { anomalies.push(`due fornitori con lo stesso nome: «${s.name}»`); continue }
    seenSuppliers.add(key)
    const extra = [
      s.category && `Categoria: ${s.category}`,
      s.lead_time && `Tempi di consegna: ${s.lead_time}`,
      s.order_days && `Giorni d'ordine: ${s.order_days}`
    ].filter(Boolean)
    addSupplier({ name: s.name, email: s.email, phone: s.phone, active: s.is_active,
      notes: [s.notes, ...extra].filter(Boolean).join('\n') || null })
  }
  const supplierFromName = (name, email = null) => {
    const key = normalizedName(name)
    if (!key) return null
    if (!supplierByName.has(key)) notes.suppliersFromNames += 1
    return addSupplier({ name, email }).id
  }

  // Articoli, uno per ingrediente.
  const articleByIngredient = new Map()
  const seenArticles = new Map()
  for (const ing of data.ingredients) {
    const name = String(ing.name ?? '').trim()
    const key = normalizedName(name)
    const unit = UNITS[ing.unit]
    if (!key) { anomalies.push(`ingrediente ${ing.id} senza nome`); continue }
    if (!unit) { anomalies.push(`«${name}»: unita' sconosciuta ${ing.unit}`); continue }
    if (seenArticles.has(key)) { anomalies.push(`due ingredienti con lo stesso nome: «${seenArticles.get(key)}» e «${name}»`); continue }
    seenArticles.set(key, name)
    const stockCents = cents(ing.stock_qty) ?? 0
    if (stockCents < 0) { anomalies.push(`«${name}»: giacenza negativa ${ing.stock_qty}`); continue }
    const lead = ing.reorder_lead_days === null ? null : Number(ing.reorder_lead_days)
    if (lead !== null && lead < 0.5) notes.leadDaysDropped += 1
    const sizeCents = cents(ing.unit_size)
    const article = {
      id: uuid(),
      organization_id: organizationId,
      name,
      name_normalized: key,
      unit: unit.base,
      pack_size: sizeCents && sizeCents > 0 ? decimal(sizeCents * unit.factor) : '1.00',
      pack_label: ing.unit_label || null,
      low_stock_threshold: decimal((cents(ing.low_stock_threshold) ?? 0) * unit.factor),
      supplier_id: ing.supplier_name ? supplierFromName(ing.supplier_name, ing.supplier_email) : null,
      avg_unit_cost: ing.unit_cost === null || ing.unit_cost === undefined ? null : { value: String(ing.unit_cost), factor: unit.factor },
      notes: ing.notes || null,
      active: ing.is_active !== false,
      reorder_lead_days: lead !== null && lead >= 0.5 ? String(lead) : null,
      // Per il piano e le verifiche, non per l'insert.
      _ingredient: ing,
      _factor: unit.factor,
      _stock: stockCents * unit.factor
    }
    articleByIngredient.set(ing.id, article)
    plan.articles.push(article)
  }

  // Movimenti, per articolo, con la catena ricostruita.
  const location = { id: null } // assegnato alla scrittura
  const movementsByIngredient = new Map()
  for (const m of data.movements) {
    if (!articleByIngredient.has(m.ingredient_id)) {
      // Senza ingrediente, di un altro titolare, o su un ingrediente gia' in anomalia: non si perde in silenzio.
      anomalies.push(`movimento ${m.id} su un ingrediente non copiabile (${m.ingredient_id ?? 'nessuno'})`)
      continue
    }
    if (!movementsByIngredient.has(m.ingredient_id)) movementsByIngredient.set(m.ingredient_id, [])
    movementsByIngredient.get(m.ingredient_id).push(m)
  }
  const movementIdByLegacy = new Map()
  const sourceRefsSeen = new Set()
  const everRestocked = new Set()
  const alignment = (article, before, target, at) => ({
    id: uuid(), organization_id: organizationId, article_id: article.id, storage_location_id: location,
    kind: 'adjustment', quantity: decimal(target - before), stock_before: decimal(before), stock_after: decimal(target),
    cost: null, supplier_id: null, reason: ALIGNMENT_REASON,
    notes: 'Allineamento della migrazione: la giacenza del vecchio magazzino era cambiata senza un movimento.',
    batch_id: null, created_by: MIGRATION_ACTOR, occurred_at: at, recorded_at: at, source_ref: null, purchase_order_id: null
  })
  for (const article of plan.articles) {
    const ing = article._ingredient
    let prev = 0
    const rows = []
    for (const m of movementsByIngredient.get(ing.id) ?? []) {
      if (!MOVEMENT_KINDS.includes(m.kind)) { anomalies.push(`«${article.name}»: movimento ${m.id} di tipo ${m.kind}`); continue }
      const q = cents(m.qty_delta) * article._factor
      const after = cents(m.qty_after) * article._factor
      if (q === 0) { notes.zeroMovementsOmitted += 1; continue }
      if (['initial', 'restock'].includes(m.kind) && q < 0) { anomalies.push(`«${article.name}»: ${m.kind} ${m.id} negativo`); continue }
      if (['consumption', 'waste'].includes(m.kind) && q > 0) { anomalies.push(`«${article.name}»: ${m.kind} ${m.id} positivo`); continue }
      if (after < 0) { anomalies.push(`«${article.name}»: movimento ${m.id} con giacenza dopo negativa`); continue }
      if (Math.max(0, prev + q) !== after) {
        // Buco nella catena: la giacenza e' cambiata senza movimento. Si trova la giacenza prima che rende vera la
        // riga (stock_after = max(0, prima + quantita')) e ci si arriva con un allineamento.
        let before
        if (after > 0) before = after - q
        else before = q < 0 ? Math.min(prev, -q) : null
        if (before === null || before < 0) { anomalies.push(`«${article.name}»: movimento ${m.id} incoerente (${m.qty_delta} → ${m.qty_after})`); continue }
        if (before !== prev) {
          // L'ora vera del cambiamento non la conosce nessuno: un istante prima del movimento che lo rivela, cosi'
          // la cronologia di ComfortLogistics (ordinata per ora) li mostra nell'ordine giusto.
          rows.push(alignment(article, prev, before, new Date(new Date(m.created_at).getTime() - 1)))
          notes.alignments += 1
        }
        prev = before
      }
      let cost = m.cost === null ? null : m.cost
      if (cost !== null && m.kind !== 'restock') { notes.costDropped += 1; cost = null }
      let batch = m.batch_id || null
      if (batch && !UUID_RE.test(batch)) { notes.batchDropped += 1; batch = null }
      let sourceRef = m.item_ref || m.order_ref || m.shift_ref || null
      let extraNote = null
      if (sourceRef) {
        const key = `${sourceRef}|${m.kind}|${article.id}`
        if (sourceRefsSeen.has(key)) {
          // ComfortLogistics tiene un movimento per item, tipo e articolo; il vecchio magazzino a volte due.
          notes.sharedSourceRefs += 1
          extraNote = `Stesso riferimento di un movimento precedente: ${sourceRef}`
          sourceRef = null
        } else sourceRefsSeen.add(key)
      }
      if (m.kind === 'initial' || m.kind === 'restock') everRestocked.add(article.id)
      const row = {
        id: uuid(), organization_id: organizationId, article_id: article.id, storage_location_id: location,
        kind: m.kind, quantity: decimal(q), stock_before: decimal(prev), stock_after: decimal(after), cost,
        supplier_id: m.supplier ? supplierFromName(m.supplier) : null, reason: m.reason || null,
        notes: [m.note, extraNote].filter(Boolean).join('\n') || null, batch_id: batch, created_by: MIGRATION_ACTOR,
        occurred_at: m.created_at, recorded_at: m.created_at, source_ref: sourceRef, purchase_order_id: null,
        _restockOrder: m.restock_order_id
      }
      movementIdByLegacy.set(m.id, row)
      rows.push(row)
      prev = after
    }
    if (prev !== article._stock) {
      rows.push(alignment(article, prev, article._stock, now))
      notes.alignments += 1
    }
    article._chain = rows
    plan.movements.push(...rows)
    plan.stock.push({ organization_id: organizationId, article_id: article.id, storage_location_id: location,
      quantity: decimal(article._stock), ever_restocked: everRestocked.has(article.id) })
  }

  // Riordini, con il movimento di ricezione.
  for (const r of data.restocks) {
    const article = articleByIngredient.get(r.ingredient_id)
    if (!article) { anomalies.push(`riordino ${r.id} senza ingrediente`); continue }
    const expected = cents(r.expected_qty) * article._factor
    if (!(expected > 0)) { anomalies.push(`«${article.name}»: riordino ${r.id} con quantita' attesa ${r.expected_qty}`); continue }
    const po = { id: uuid(), organization_id: organizationId, article_id: article.id, supplier_id: article.supplier_id,
      state: r.status, quantity_expected: decimal(expected), quantity_received: null, cost: r.cost ?? null,
      notes: r.note || null, ordered_at: r.ordered_at, received_at: null, cancelled_at: null, movement_id: null,
      created_by: MIGRATION_ACTOR, updated_at: r.updated_at ?? now }
    const receipt = plan.movements.find((m) => m._restockOrder === r.id && m.kind === 'restock')
    if (receipt) receipt.purchase_order_id = po.id
    if (r.status === 'received') {
      const received = cents(r.received_qty) === null ? null : cents(r.received_qty) * article._factor
      if (!receipt || !r.received_at || !(received > 0)) {
        anomalies.push(`«${article.name}»: riordino ${r.id} ricevuto senza data, quantita' o movimento di carico`)
        continue
      }
      Object.assign(po, { received_at: r.received_at, quantity_received: decimal(received), movement_id: receipt.id })
    } else if (r.status === 'cancelled') {
      po.cancelled_at = r.cancelled_at ?? r.updated_at
    } else if (r.status !== 'ordered') {
      anomalies.push(`«${article.name}»: riordino ${r.id} in stato ${r.status}`)
      continue
    }
    plan.purchaseOrders.push(po)
  }

  // Ricette.
  const ingredientById = new Map(data.ingredients.map((ing) => [ing.id, ing]))
  const linesByElement = new Map()
  for (const line of data.lines) {
    if (!linesByElement.has(line.element_id)) linesByElement.set(line.element_id, [])
    linesByElement.get(line.element_id).push(line)
  }
  const recipeRefs = new Set()
  const addRecipe = (target, sourceRef, lines) => {
    const recipe = { id: uuid(), organization_id: organizationId, target, source_ref: sourceRef }
    const version = { id: uuid(), organization_id: organizationId, recipe_id: recipe.id, number: 1,
      valid_from: '-infinity', created_by: 'migration' }
    plan.recipes.push(recipe)
    plan.versions.push(version)
    for (const line of lines) plan.recipeLines.push({ id: uuid(), organization_id: organizationId, version_id: version.id, ...line })
    recipeRefs.add(sourceRef)
  }
  const elementById = new Map(data.elements.map((e) => [e.id, e]))
  for (const [elementId, lines] of linesByElement) {
    const element = elementById.get(elementId)
    if (!element) continue
    if (!lines.some((l) => (cents(l.qty_per_serving) ?? 0) > 0 || l.is_public === false)) continue
    const out = []
    const seen = new Set()
    let broken = false
    for (const l of lines) {
      const article = articleByIngredient.get(l.ingredient_id)
      if (!article) {
        anomalies.push(`«${element.name}»: riga con un ingrediente non copiabile (${l.ingredient_id})`)
        broken = true
        continue
      }
      if (seen.has(article.id)) { anomalies.push(`«${element.name}»: due righe con «${article.name}»`); broken = true; continue }
      seen.add(article.id)
      const ingUnit = ingredientById.get(l.ingredient_id).unit
      const inputUnit = l.unit_override || ingUnit
      const conv = UNITS[inputUnit]
      if (!conv || conv.base !== article.unit) {
        anomalies.push(`«${element.name}»: dose di «${article.name}» in ${inputUnit}, articolo in ${article.unit}`)
        broken = true
        continue
      }
      const qty = cents(l.qty_per_serving)
      out.push({ article_id: article.id, quantity: qty && qty > 0 ? decimal(qty * conv.factor) : null, input_unit: inputUnit })
    }
    if (!broken) addRecipe(element.is_beverage_advanced ? 'beverage' : 'dish', element.document_id, out)
  }
  for (const article of plan.articles) {
    const ing = article._ingredient
    const dose = cents(ing.addon_avg_qty)
    if (ing.is_addon && dose && dose > 0) {
      addRecipe('addon', ing.document_id, [{ article_id: article.id, quantity: decimal(dose * article._factor), input_unit: ing.unit }])
    }
  }
  // Bevande semplici abbinate per nome a un ingrediente, come lo scarico del carico fatto di oggi: il formato se
  // c'e' (una bottiglia per servita), altrimenti un pezzo.
  const articleByName = new Map(plan.articles.map((a) => [a.name_normalized, a]))
  for (const element of data.elements) {
    if (!element.is_beverage || element.is_beverage_advanced || recipeRefs.has(element.document_id)) continue
    const article = articleByName.get(normalizedName(element.name))
    if (!article) { notes.beveragesUnmatched += 1; continue }
    const ing = article._ingredient
    const size = cents(ing.unit_size)
    let quantity = null
    if (size && size > 0) quantity = decimal(size * article._factor)
    else if (article.unit === 'pz') quantity = '1.00'
    if (quantity === null) { notes.beveragesUnmatched += 1; continue }
    notes.beveragesMatched += 1
    addRecipe('beverage', element.document_id, [{ article_id: article.id, quantity, input_unit: ing.unit }])
  }

  // Alert aperti: uno per articolo e tipo, il piu' recente.
  const alertByKey = new Map()
  for (const a of data.alerts) {
    const payload = typeof a.ingredients_payload === 'string' ? JSON.parse(a.ingredients_payload) : a.ingredients_payload
    for (const entry of Array.isArray(payload) ? payload : []) {
      const article = articleByIngredient.get(Number(entry.fk_ingredient))
      if (!article) continue
      const key = `${article.id}|${a.alert_type}`
      if (alertByKey.has(key)) notes.alertsSuperseded += 1
      const stock = cents(entry.stock_qty === undefined || entry.stock_qty === null ? null : Number(entry.stock_qty).toFixed(2))
      const threshold = entry.threshold === undefined || entry.threshold === null ? null : cents(Number(entry.threshold).toFixed(2))
      const days = entry.days_to_depletion === undefined || entry.days_to_depletion === null ? null : Number(entry.days_to_depletion)
      alertByKey.set(key, {
        id: uuid(), organization_id: organizationId, article_id: article.id, kind: a.alert_type,
        level: ['info', 'warning', 'critical'].includes(entry.level) ? entry.level : a.level,
        stock_qty: decimal(Math.max(0, stock ?? article._stock / article._factor) * article._factor),
        days_to_depletion: days === null ? null : Math.max(0, days).toFixed(2),
        threshold: threshold === null ? null : decimal(Math.max(0, threshold) * article._factor),
        opened_at: a.created_at
      })
    }
  }
  plan.alerts.push(...alertByKey.values())

  // Catalogo copiato e collegamenti degli ingredienti.
  const publicRefs = new Map()
  for (const l of data.lines) {
    if (l.is_public === false) continue
    const ing = ingredientById.get(l.ingredient_id)
    if (!ing) continue
    if (!publicRefs.has(l.element_id)) publicRefs.set(l.element_id, [])
    publicRefs.get(l.element_id).push(ing.document_id)
  }
  for (const e of data.elements) {
    const name = String(e.name ?? '').trim()
    if (!normalizedName(name)) { anomalies.push(`piatto ${e.id} senza nome`); continue }
    plan.sourceItems.push({ organization_id: organizationId, kind: 'dish', source_ref: e.document_id, version: 0, name,
      name_normalized: normalizedName(name), category: e.category || null, price: e.price ?? null,
      is_beverage: e.is_beverage === true, is_beverage_advanced: e.is_beverage_advanced === true, is_addon: false,
      allergens: [], ingredient_refs: publicRefs.get(e.id) ?? [], archived: e.is_archived === true,
      import_state: e.is_archived === true ? 'archived' : recipeRefs.has(e.document_id) ? 'linked' : 'new' })
  }
  for (const article of plan.articles) {
    const ing = article._ingredient
    const archived = ing.is_active === false
    plan.sourceItems.push({ organization_id: organizationId, kind: 'menu_ingredient', source_ref: ing.document_id,
      version: 0, name: article.name, name_normalized: article.name_normalized, category: null, price: null,
      is_beverage: false, is_beverage_advanced: false, is_addon: ing.is_addon === true, allergens: allergenList(ing.allergens),
      ingredient_refs: [], archived, import_state: archived ? 'archived' : 'linked' })
    plan.ingredientLinks.push({ organization_id: organizationId, source_ref: ing.document_id, article_id: article.id })
  }

  return { plan, anomalies, notes, location }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Scrittura, come cl_app                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Insert di molte righe da un jsonb, con i tipi dichiarati: una query per tabella. */
async function insertRows(client, table, columns, rows) {
  if (!rows.length) return
  const names = columns.map(([name]) => name)
  const typed = columns.map(([name, type]) => `${name} ${type}`).join(', ')
  const payload = rows.map((row) => Object.fromEntries(names.map((name) => [name, row[name] ?? null])))
  await client.query(
    `insert into logistics.${table} (${names.join(', ')}) select ${names.join(', ')} from jsonb_to_recordset($1::jsonb) as t(${typed})`,
    [JSON.stringify(payload, (key, value) => (value instanceof Date ? value.toISOString() : value))]
  )
}

async function checkTarget(client) {
  const { rows: [state] } = await client.query(`select
      to_regclass('logistics.articles') is not null as articles,
      exists (select 1 from information_schema.columns where table_schema = 'logistics' and table_name = 'source_items'
                and column_name = 'ingredient_refs') as m0005,
      exists (select 1 from information_schema.columns where table_schema = 'logistics' and table_name = 'movements'
                and column_name = 'source_ref') as m0006`)
  if (!state.articles || !state.m0005 || !state.m0006) {
    throw stop('ComfortLogistics: applica prima le sue migrazioni fino a 0006 (articoli, ricette, vendite).')
  }
}

/** `null` se l'organizzazione non ha magazzino, `migrated` se l'ha gia' copiata questo script, `manual` altrimenti. */
async function targetState(client, organizationId) {
  const { rows: [row] } = await client.query(
    `select exists (select 1 from logistics.articles where organization_id = $1) as articles,
            exists (select 1 from logistics.movements where organization_id = $1 and created_by = $2) as migrated`,
    [organizationId, MIGRATION_ACTOR]
  )
  if (!row.articles) return null
  return row.migrated ? 'migrated' : 'manual'
}

async function writePlan(client, { plan, location }, organizationId, now) {
  await client.query('insert into logistics.organizations (id) values ($1) on conflict do nothing', [organizationId])
  await client.query(
    `insert into logistics.storage_locations (id, organization_id, name, is_default) values ($1, $2, $3, true)
     on conflict do nothing`,
    [randomUUID(), organizationId, DEFAULT_LOCATION]
  )
  const { rows: [loc] } = await client.query(
    'select id from logistics.storage_locations where organization_id = $1 and is_default', [organizationId])
  location.id = loc.id
  const withLocation = (rows) => rows.map((row) => ({ ...row, storage_location_id: location.id }))

  await insertRows(client, 'suppliers', [['id', 'uuid'], ['organization_id', 'uuid'], ['name', 'text'],
    ['name_normalized', 'text'], ['email', 'text'], ['phone', 'text'], ['notes', 'text'], ['active', 'boolean']], plan.suppliers)
  await insertRows(client, 'articles', [['id', 'uuid'], ['organization_id', 'uuid'], ['name', 'text'],
    ['name_normalized', 'text'], ['unit', 'text'], ['pack_size', 'numeric'], ['pack_label', 'text'],
    ['low_stock_threshold', 'numeric'], ['supplier_id', 'uuid'], ['notes', 'text'], ['active', 'boolean'],
    ['reorder_lead_days', 'numeric']], plan.articles)
  // Costo medio per unita' base: il vecchio era per unita' dell'ingrediente (kg, l), si divide nel database.
  for (const article of plan.articles.filter((a) => a.avg_unit_cost)) {
    await client.query(
      'update logistics.articles set avg_unit_cost = round($3::numeric / $4, 8) where organization_id = $1 and id = $2',
      [organizationId, article.id, article.avg_unit_cost.value, article.avg_unit_cost.factor]
    )
  }
  await insertRows(client, 'stock', [['organization_id', 'uuid'], ['article_id', 'uuid'], ['storage_location_id', 'uuid'],
    ['quantity', 'numeric'], ['ever_restocked', 'boolean']], withLocation(plan.stock))
  await insertRows(client, 'source_items', [['organization_id', 'uuid'], ['kind', 'text'], ['source_ref', 'text'],
    ['version', 'bigint'], ['name', 'text'], ['name_normalized', 'text'], ['category', 'text'], ['price', 'numeric'],
    ['is_beverage', 'boolean'], ['is_beverage_advanced', 'boolean'], ['is_addon', 'boolean'], ['allergens', 'text[]'],
    ['ingredient_refs', 'text[]'], ['archived', 'boolean'], ['import_state', 'text']], plan.sourceItems)
  await insertRows(client, 'ingredient_links', [['organization_id', 'uuid'], ['source_ref', 'text'], ['article_id', 'uuid']],
    plan.ingredientLinks)
  await insertRows(client, 'movements', [['id', 'uuid'], ['organization_id', 'uuid'], ['article_id', 'uuid'],
    ['storage_location_id', 'uuid'], ['kind', 'text'], ['quantity', 'numeric'], ['stock_before', 'numeric'],
    ['stock_after', 'numeric'], ['cost', 'numeric'], ['supplier_id', 'uuid'], ['reason', 'text'], ['notes', 'text'],
    ['batch_id', 'uuid'], ['created_by', 'uuid'], ['occurred_at', 'timestamptz'], ['recorded_at', 'timestamptz'],
    ['source_ref', 'text'], ['purchase_order_id', 'uuid']], withLocation(plan.movements))
  await insertRows(client, 'purchase_orders', [['id', 'uuid'], ['organization_id', 'uuid'], ['article_id', 'uuid'],
    ['supplier_id', 'uuid'], ['state', 'text'], ['quantity_expected', 'numeric'], ['quantity_received', 'numeric'],
    ['cost', 'numeric'], ['notes', 'text'], ['ordered_at', 'timestamptz'], ['received_at', 'timestamptz'],
    ['cancelled_at', 'timestamptz'], ['movement_id', 'uuid'], ['created_by', 'uuid'], ['updated_at', 'timestamptz']],
  plan.purchaseOrders)
  await insertRows(client, 'recipes', [['id', 'uuid'], ['organization_id', 'uuid'], ['target', 'text'], ['source_ref', 'text']],
    plan.recipes)
  await insertRows(client, 'recipe_versions', [['id', 'uuid'], ['organization_id', 'uuid'], ['recipe_id', 'uuid'],
    ['number', 'integer'], ['valid_from', 'timestamptz'], ['created_by', 'text']], plan.versions)
  await insertRows(client, 'recipe_lines', [['id', 'uuid'], ['organization_id', 'uuid'], ['version_id', 'uuid'],
    ['article_id', 'uuid'], ['quantity', 'numeric'], ['input_unit', 'text']], plan.recipeLines)
  await insertRows(client, 'alerts', [['id', 'uuid'], ['organization_id', 'uuid'], ['article_id', 'uuid'], ['kind', 'text'],
    ['level', 'text'], ['stock_qty', 'numeric'], ['days_to_depletion', 'numeric'], ['threshold', 'numeric'],
    ['opened_at', 'timestamptz']], plan.alerts)
  await client.query(
    `insert into logistics.links (organization_id, source_app, state, activated_at, updated_at)
     values ($1, 'comfortables', 'active', $2, $2)
     on conflict (organization_id, source_app) do update
       set state = 'active', activated_at = coalesce(logistics.links.activated_at, excluded.activated_at),
           deactivated_at = null, updated_at = excluded.updated_at`,
    [organizationId, now]
  )
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Verifiche, rileggendo cio' che e' stato scritto                                                                  */
/* ---------------------------------------------------------------------------------------------------------------- */

const same = (a, b) => (a === null || a === undefined ? null : Number(a)) === (b === null || b === undefined ? null : Number(b))

async function verify(client, { plan }, organizationId) {
  const problems = []
  const q = async (text) => (await client.query(text, [organizationId])).rows

  // Giacenze e costi medi, articolo per articolo, contro il vecchio magazzino.
  const stock = new Map((await q('select article_id, quantity from logistics.stock where organization_id = $1'))
    .map((r) => [r.article_id, r.quantity]))
  const costs = new Map((await q('select id, avg_unit_cost from logistics.articles where organization_id = $1'))
    .map((r) => [r.id, r.avg_unit_cost]))
  for (const a of plan.articles) {
    if (!same(stock.get(a.id), decimal(a._stock))) problems.push(`«${a.name}»: giacenza ${stock.get(a.id)} invece di ${decimal(a._stock)}`)
    const legacy = a._ingredient.unit_cost
    const expected = legacy === null || legacy === undefined ? null : Number((Number(legacy) / a._factor).toFixed(8))
    const got = costs.get(a.id) === null ? null : Number(costs.get(a.id))
    if (expected === null ? got !== null : Math.abs(got - expected) > 1e-8) problems.push(`«${a.name}»: costo medio ${got} invece di ${expected}`)
  }

  // Catena dei movimenti: ogni riga come pianificata, e la pianificata coerente fino alla giacenza.
  const written = new Map((await q(
    'select id, article_id, kind, quantity, stock_before, stock_after from logistics.movements where organization_id = $1'
  )).map((r) => [r.id, r]))
  for (const a of plan.articles) {
    let prev = '0.00'
    for (const m of a._chain) {
      const w = written.get(m.id)
      if (!w || !same(w.quantity, m.quantity) || !same(w.stock_before, m.stock_before) || !same(w.stock_after, m.stock_after)) {
        problems.push(`«${a.name}»: movimento ${m.id} diverso da quello pianificato`)
        break
      }
      if (!same(m.stock_before, prev)) { problems.push(`«${a.name}»: catena dei movimenti interrotta`); break }
      prev = m.stock_after
    }
    if (!same(prev, decimal(a._stock))) problems.push(`«${a.name}»: i movimenti arrivano a ${prev}, la giacenza e' ${decimal(a._stock)}`)
  }

  // Ricette riga per riga: articolo, dose, unita'.
  const lines = await q(`select r.source_ref, r.target, l.article_id, l.quantity, l.input_unit
    from logistics.recipes r join logistics.recipe_versions v on v.recipe_id = r.id and v.number = 1
    join logistics.recipe_lines l on l.version_id = v.id where r.organization_id = $1`)
  const key = (ref, article, qty, unit) => `${ref}|${article}|${qty === null ? '-' : Number(qty)}|${unit}`
  const got = lines.map((l) => key(l.source_ref, l.article_id, l.quantity, l.input_unit)).sort()
  const recipeRef = new Map(plan.versions.map((v) => [v.id, plan.recipes.find((r) => r.id === v.recipe_id).source_ref]))
  const expected = plan.recipeLines.map((l) => key(recipeRef.get(l.version_id), l.article_id, l.quantity, l.input_unit)).sort()
  if (JSON.stringify(got) !== JSON.stringify(expected)) problems.push('ricette diverse da quelle del vecchio magazzino')

  // Conteggi.
  const counts = (await q(`select
      (select count(*)::int from logistics.suppliers where organization_id = $1) as suppliers,
      (select count(*)::int from logistics.purchase_orders where organization_id = $1) as purchase_orders,
      (select count(*)::int from logistics.alerts where organization_id = $1 and closed_at is null) as alerts,
      (select count(*)::int from logistics.recipes where organization_id = $1) as recipes,
      (select count(*)::int from logistics.source_items where organization_id = $1) as source_items`))[0]
  for (const [name, value] of Object.entries({ suppliers: plan.suppliers.length, purchase_orders: plan.purchaseOrders.length,
    alerts: plan.alerts.length, recipes: plan.recipes.length, source_items: plan.sourceItems.length })) {
    if (counts[name] !== value) problems.push(`${name}: ${counts[name]} invece di ${value}`)
  }
  return problems
}

/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * Copia sul client dell'amministratore. Con `commit: false` (default) annulla alla fine. Restituisce
 * `{ committed, report }`: una voce per titolare con dati di magazzino.
 */
async function copyLogistics({ client, commit = false, now = new Date() }) {
  await client.query('begin')
  try {
    await client.query("set local timezone to 'UTC'")
    await client.query(`set local role ${SOURCE_ROLE}`)
    const owners = await readOwners(client)
    const missing = owners.filter((o) => !o.organizationId)
    if (missing.length) {
      throw stop(`Titolari con dati di magazzino e senza organizzazione in tables.logistics_links: ${missing.map((o) => o.ownerId).join(', ')}.`)
    }
    const data = new Map()
    for (const owner of owners) data.set(owner.ownerId, await readOwnerData(client, owner.ownerId))

    await client.query(`set local role ${TARGET_ROLE}`)
    await checkTarget(client)
    const report = []
    const anomalies = []
    const plans = []
    for (const owner of owners) {
      const entry = { owner: owner.ownerId, organization: owner.organizationId }
      report.push(entry)
      const state = await targetState(client, owner.organizationId)
      if (state === 'migrated') { entry.outcome = 'gia\' copiata'; continue }
      if (state === 'manual') {
        anomalies.push(`organizzazione ${owner.organizationId} (titolare ${owner.ownerId}): ha gia' articoli creati in ComfortLogistics`)
        continue
      }
      const planned = planOwner(data.get(owner.ownerId), { organizationId: owner.organizationId, now })
      anomalies.push(...planned.anomalies.map((a) => `titolare ${owner.ownerId}: ${a}`))
      plans.push({ owner, entry, planned })
    }
    if (anomalies.length) throw stop(`Anomalie (${anomalies.length}):\n  - ${anomalies.join('\n  - ')}\n`, { report })

    for (const { owner, entry, planned } of plans) {
      await writePlan(client, planned, owner.organizationId, now)
      const problems = await verify(client, planned, owner.organizationId)
      const { plan, notes } = planned
      Object.assign(entry, {
        articles: plan.articles.length,
        suppliers: plan.suppliers.length,
        movements: plan.movements.length,
        purchaseOrders: plan.purchaseOrders.length,
        recipes: {
          dish: plan.recipes.filter((r) => r.target === 'dish').length,
          beverage: plan.recipes.filter((r) => r.target === 'beverage').length,
          addon: plan.recipes.filter((r) => r.target === 'addon').length
        },
        alerts: plan.alerts.length,
        sourceItems: plan.sourceItems.length,
        notes,
        problems
      })
      entry.outcome = problems.length ? 'DIVERSA' : commit ? 'copiata' : 'copiata (prova)'
    }
    const different = report.filter((e) => e.problems?.length)
    if (different.length) throw stop('Dopo la copia qualcosa non corrisponde al vecchio magazzino.', { report })

    await client.query(`set local role ${SOURCE_ROLE}`)
    for (const { owner } of plans) {
      await client.query(
        `update tables.logistics_links set state = 'active', activated_at = coalesce(activated_at, $2),
                deactivated_at = null, updated_at = $2 where fk_user = $1`,
        [owner.ownerId, now]
      )
    }
    await client.query(commit ? 'commit' : 'rollback')
    return { committed: commit, report }
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }
}

function formatReport(report) {
  if (!report.length) return 'Nessun titolare con dati di magazzino.'
  return report.map((e) => {
    const head = `titolare ${e.owner} → organizzazione ${e.organization}: ${e.outcome ?? 'non copiata'}`
    if (e.articles === undefined) return head
    const n = e.notes
    const lines = [
      head,
      `  articoli ${e.articles}, fornitori ${e.suppliers} (${n.suppliersFromNames} dai nomi), movimenti ${e.movements} ` +
        `(${n.alignments} allineamenti, ${n.zeroMovementsOmitted} a zero omessi), riordini ${e.purchaseOrders}`,
      `  ricette: piatti ${e.recipes.dish}, bevande ${e.recipes.beverage} (${n.beveragesMatched} abbinate per nome, ` +
        `${n.beveragesUnmatched} senza articolo), aggiunte ${e.recipes.addon}; alert ${e.alerts} ` +
        `(${n.alertsSuperseded} sostituiti da uno piu' recente); catalogo ${e.sourceItems}`,
      `  note: costi fuori dai rifornimenti tolti ${n.costDropped}, lotti non uuid tolti ${n.batchDropped}, ` +
        `tempi di riordino sotto mezza giornata tolti ${n.leadDaysDropped}, riferimenti condivisi ${n.sharedSourceRefs}`
    ]
    for (const p of e.problems ?? []) lines.push(`  DIFFERENZA: ${p}`)
    return lines.join('\n')
  }).join('\n')
}

const USAGE = 'Uso: node data-migrations/logistics-copy/copy.js --env <ambiente> [--apply]'

function parseArgs(argv) {
  const options = { apply: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--env' && i + 1 < argv.length) options.env = argv[++i]
    else if (arg === '--apply') options.apply = true
    else throw new Error(`Argomento non riconosciuto: ${arg}\n${USAGE}`)
  }
  if (!options.env) throw new Error(USAGE)
  return options
}

async function main(argv) {
  const options = parseArgs(argv)
  const envFile = path.join(ROOT, '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  const { config, warnings } = connectionFromEnv(options.env)
  console.log(`Ambiente: ${options.env} - ${config.host}:${config.port}/${config.database} (utente ${config.user})`)
  for (const warning of warnings) console.warn(`Attenzione: ${warning}`)
  const client = new pg.Client({ ...config, application_name: 'comfortplatform-logistics-copy' })
  await client.connect()
  try {
    const { committed, report } = await copyLogistics({ client, commit: options.apply })
    console.log(`\n${formatReport(report)}\n`)
    console.log(committed ? '[logistics-copy] copia confermata.' : '[logistics-copy] prova: copia eseguita e annullata. Per confermare: --apply')
  } finally {
    await client.end()
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    if (err.report) console.error(formatReport(err.report))
    console.error(err.message)
    process.exitCode = 1
  })
}

module.exports = { MIGRATION_ACTOR, ALIGNMENT_REASON, normalizedName, cents, decimal, planOwner, copyLogistics, formatReport }
