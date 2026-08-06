import {
  validateItemInput, formatCurrency, computeStillDueTotal, computeStillDueTotalWithShipping,
  computeSpentRemainingWithShipping,
  countAllTimeMonthsWithData,
  filterItems, computeAveragePrice, findPriciestItem,
  topExpensiveItems, groupSpendByShop, buildCalendarGrid, computeMonthSpend, computeMonthSpendWithFallback,
  computeBudgetProgress, parseGenericOrder, computePreorderVsReleased,
  looksLikeForbiddenPlanet, parseForbiddenPlanetOrders, looksLikeEbay, parseEbayOrders,
  computeCancelledSavings, findMostExpensiveMonth, findBusiestWeekday,
  computeShippingStats, sortItemsBy, SORT_OPTIONS, computeCycleBounds,
  computeCycleSpend, buildCsvExport, buildJsonBackup, parseJsonBackup,
  findTomorrowReleases, buildTomorrowNotification, filterByShop,
  computeYearStats, buildMonthlySpendTrend, buildIcsExport, computeSearchTotals,
  computeShippingRatioPct, computePreorderPct, computeEffectiveBudget,
  findNextWeekReleases, buildWeeklyNotification, findAwaitingCharge,
  buildMonthlySpendTrendRange, buildWeeklySpendTrend, groupSpendByShopWithSellers,
  shopGroupName,
  assignShopColor,
  matchesStatusFilter,
  hasActiveSearchFilter,
  itemsInMonth,
  groupItemsByDateAndShop,
  formatSearchDateLabel,
  findDuplicateGroups,
  findGhostItems,
  findRecentlyCancelled,
  findUpcomingReleases,
  computeAvgVsPriciestIssuePct,
  computeAllTimeComicsVsShippingSplit,
  computeWeekdayReleaseChart,
  computePriceCreep,
  computeOrderShippingTotals,
  computeShippingEstimate,
  extractFpDeclaredTotals,
  computeCalibratedShippingSamples,
} from './logic.js';

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { LocalNotifications } from '@capacitor/local-notifications';
import { App } from '@capacitor/app';


// --- SQLite + DOM wiring - only runs inside Capacitor (native) or the ---
// --- jeep-sqlite web fallback used for local browser testing.          --

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { defineCustomElements } from 'jeep-sqlite/loader';

defineCustomElements(window);

const sqlite = new SQLiteConnection(CapacitorSQLite);
const DB_NAME = 'kaching_local';
let db = null;
let currencySymbol = '£';
let monthlyBudget = null;
let budgetCycle = 'monthly';
let budgetRollover = false;
let dismissedDuplicates = new Set();

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Captured once, just to seed the initial nav state below - everything
// that needs "the real current date" during a render calls getToday()
// instead, since this app's WebView can stay alive across app switches
// for days, and a Date captured once at load would quietly go stale.
const initialToday = new Date();
function getToday() { return new Date(); }
let calYear = initialToday.getFullYear();
let calMonth = initialToday.getMonth();
let dashYear = initialToday.getFullYear();
let dashMonth = initialToday.getMonth();
let selectedCalDate = null;
let selectedShop = '';
let pastedResults = [];
let pastedDeclaredTotals = new Map();
let forcedShopHint = null;

// Every modal (Edit, order quick-view, paste review) registers its own
// close function here when it opens and removes it when it closes - so
// the Android back button can close just the topmost one, rather than
// exiting the app or closing the wrong modal when they're stacked.
const openModalStack = [];
function registerModal(closeFn) {
  openModalStack.push(closeFn);
}
function unregisterModal(closeFn) {
  const idx = openModalStack.indexOf(closeFn);
  if (idx !== -1) openModalStack.splice(idx, 1);
}

// crypto.randomUUID() is available in modern Android/iOS WebViews, but this
// falls back to a plain Math.random-based v4 shape for anything older -
// good enough for a local sync identifier, not used for anything
// security-sensitive.
function genUuid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function initDatabase() {
  const isWeb = !(window.Capacitor && window.Capacitor.isNativePlatform());
  if (isWeb) {
    const jeepEl = document.querySelector('jeep-sqlite');
    await customElements.whenDefined('jeep-sqlite');
    // Current jeep-sqlite versions initialize their IndexedDB store
    // automatically once the element is defined - there's no explicit
    // init call to make. isStoreOpen() just confirms it's ready; poll
    // briefly in case the element hasn't finished its own setup yet.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await jeepEl.isStoreOpen()) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  db = await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  await db.open();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      release_date TEXT,
      shop TEXT,
      order_number TEXT,
      shipping REAL,
      status TEXT NOT NULL DEFAULT 'preorder',
      charge_status TEXT NOT NULL DEFAULT 'not_charged',
      tracking_number TEXT,
      placed_date TEXT,
      manual_override INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS order_shipping (
      order_number TEXT NOT NULL,
      shipment_index INTEGER NOT NULL DEFAULT 0,
      amount REAL NOT NULL,
      captured_at TEXT NOT NULL,
      source TEXT,
      PRIMARY KEY (order_number, shipment_index)
    );
    CREATE TABLE IF NOT EXISTS orders (
      order_number TEXT PRIMARY KEY,
      declared_total REAL,
      last_seen_at TEXT
    );
  `);
  const cols = await db.query("PRAGMA table_info(items);");
  const existing = (cols.values || []).map(c => c.name);
  for (const [name, def] of [
    ['order_number', 'TEXT'], ['shipping', 'REAL'],
    ['status', "TEXT NOT NULL DEFAULT 'preorder'"],
    ['charge_status', "TEXT NOT NULL DEFAULT 'not_charged'"],
    ['tracking_number', 'TEXT'],
    ['prev_status', 'TEXT'], ['prev_charge_status', 'TEXT'],
    ['placed_date', 'TEXT'],
    ['manual_override', 'INTEGER NOT NULL DEFAULT 0'],
    ['uuid', 'TEXT'],
    ['updated_at', 'TEXT'],
    ['deleted_at', 'TEXT'],
  ]) {
    if (!existing.includes(name)) {
      await db.execute(`ALTER TABLE items ADD COLUMN ${name} ${def};`);
    }
  }
  await backfillSyncColumns();
  await backfillOrderShipping();
}

// Existing installs (and every order added before this feature existed)
// stored shipping as a per-item share, split evenly across every item in
// the order. Reconstruct the real order total the same way regardless of
// whether the original split was even: summing every item's share for a
// given order always adds back up to the true total, since the shares
// came from dividing it in the first place. Safe to run on every
// startup - INSERT OR IGNORE means an order that already has a real
// order_shipping row (from the new parser path) is never touched here.
async function backfillOrderShipping() {
  await db.execute(`
    INSERT OR IGNORE INTO order_shipping (order_number, shipment_index, amount, captured_at, source)
    SELECT order_number, 0, ROUND(SUM(shipping), 2), MAX(created_at), MAX(shop)
    FROM items
    WHERE shipping IS NOT NULL AND shipping > 0 AND order_number IS NOT NULL AND order_number != ''
    GROUP BY order_number;
  `);
}

// Existing installs will have rows with uuid/updated_at still NULL right
// after the ALTER TABLE above adds the columns - same situation as the
// server side. Give every such row a real uuid and a best-guess
// updated_at (falling back to created_at, which is always present) so
// the sync client has something correct to compare against from day one.
async function backfillSyncColumns() {
  const result = await db.query('SELECT id, created_at FROM items WHERE uuid IS NULL;');
  for (const row of result.values || []) {
    await db.run('UPDATE items SET uuid = ? WHERE id = ?;', [genUuid(), row.id]);
  }
  await db.run('UPDATE items SET updated_at = created_at WHERE updated_at IS NULL;');
  // Unique index rather than a UNIQUE column constraint, same reasoning as
  // the server: ALTER TABLE can't add a column-level UNIQUE, and this is
  // only safe to (re)create once every row above already has a real uuid.
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_items_uuid ON items(uuid);');
}

async function fetchAllItems() {
  const result = await db.query('SELECT * FROM items ORDER BY id DESC;');
  const items = result.values || [];

  // Matches the webui's actual model precisely: each (release date, shop)
  // pair is one physical parcel/shipment. For that whole group, check
  // whether every distinct order behind it has real captured postage -
  // if so, the group's cost is the SUM of those real amounts; if even
  // one of the group's orders lacks real data, the WHOLE group falls
  // back to one estimate (the webui does not mix real data for some
  // orders in a group with an estimate for others in the same group).
  // This only differs from a simpler per-order check when more than one
  // order's items happen to release on the same day from the same shop
  // - genuinely common for a long-running collection - which is exactly
  // the scenario an earlier, order-independent version of this got
  // wrong.
  const shippingRowsResult = await db.query('SELECT order_number, SUM(amount) AS total, MAX(source) AS source FROM order_shipping GROUP BY order_number;');
  const realOrderTotals = new Map((shippingRowsResult.values || []).map(r => [r.order_number, r.total]));

  const exactRowsResult = await db.query('SELECT amount, source FROM order_shipping;');
  rawRealShipments = (exactRowsResult.values || []).filter(r => r.amount != null);
  const exactAmountsBySource = new Map();
  for (const row of exactRowsResult.values || []) {
    if (!row.source || !row.amount || row.amount <= 0) continue;
    if (!exactAmountsBySource.has(row.source)) exactAmountsBySource.set(row.source, []);
    exactAmountsBySource.get(row.source).push(row.amount);
  }

  // Tier 2 (Forbidden-Planet-only calibrated estimate) is disabled - see
  // the long explanation this used to sit here, kept in git history.
  // The pure function and its tests remain unused but intact pending a
  // proper completeness check before it's safe to re-enable.

  const estimateCache = new Map();
  function estimateForShop(shop) {
    const key = shop || '';
    if (!estimateCache.has(key)) {
      estimateCache.set(key, computeShippingEstimate(exactAmountsBySource.get(shop) || [], []));
    }
    return estimateCache.get(key);
  }

  // Matches the webui's own Dashboard note exactly - it specifically
  // calls estimate_for(DEFAULT_SOURCE), i.e. Forbidden Planet only,
  // all-time, not a sitewide pool of every shop's real samples combined.
  // Got this wrong on the first pass (pooled all shops together), which
  // is exactly why the sample count didn't match webui's - fixed here
  // rather than inventing a new "sitewide" concept the webui doesn't
  // actually have for this note.
  defaultSourceShippingEstimate = estimateForShop('Forbidden Planet');

  const groups = new Map();
  for (const item of items) {
    if (item.status === 'cancelled') continue; // matches the webui's own
    // `SELECT * FROM items WHERE status != 'cancelled'` before any
    // shipping grouping happens at all - a cancelled item sharing a
    // (date, shop) group would otherwise dilute the per-item split for
    // the active items actually in that shipment.
    if (!item.release_date) continue; // matches the webui's own
    // `dated_shop_items = [i for i in items if i["release_date"]]` -
    // an item with no release date never gets any shipping contribution
    // at all, real or estimated, even though its comic price still
    // counts everywhere else. Without this, undated items were being
    // grouped together under an empty-string date key and given a
    // share of an estimate the webui would never have applied to them.
    const key = `${item.release_date}::${item.shop || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  shipmentGroupDebugLog = [];
  for (const [key, groupItems] of groups) {
    const shop = groupItems[0].shop;
    const releaseDate = groupItems[0].release_date;
    const orderNumbers = [...new Set(groupItems.map(i => i.order_number).filter(Boolean))];
    const known = orderNumbers.filter(o => realOrderTotals.has(o)).map(o => realOrderTotals.get(o));
    let rate;
    let source;
    if (orderNumbers.length > 0 && known.length === orderNumbers.length) {
      rate = Math.round(known.reduce((sum, v) => sum + v, 0) * 100) / 100;
      source = 'real';
    } else {
      rate = estimateForShop(shop).rate;
      source = 'estimated';
    }
    const perItem = rate / groupItems.length;
    for (const item of groupItems) item.shipping = perItem;
    if (shop === 'Forbidden Planet') {
      shipmentGroupDebugLog.push({
        date: releaseDate, orders: orderNumbers.join(','), itemCount: groupItems.length,
        source, rate: Math.round(rate * 100) / 100,
      });
    }
  }
  shipmentGroupDebugLog.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  return items;
}

async function insertItem(item) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO items (name, price, release_date, shop, order_number, shipping, status, charge_status, tracking_number, placed_date, manual_override, created_at, uuid, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [item.name, item.price, item.release_date, item.shop, item.order_number || null,
     item.shipping ?? null, item.status || 'preorder', item.charge_status || 'not_charged',
     item.tracking_number || null, item.placed_date || null, item.manualOverride ? 1 : 0, now,
     genUuid(), now]
  );
}

// Writes reconstructed order-level totals into order_shipping - a plain
// upsert (shipment_index always 0 for anything the app itself captures,
// since it doesn't distinguish separate parcels the way the webui's
// order-detail parser does) so re-importing the same order just updates
// the figure rather than duplicating or re-summing on top of it.
async function upsertOrderShipping(totals, source) {
  const now = new Date().toISOString();
  for (const [orderNumber, amount] of totals) {
    await db.run(
      `INSERT INTO order_shipping (order_number, shipment_index, amount, captured_at, source)
       VALUES (?, 0, ?, ?, ?)
       ON CONFLICT(order_number, shipment_index) DO UPDATE SET
         amount = excluded.amount, captured_at = excluded.captured_at, source = excluded.source
       WHERE excluded.captured_at > order_shipping.captured_at;`,
      [orderNumber, amount, now, source || null]
    );
  }
}

async function updateItem(id, item) {
  // A manual edit through the Edit form always locks the item - matches
  // the web app's own behaviour, so a later re-paste of the same order
  // history never silently reverts something the person deliberately changed.
  await db.run(
    `UPDATE items SET name = ?, price = ?, release_date = ?, shop = ?, tracking_number = ?, charge_status = ?, manual_override = 1, updated_at = ?
     WHERE id = ?;`,
    [item.name, item.price, item.release_date || null, item.shop || null,
     item.tracking_number || null, item.charge_status, new Date().toISOString(), id]
  );
}

// Refreshes an item from a re-paste without touching manual_override -
// used only for items that aren't already locked, so they stay refreshable
// by future imports too (distinct from updateItem, which is for the
// person's own manual edits and always locks).
async function refreshItemFromImport(id, fields) {
  await db.run(
    `UPDATE items SET status = ?, release_date = ?, charge_status = ?, placed_date = ?, tracking_number = COALESCE(?, tracking_number), shipping = COALESCE(?, shipping), updated_at = ?
     WHERE id = ? AND manual_override = 0;`,
    [fields.status, fields.release_date || null, fields.charge_status, fields.placed_date || null, fields.tracking_number || null, fields.shipping ?? null, new Date().toISOString(), id]
  );
}

async function deleteItem(id) {
  // Still hard-deleted for now - soft-delete (deleted_at) so removals
  // propagate over sync instead of just vanishing locally is coming in the
  // sync client work itself, not this schema pass.
  await db.run('DELETE FROM items WHERE id = ?;', [id]);
}

async function toggleChargeStatus(id) {
  const result = await db.query('SELECT charge_status FROM items WHERE id = ?;', [id]);
  const row = result.values && result.values[0];
  if (!row) return;
  const newStatus = row.charge_status === 'charged' ? 'not_charged' : 'charged';
  await db.run('UPDATE items SET charge_status = ?, manual_override = 1, updated_at = ? WHERE id = ?;', [newStatus, new Date().toISOString(), id]);
}

async function cancelItem(id) {
  await db.run(
    `UPDATE items SET prev_status = status, prev_charge_status = charge_status, status = 'cancelled', manual_override = 1, updated_at = ? WHERE id = ?;`,
    [new Date().toISOString(), id]
  );
}

async function undoCancelItem(id) {
  await db.run(
    `UPDATE items SET status = COALESCE(prev_status, 'preorder'), charge_status = COALESCE(prev_charge_status, charge_status),
     prev_status = NULL, prev_charge_status = NULL, manual_override = 1, updated_at = ? WHERE id = ?;`,
    [new Date().toISOString(), id]
  );
}

async function setChargeStatus(id, chargeStatus) {
  await db.run('UPDATE items SET charge_status = ?, manual_override = 1, updated_at = ? WHERE id = ?;', [chargeStatus, new Date().toISOString(), id]);
}

async function deleteAllItems() {
  await db.run('DELETE FROM items;');
}

// --- Sync -------------------------------------------------------------------
//
// Direct device-to-server connection only - talks to exactly the server URL
// the person typed in, using the key generated on that server's own
// Settings page. Nothing else is in the loop.

async function fetchItemsChangedSince(since) {
  const result = since
    ? await db.query('SELECT * FROM items WHERE updated_at > ?;', [since])
    : await db.query('SELECT * FROM items;');
  return result.values || [];
}

// Writes a row exactly as the server sent it - including its own
// updated_at - rather than going through insertItem/updateItem, which
// would stamp "now" and make this device think it just made a local
// change of its own on the very next sync.
async function applyRemoteItem(remote) {
  const existing = await db.query('SELECT id FROM items WHERE uuid = ?;', [remote.uuid]);
  const row = existing.values && existing.values[0];
  const deletedAt = remote.deleted ? remote.updated_at : null;
  if (row) {
    await db.run(
      `UPDATE items SET name = ?, order_number = ?, placed_date = ?, status = ?, release_date = ?,
       charge_status = ?, price = ?, shop = ?, tracking_number = ?, manual_override = ?,
       updated_at = ?, deleted_at = ?
       WHERE uuid = ?;`,
      [remote.name, remote.order_number, remote.placed_date, remote.status, remote.release_date,
       remote.charge_status, remote.price, remote.source, remote.tracking_number,
       remote.manual_override ? 1 : 0, remote.updated_at, deletedAt, remote.uuid]
    );
  } else {
    await db.run(
      `INSERT INTO items (name, price, release_date, shop, order_number, status, charge_status,
       tracking_number, placed_date, manual_override, created_at, uuid, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [remote.name, remote.price, remote.release_date, remote.source, remote.order_number,
       remote.status, remote.charge_status, remote.tracking_number, remote.placed_date,
       remote.manual_override ? 1 : 0, remote.updated_at, remote.uuid, remote.updated_at, deletedAt]
    );
  }
}

async function getSyncClientId() {
  let id = await getSetting('sync_client_id', null);
  if (!id) {
    id = genUuid();
    await setSetting('sync_client_id', id);
  }
  return id;
}

async function getPendingConflicts() {
  const raw = await getSetting('sync_pending_conflicts', '[]');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function savePendingConflicts(conflicts) {
  await setSetting('sync_pending_conflicts', JSON.stringify(conflicts));
}

// Keeping the local (app-side) version of a conflicted item just means
// touching its updated_at so the next sync sees it as dirty again and
// pushes it - by then the checkpoint has already moved past the
// server's conflicting edit, so it applies cleanly instead of
// conflicting a second time.
async function resolveConflictKeepMine(uuid) {
  await db.run('UPDATE items SET updated_at = ? WHERE uuid = ?;', [new Date().toISOString(), uuid]);
}

// Keeping the server's version is just applying it locally the same
// way a normal sync pull would.
async function resolveConflictKeepTheirs(theirs) {
  await applyRemoteItem(theirs);
}

// Runs one push-then-pull round trip. Returns a short status object for
// the Settings screen to show - doesn't throw on ordinary sync problems
// (bad URL, wrong key, offline), just reports them, since a failed sync
// isn't a crash, it's just "try again later".
// Clears the local sync checkpoint so the next sync treats every item
// as dirty again, regardless of when it last changed. Mainly for
// getting stuck first-time-reconciliation items retried after a server
// update - normal syncs shouldn't need this.
async function forceFullResync() {
  await setSetting('sync_last_synced_at', null);
}

async function getPendingRetryUuids() {
  const raw = await getSetting('sync_needs_retry', '[]');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function setPendingRetryUuids(uuids) {
  await setSetting('sync_needs_retry', JSON.stringify(uuids));
}

// For sync-pulled shipping records specifically - preserves the
// server's own captured_at and shipment_index rather than stamping with
// local "now", since this is remote data being applied, not a fresh
// local capture.
async function applyRemoteShipping(rec) {
  await db.run(
    `INSERT INTO order_shipping (order_number, shipment_index, amount, captured_at, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(order_number, shipment_index) DO UPDATE SET
       amount = excluded.amount, captured_at = excluded.captured_at, source = excluded.source
     WHERE excluded.captured_at > order_shipping.captured_at;`,
    [rec.order_number, rec.shipment_index, rec.amount, rec.captured_at, rec.source || null]
  );
}

async function upsertOrderTotals(totals) {
  const now = new Date().toISOString();
  for (const [orderNumber, declaredTotal] of totals) {
    await db.run(
      `INSERT INTO orders (order_number, declared_total, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT(order_number) DO UPDATE SET declared_total = excluded.declared_total, last_seen_at = excluded.last_seen_at;`,
      [orderNumber, declaredTotal, now]
    );
  }
}

// For sync-pulled declared-total records - preserves the server's own
// last_seen_at rather than stamping with local "now", same reasoning as
// applyRemoteShipping above.
async function applyRemoteOrder(rec) {
  await db.run(
    `INSERT INTO orders (order_number, declared_total, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(order_number) DO UPDATE SET
       declared_total = excluded.declared_total, last_seen_at = excluded.last_seen_at
     WHERE excluded.last_seen_at > orders.last_seen_at;`,
    [rec.order_number, rec.declared_total, rec.last_seen_at]
  );
}

async function runSync() {
  const serverUrl = (await getSetting('sync_server_url', '')).replace(/\/+$/, '');
  const syncKey = await getSetting('sync_key', '');
  if (!serverUrl || !syncKey) {
    return { ok: false, message: 'Add a server URL and sync key above first.' };
  }

  const clientId = await getSyncClientId();
  const clientLabel = await getSetting('sync_client_label', '') || undefined;
  const since = await getSetting('sync_last_synced_at', null);

  const dirty = await fetchItemsChangedSince(since);
  // An item the server couldn't automatically link last time (rare with
  // real reconciliation in place, but possible) needs to be retried on
  // every future sync regardless of whether it's actually changed since
  // - otherwise, once its updated_at falls behind the checkpoint, it
  // would never be sent again and would stay stuck forever.
  const retryUuids = await getPendingRetryUuids();
  const dirtyUuids = new Set(dirty.map(row => row.uuid));
  const stillNeedingRetry = retryUuids.filter(uuid => !dirtyUuids.has(uuid));
  let retryRows = [];
  if (stillNeedingRetry.length) {
    const placeholders = stillNeedingRetry.map(() => '?').join(',');
    const result = await db.query(`SELECT * FROM items WHERE uuid IN (${placeholders});`, stillNeedingRetry);
    retryRows = result.values || [];
  }

  const push = [...dirty, ...retryRows].map(row => ({
    uuid: row.uuid,
    name: row.name,
    order_number: row.order_number || null,
    placed_date: row.placed_date || null,
    status: row.status || 'preorder',
    release_date: row.release_date || null,
    charge_status: row.charge_status || 'not_charged',
    price: row.price,
    note: null,
    source: row.shop || 'Unknown shop',
    tracking_number: row.tracking_number || null,
    manual_override: !!row.manual_override,
    updated_at: row.updated_at,
    deleted: !!row.deleted_at,
  }));

  // order_shipping's captured_at doubles as its "changed since" marker,
  // same idea as items' updated_at - only push what's actually new or
  // changed locally, not the whole table every time.
  const dirtyShippingResult = since
    ? await db.query('SELECT * FROM order_shipping WHERE captured_at > ?;', [since])
    : await db.query('SELECT * FROM order_shipping;');
  const pushShipping = (dirtyShippingResult.values || []).map(row => ({
    order_number: row.order_number,
    shipment_index: row.shipment_index,
    amount: row.amount,
    captured_at: row.captured_at,
    source: row.source || null,
  }));

  const dirtyOrdersResult = since
    ? await db.query('SELECT * FROM orders WHERE declared_total IS NOT NULL AND last_seen_at > ?;', [since])
    : await db.query('SELECT * FROM orders WHERE declared_total IS NOT NULL;');
  const pushOrders = (dirtyOrdersResult.values || []).map(row => ({
    order_number: row.order_number,
    declared_total: row.declared_total,
    last_seen_at: row.last_seen_at,
  }));

  let response;
  try {
    response = await fetch(`${serverUrl}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Key': syncKey },
      body: JSON.stringify({ client_id: clientId, client_label: clientLabel, since, push, push_shipping: pushShipping, push_orders: pushOrders }),
    });
  } catch (err) {
    return { ok: false, message: `Couldn't reach the server: ${err.message || err}` };
  }

  if (!response.ok) {
    let detail = response.statusText;
    try { detail = (await response.json()).detail || detail; } catch { /* ignore */ }
    return { ok: false, message: `Sync failed (${response.status}): ${detail}` };
  }

  const result = await response.json();

  // Apply uuid reconciliation first - a local item that turned out to
  // already exist on the server under a different uuid gets renamed to
  // match, so the pull just below updates that same row in place
  // instead of inserting it again as a second copy.
  for (const r of result.reconciled || []) {
    const existingWithServerUuid = await db.query('SELECT id FROM items WHERE uuid = ?;', [r.server_uuid]);
    if (existingWithServerUuid.values && existingWithServerUuid.values.length) {
      // This device already has its own separate local row for the
      // same real-world item, sitting under the server's canonical
      // uuid - an app-side duplicate from before sync existed (e.g.
      // the same order history imported twice). Renaming into it
      // would collide, so just drop the redundant row instead; the
      // canonical one gets refreshed with the latest data by the pull
      // just below.
      await db.run('DELETE FROM items WHERE uuid = ?;', [r.local_uuid]);
    } else {
      await db.run('UPDATE items SET uuid = ? WHERE uuid = ?;', [r.server_uuid, r.local_uuid]);
    }
  }

  for (const item of result.changes || []) {
    await applyRemoteItem(item);
  }
  for (const rec of result.shipping_changes || []) {
    await applyRemoteShipping(rec);
  }
  for (const rec of result.order_changes || []) {
    await applyRemoteOrder(rec);
  }
  if (result.conflicts && result.conflicts.length) {
    // Merge rather than replace - an older conflict the person hasn't
    // resolved yet from a previous sync would otherwise get silently
    // dropped the moment a newer, unrelated conflict shows up.
    const existingConflicts = await getPendingConflicts();
    const newUuids = new Set(result.conflicts.map(c => c.uuid));
    const merged = [...existingConflicts.filter(c => !newUuids.has(c.uuid)), ...result.conflicts];
    await savePendingConflicts(merged);
  }

  // Anything reconciled or cleanly applied this round no longer needs
  // retrying; anything still reported as a skipped duplicate does -
  // otherwise, once its updated_at falls behind the new checkpoint
  // below, it would never get pushed again and would stay stuck.
  const resolvedUuids = new Set([
    ...(result.reconciled || []).map(r => r.local_uuid),
    ...(result.applied || []),
  ]);
  const stillStuck = (result.skipped_duplicates || []).filter(uuid => !resolvedUuids.has(uuid));
  const previousRetries = await getPendingRetryUuids();
  const nextRetries = [...new Set([...previousRetries.filter(u => !resolvedUuids.has(u)), ...stillStuck])];
  await setPendingRetryUuids(nextRetries);

  await setSetting('sync_last_synced_at', result.server_time);

  return {
    ok: true,
    pushed: push.length,
    pulled: (result.changes || []).length,
    conflicts: (result.conflicts || []).length,
    reconciled: (result.reconciled || []).length,
    skippedDuplicates: (result.skipped_duplicates || []).length,
    shippingPushed: pushShipping.length,
    shippingPulled: (result.shipping_changes || []).length,
    ordersPushed: pushOrders.length,
    ordersPulled: (result.order_changes || []).length,
  };
}

async function getSetting(key, fallback) {
  const result = await db.query('SELECT value FROM settings WHERE key = ?;', [key]);
  const row = result.values && result.values[0];
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
    [key, value]
  );
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function itemRowHtml(item, { daysLate = null, showBulkSelect = false } = {}) {
  const isPaid = item.charge_status === 'charged';
  const isCancelled = item.status === 'cancelled';
  return `
    <li class="item-row ${isPaid ? 'is-paid' : ''}" data-id="${item.id}">
      ${isCancelled
        ? '<span class="paid-circle-spacer"></span>'
        : `<button type="button" class="paid-circle ${isPaid ? 'is-checked' : ''}" data-toggle-paid="${item.id}" title="${isPaid ? 'Mark as unpaid' : 'Mark as paid'}" aria-label="${isPaid ? 'Mark as unpaid' : 'Mark as paid'}"></button>`}
      <span class="item-row-text">
        <span class="item-row-name ${isCancelled ? 'muted' : ''}">${isCancelled ? '<span class="search-status-tag">Cancelled</span> ' : ''}${daysLate !== null ? `<span class="search-status-tag">${daysLate}d late</span> ` : ''}${escapeHtml(item.name)}</span>
        <span class="item-row-meta">${item.shop ? escapeHtml(item.shop) + ' &middot; ' : ''}${formatSearchDateLabel(item.release_date)}${item.order_number ? ` &middot; <button type="button" class="link-btn" data-search-order="${escapeHtml(item.order_number)}">order #${escapeHtml(item.order_number)}</button>` : ''}</span>
      </span>
      <span class="item-row-actions">
        <span class="item-row-actions-main">
          <span class="item-row-price mono ${isCancelled ? 'muted' : ''}">${formatCurrency(item.price, currencySymbol)}</span>
          <div class="item-actions-group" data-actions-for="${item.id}">
            ${!isCancelled && showBulkSelect ? `<input type="checkbox" class="bulk-select" data-bulk-select="${item.id}" title="Select for bulk action">` : ''}
            <button type="button" class="actions-drawer-toggle" data-drawer-toggle="${item.id}" aria-label="More actions">&#8942;</button>
            <div class="actions-drawer">
              <button type="button" class="item-row-edit" data-edit-id="${item.id}" title="Edit" aria-label="Edit">Edit</button>
              ${isCancelled
                ? `<button type="button" class="btn-tiny btn-undo" data-undo-cancel-id="${item.id}">Undo</button>`
                : `
                  <button type="button" class="btn-tiny" data-cancel-id="${item.id}" title="Cancel this item">Cancel</button>
                  <button type="button" class="btn-tiny btn-remove-all" data-remove-id="${item.id}" title="Delete this entry permanently">Remove</button>
                `}
            </div>
          </div>
        </span>
        ${item.tracking_number ? `<a href="https://posttrack.com/en/parcel-tracking" target="_blank" rel="noopener" class="track-link-btn" data-tracking="${escapeHtml(item.tracking_number)}" title="Copy tracking number and open PostTrack">&#128230; ${escapeHtml(item.tracking_number)}</a>` : ''}
      </span>
    </li>
  `;
}

function openEditModal(item, onSaved) {
  const backdrop = document.createElement('div');
  backdrop.className = 'edit-modal-backdrop';
  backdrop.innerHTML = `
    <div class="edit-modal">
      <div class="edit-modal-head">
        <h2>Edit item</h2>
        <button type="button" class="edit-modal-close" aria-label="Close">&times;</button>
      </div>
      <form id="edit-item-form">
        <label>
          <span>Name</span>
          <input type="text" id="edit-field-name" required value="${escapeHtml(item.name)}">
        </label>
        <label>
          <span>Price</span>
          <input type="number" id="edit-field-price" step="0.01" min="0" required value="${item.price}">
        </label>
        <label>
          <span>Release date</span>
          <input type="date" id="edit-field-release-date" value="${item.release_date || ''}">
        </label>
        <label>
          <span>Shop</span>
          <input type="text" id="edit-field-shop" value="${item.shop ? escapeHtml(item.shop) : ''}">
        </label>
        <label>
          <span>Tracking number (optional)</span>
          <input type="text" id="edit-field-tracking-number" value="${item.tracking_number ? escapeHtml(item.tracking_number) : ''}" placeholder="e.g. NP678811691GB">
        </label>
        <label class="checkbox-row">
          <span class="toggle">
            <input type="checkbox" id="edit-field-already-paid" ${item.charge_status === 'charged' ? 'checked' : ''}>
            <span class="toggle-track"></span>
          </span>
          <span>Already paid</span>
        </label>
        <button type="submit">Save changes</button>
      </form>
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = () => { unregisterModal(close); backdrop.remove(); };
  registerModal(close);
  backdrop.querySelector('.edit-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#edit-item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const updated = {
      name: backdrop.querySelector('#edit-field-name').value,
      price: parseFloat(backdrop.querySelector('#edit-field-price').value),
      release_date: backdrop.querySelector('#edit-field-release-date').value || null,
      shop: backdrop.querySelector('#edit-field-shop').value || null,
      tracking_number: backdrop.querySelector('#edit-field-tracking-number').value || null,
      charge_status: backdrop.querySelector('#edit-field-already-paid').checked ? 'charged' : 'not_charged',
    };
    await updateItem(item.id, updated);
    close();
    await refreshAll();
    if (onSaved) onSaved();
  });
}

// A pure quick-view of everything in one order - no paid-toggle,
// cancel, or remove actions here, just the info at a glance plus an
// Edit button per item for when something actually needs changing.
function renderOrderOverviewRows(orderNumber) {
  const items = allItemsCache.filter(i => i.order_number === orderNumber);
  return items.map(item => `
    <li class="order-overview-row ${item.status === 'cancelled' ? 'muted' : ''}">
      <span class="order-overview-status" title="${item.charge_status === 'charged' ? 'Paid' : 'Not paid yet'}">${item.charge_status === 'charged' ? '&#9989;' : '&#9675;'}</span>
      <span class="item-row-text">
        <span class="item-row-name ${item.status === 'cancelled' ? 'muted' : ''}">${item.status === 'cancelled' ? '<span class="search-status-tag">Cancelled</span> ' : ''}${escapeHtml(item.name)}</span>
        <span class="item-row-meta">${formatSearchDateLabel(item.release_date)}</span>
      </span>
      <span class="item-row-price mono ${item.status === 'cancelled' ? 'muted' : ''}">${formatCurrency(item.price, currencySymbol)}</span>
      <button type="button" class="item-row-edit" data-order-edit-id="${item.id}" title="Edit" aria-label="Edit">Edit</button>
    </li>
  `).join('');
}

function openOrderOverviewModal(orderNumber) {
  const items = allItemsCache.filter(i => i.order_number === orderNumber);
  const shippingTotal = items.reduce((sum, i) => sum + (parseFloat(i.shipping) || 0), 0);

  const backdrop = document.createElement('div');
  backdrop.className = 'edit-modal-backdrop';
  backdrop.innerHTML = `
    <div class="edit-modal">
      <div class="edit-modal-head">
        <h2>Order #${escapeHtml(orderNumber)}</h2>
        <button type="button" class="edit-modal-close" aria-label="Close">&times;</button>
      </div>
      <ul class="item-list" id="order-overview-list">${renderOrderOverviewRows(orderNumber)}</ul>
      ${shippingTotal > 0 ? `
      <div class="order-overview-shipping">
        <span>Shipping for this order</span>
        <span class="mono">${formatCurrency(shippingTotal, currencySymbol)}</span>
      </div>
      ` : ''}
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = () => { unregisterModal(close); backdrop.remove(); };
  registerModal(close);
  backdrop.querySelector('.edit-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#order-overview-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-order-edit-id]');
    if (!btn) return;
    const item = allItemsCache.find(i => i.id === parseInt(btn.dataset.orderEditId, 10));
    if (item) {
      openEditModal(item, () => {
        const list = backdrop.querySelector('#order-overview-list');
        if (list) list.innerHTML = renderOrderOverviewRows(orderNumber);
      });
    }
  });
}

function renderConflictDiffTable(mine, theirs) {
  const fields = [
    ['name', 'Name'], ['price', 'Price'], ['status', 'Status'],
    ['charge_status', 'Paid'], ['release_date', 'Release date'], ['order_number', 'Order #'],
  ];
  const rows = fields
    .filter(([key]) => JSON.stringify(mine[key]) !== JSON.stringify(theirs[key]))
    .map(([key, label]) => `
      <div class="conflict-field-row">
        <span class="conflict-field-label">${escapeHtml(label)}</span>
        <span class="conflict-field-value">${escapeHtml(String(mine[key] ?? '\u2014'))}</span>
        <span class="conflict-field-value">${escapeHtml(String(theirs[key] ?? '\u2014'))}</span>
      </div>
    `).join('');
  return `
    <div class="conflict-field-row conflict-field-head">
      <span></span><span>This device</span><span>Server</span>
    </div>
    ${rows}
  `;
}

function renderConflictList(conflicts) {
  if (!conflicts.length) {
    return '<p class="muted item-form-hint">No conflicts left to review.</p>';
  }
  return conflicts.map(c => `
    <li class="conflict-row">
      <div class="conflict-row-title">${escapeHtml(c.mine.name || c.theirs.name || 'Unknown item')}</div>
      ${renderConflictDiffTable(c.mine, c.theirs)}
      <div class="conflict-row-actions">
        <button type="button" class="btn-tiny" data-conflict-action="mine" data-conflict-uuid="${escapeHtml(c.uuid)}">Keep this device's version</button>
        <button type="button" class="btn-tiny" data-conflict-action="theirs" data-conflict-uuid="${escapeHtml(c.uuid)}">Keep server's version</button>
      </div>
    </li>
  `).join('');
}

async function openConflictsModal() {
  let conflicts = await getPendingConflicts();
  const backdrop = document.createElement('div');
  backdrop.className = 'edit-modal-backdrop';
  backdrop.innerHTML = `
    <div class="edit-modal">
      <div class="edit-modal-head">
        <h2>Sync conflicts</h2>
        <button type="button" class="edit-modal-close" aria-label="Close">&times;</button>
      </div>
      <p class="muted item-form-hint">
        These items changed on both this device and the server since the last sync.
        Pick which version to keep for each - the other side gets updated to match on the next sync.
      </p>
      <ul class="item-list conflict-list" id="conflicts-list">${renderConflictList(conflicts)}</ul>
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = () => { unregisterModal(close); backdrop.remove(); };
  registerModal(close);
  backdrop.querySelector('.edit-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  backdrop.querySelector('#conflicts-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-conflict-action]');
    if (!btn) return;
    const uuid = btn.dataset.conflictUuid;
    const conflict = conflicts.find(c => c.uuid === uuid);
    if (!conflict) return;

    if (btn.dataset.conflictAction === 'mine') {
      await resolveConflictKeepMine(uuid);
    } else {
      await resolveConflictKeepTheirs(conflict.theirs);
    }

    conflicts = conflicts.filter(c => c.uuid !== uuid);
    await savePendingConflicts(conflicts);
    backdrop.querySelector('#conflicts-list').innerHTML = renderConflictList(conflicts);
    await updateConflictBanner();
    await refreshAll();

    if (!conflicts.length) close();
  });
}

async function updateConflictBanner() {
  const conflicts = await getPendingConflicts();
  const btn = document.getElementById('settings-sync-review-conflicts-btn');
  const line = document.getElementById('sync-conflicts-line');
  if (!btn || !line) return;
  if (conflicts.length) {
    btn.style.display = '';
    line.style.display = '';
    line.textContent = `${conflicts.length} item(s) need your review.`;
  } else {
    btn.style.display = 'none';
    line.style.display = 'none';
    line.textContent = '';
  }
}

function wireEditButtons(containerId) {
  document.getElementById(containerId).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit-id]');
    if (!btn) return;
    const id = parseInt(btn.dataset.editId, 10);
    const item = allItemsCache.find(i => i.id === id);
    if (item) openEditModal(item);
  });
}

function shopTabsHtml(shops) {
  return [
    `<button type="button" class="tab-btn ${!selectedShop ? 'active' : ''}" data-shop="">All shops</button>`,
    ...shops.map(s => `<button type="button" class="tab-btn ${selectedShop === s ? 'active' : ''}" data-shop="${escapeHtml(s)}" style="--shop-color: ${assignShopColor(s)};"><span class="tab-shop-dot"></span>${escapeHtml(s)}</button>`),
  ].join('');
}

function renderShopTabs(allItems) {
  const shops = [...new Set(allItems.map(i => i.shop).filter(Boolean).map(shopGroupName))].sort();
  const container = document.getElementById('dashboard-shop-tabs');
  if (shops.length < 2) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = shopTabsHtml(shops);
  container.querySelectorAll('[data-shop]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedShop = btn.dataset.shop;
      renderDashboard(allItemsCache);
    });
  });
}

/** A circular progress ring (percent 0-100+, capped visually at 100) with
 * the number in the centre - used for the budget ring on the dashboard. */
function renderProgressRing(containerId, percent, isOver) {
  const size = 96, stroke = 10, r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.min(percent, 100);
  const offset = circumference * (1 - clamped / 100);
  const color = isOver ? 'var(--neon-pink)' : 'var(--neon-blue)';
  document.getElementById(containerId).innerHTML = `
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
        transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central"
        class="progress-ring-label" fill="${color}">${percent}%</text>
    </svg>
  `;
}

// A genuine part-to-whole split (two categories that add up to the same
// total, e.g. pre-order vs released) - distinct from renderProgressRing,
// which is a single value against a fixed ceiling like a budget.
function renderTwoSegmentRing(containerId, pct1, color1, pct2, color2, centerValue, centerLabel) {
  const size = 100, stroke = 12, r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const offset1 = circumference * (1 - pct1 / 100);
  const offset2 = -(circumference * pct1 / 100);
  document.getElementById(containerId).innerHTML = `
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color1}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset1}"
        transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color2}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset2}"
        transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="${size / 2}" y="${size / 2 - 4}" text-anchor="middle" font-size="20" font-weight="700" fill="var(--text)">${centerValue}</text>
      <text x="${size / 2}" y="${size / 2 + 12}" text-anchor="middle" font-size="8" fill="var(--text-muted)">${centerLabel}</text>
    </svg>
  `;
}

function renderTrendSvg(trend, containerId, currencySymbol) {
  const width = 300, padding = 4;
  const areaH = 70, gap = 6, barsH = 24, labelGap = 14;
  const height = areaH + gap + barsH + labelGap;
  const gradientId = `trend-gradient-${containerId}`;
  const maxVal = Math.max(...trend.map(t => t.total), 1);
  const maxCount = Math.max(...trend.map(t => t.count ?? 0), 1);
  const stepX = (width - padding * 2) / (trend.length - 1);
  const barW = Math.min(10, stepX * 0.5);
  const barsTop = areaH + gap;

  const points = trend.map((t, i) => {
    const x = padding + i * stepX;
    const y = areaH - (t.total / maxVal) * areaH;
    return { x, y, label: t.label, ...t };
  });
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const areaPath = `${linePath} L${points[points.length - 1].x},${areaH} L${points[0].x},${areaH} Z`;
  const hitW = stepX || width;

  const container = document.getElementById(containerId);
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2fd8ff" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="#2fd8ff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path class="trend-area" d="${areaPath}" fill="url(#${gradientId})"/>
      <path class="trend-line" d="${linePath}"/>
      ${points.map(p => `<circle class="trend-dot" cx="${p.x}" cy="${p.y}" r="2.5"/>`).join('')}
      ${points.map(p => {
        const count = p.count ?? 0;
        const barH = maxCount ? (count / maxCount) * barsH : 0;
        const barY = barsTop + barsH - barH;
        return `<rect class="trend-count-bar" x="${p.x - barW / 2}" y="${barY}" width="${barW}" height="${barH}" rx="1.5"/>`;
      }).join('')}
      ${points.map(p => `<text class="trend-label" x="${p.x}" y="${barsTop + barsH + 11}" text-anchor="middle">${p.label}</text>`).join('')}
      ${points.map((p, i) => `
        <rect class="trend-hit" data-i="${i}" x="${p.x - hitW / 2}" y="0" width="${hitW}" height="${barsTop + barsH}"/>
      `).join('')}
      <line class="trend-guide" x1="0" x2="0" y1="0" y2="${barsTop + barsH}" style="display:none;"/>
      <circle class="trend-dot trend-dot-active" r="4.5" style="display:none;"/>
    </svg>
    <div class="trend-tooltip hidden">
      <div class="trend-tooltip-label"></div>
      <div class="trend-tooltip-row"><span>Comics</span><span class="mono tt-comics"></span></div>
      <div class="trend-tooltip-row"><span>Shipping</span><span class="mono tt-shipping"></span></div>
      <div class="trend-tooltip-row trend-tooltip-total"><span>Total</span><span class="mono tt-total"></span></div>
      <div class="trend-tooltip-count"></div>
    </div>
  `;

  const svg = container.querySelector('svg');
  const tooltip = container.querySelector('.trend-tooltip');
  const guide = svg.querySelector('.trend-guide');
  const activeDot = svg.querySelector('.trend-dot-active');
  const sym = currencySymbol || '£';

  function showForPoint(p) {
    tooltip.classList.remove('hidden');
    tooltip.querySelector('.trend-tooltip-label').textContent = p.label;
    tooltip.querySelector('.tt-comics').textContent = formatCurrency(p.comics ?? p.total, sym);
    tooltip.querySelector('.tt-shipping').textContent = formatCurrency(p.shipping ?? 0, sym);
    tooltip.querySelector('.tt-total').textContent = formatCurrency(p.total, sym);
    const count = p.count ?? 0;
    tooltip.querySelector('.trend-tooltip-count').textContent = `${count} ${count === 1 ? 'comic' : 'comics'} this period`;
    guide.setAttribute('x1', p.x); guide.setAttribute('x2', p.x); guide.style.display = '';
    activeDot.setAttribute('cx', p.x); activeDot.setAttribute('cy', p.y); activeDot.style.display = '';

    const rect = container.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const scaleX = svgRect.width / width;
    const cursorX = p.x * scaleX;
    const tooltipWidth = tooltip.offsetWidth || 150;
    const left = (cursorX + 14 + tooltipWidth > rect.width) ? cursorX - 14 - tooltipWidth : cursorX + 14;
    tooltip.style.left = `${Math.max(0, left)}px`;
    tooltip.style.top = '0px';
  }

  svg.querySelectorAll('.trend-hit').forEach(hit => {
    const p = points[parseInt(hit.dataset.i, 10)];
    hit.addEventListener('click', () => showForPoint(p));
    hit.addEventListener('touchstart', (e) => { e.preventDefault(); showForPoint(p); }, { passive: false });
  });
}

function hideAllTrendTooltips(exceptContainer) {
  document.querySelectorAll('.trend-chart-wrap').forEach(c => {
    if (c === exceptContainer) return;
    const tooltip = c.querySelector('.trend-tooltip');
    const guide = c.querySelector('.trend-guide');
    const activeDot = c.querySelector('.trend-dot-active');
    if (tooltip) tooltip.classList.add('hidden');
    if (guide) guide.style.display = 'none';
    if (activeDot) activeDot.style.display = 'none';
  });
}

// Registered once (not per render, unlike the per-point handlers above) so
// tapping outside any trend chart closes its tooltip, without stacking a
// fresh document-level listener on every dashboard/insights refresh.
function initTrendTooltipDismissal() {
  const dismiss = (e) => {
    const openWrap = e.target.closest('.trend-chart-wrap');
    hideAllTrendTooltips(openWrap || null);
  };
  document.addEventListener('touchstart', dismiss);
  document.addEventListener('click', dismiss);
}

// Mirrors the web app's WEEK / MONTH / 6M range tabs on the dashboard chart.
// "6month" intentionally shows the trailing 6 months of actual spend rather
// than the web app's back:0/forward:5 window, since that forward window
// exists there to blend into its shipping-based forecast - which has no
// equivalent here without the order parsers.
let dashboardChartRange = 'month';

function getDashboardTrend(items) {
  if (dashboardChartRange === 'week') return buildWeeklySpendTrend(items, 4, 8, getToday());
  if (dashboardChartRange === '6month') return buildMonthlySpendTrendRange(items, 5, 0, getToday());
  return buildMonthlySpendTrendRange(items, 3, 5, getToday());
}

async function dismissDuplicate(name, releaseDate) {
  dismissedDuplicates.add(`${name}|||${releaseDate}`);
  await setSetting('dismissed_duplicates', JSON.stringify([...dismissedDuplicates]));
  await refreshAll();
}

function renderDuplicates(allItems) {
  const groups = findDuplicateGroups(allItems, dismissedDuplicates);
  const section = document.getElementById('duplicates-section');
  if (groups.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  document.getElementById('duplicates-groups').innerHTML = groups.map(group => `
    <div class="cal-agenda-group group-warning">
      <div class="cal-agenda-head">
        <span>${group.release_date} &middot; ${escapeHtml(group.name)}</span>
        <button type="button" class="btn-tiny" data-dismiss-dup-name="${escapeHtml(group.name)}" data-dismiss-dup-date="${group.release_date}">Not a duplicate</button>
      </div>
      <ul class="item-list">${group.entries.map(item => itemRowHtml(item, { showBulkSelect: true })).join('')}</ul>
    </div>
  `).join('');
  document.querySelectorAll('[data-dismiss-dup-name]').forEach(btn => {
    btn.addEventListener('click', () => dismissDuplicate(btn.dataset.dismissDupName, btn.dataset.dismissDupDate));
  });
}

function renderGhostItems(allItems) {
  const ghosts = findGhostItems(allItems);
  const section = document.getElementById('ghost-items-section');
  if (ghosts.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  document.getElementById('ghost-items-count').textContent = `Items with no order number (${ghosts.length})`;
  document.getElementById('ghost-items-list').innerHTML =
    ghosts.map(item => itemRowHtml(item, { showBulkSelect: true })).join('');
  const removeAllBtn = document.getElementById('ghost-items-remove-all-btn');
  removeAllBtn.onclick = async () => {
    if (!window.confirm(`Remove all ${ghosts.length} of these permanently? This cannot be undone.`)) return;
    for (const item of ghosts) await deleteItem(item.id);
    await refreshAll();
  };
}

function renderRecentlyCancelled(allItems) {
  const recent = findRecentlyCancelled(allItems);
  const section = document.getElementById('recently-cancelled-section');
  if (recent.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  document.getElementById('recently-cancelled-list').innerHTML =
    recent.map(item => itemRowHtml(item)).join('');
}

function renderAwaitingCharge(allItems) {
  const overdue = findAwaitingCharge(allItems, getToday());
  const section = document.getElementById('awaiting-charge-section');
  if (overdue.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  document.getElementById('awaiting-charge-count').textContent = `Awaiting charge (${overdue.length})`;
  document.getElementById('awaiting-charge-list').innerHTML =
    overdue.map(item => itemRowHtml(item, { daysLate: item.days_late, showBulkSelect: true })).join('');
}

// Shows the real, exact shipping captured for a shop-group (from a
// Forbidden Planet or eBay order-detail paste) - only when every item
// in the group actually has one, so this is never a guess. Groups
// without complete real data show nothing yet - a calibrated or
// default estimate for those is a separate piece of work still to do.
function shipmentGroupShippingHtml(sg, allPaid) {
  const relevant = sg.items.filter(i => i.status !== 'cancelled');
  if (relevant.length === 0 || !relevant.every(i => i.shipping != null)) return '';
  const total = Math.round(relevant.reduce((sum, i) => sum + i.shipping, 0) * 100) / 100;
  const label = total === 0 ? 'Free shipping' : `+ ${formatCurrency(total, currencySymbol)} shipping`;
  return `<div class="group-ship mono">${label} (${escapeHtml(sg.shop)})${allPaid ? ' - paid' : ''}</div>`;
}

// Shared renderer for the two "shipment groups" sections on Dashboard
// (This week / Month, by shipment) - each date is its own collapsible
// accordion (closed by default, same interaction as Calendar's agenda),
// and each date can hold more than one shop sub-group ("shipment") when
// several orders release the same day.
function renderShipmentGroups(groups, groupsElId, idPrefix, emptyText, extraEmptyHtml, defaultOpenDate) {
  const groupsEl = document.getElementById(groupsElId);
  if (groups.length === 0) {
    groupsEl.innerHTML = `<p class="muted">${emptyText}</p>${extraEmptyHtml || ''}`;
    return;
  }

  groupsEl.innerHTML = groups.map(group => `
    <div class="cal-agenda-group ${group.allPaid ? 'all-paid' : ''}" id="${idPrefix}-group-${group.date}">
      <div class="cal-agenda-head ${group.allPaid ? 'all-paid' : ''}" data-toggle="${group.date}">
        <span>${group.dateLabel}${group.allPaid ? ' &middot; paid' : ''}</span>
        <span class="cal-agenda-head-right">
          <span class="mono">${formatCurrency(group.subtotal, currencySymbol)}</span>
          <span class="cal-accordion-arrow">${group.date === defaultOpenDate ? '&#9662;' : '&#9656;'}</span>
        </span>
      </div>
      <div class="cal-agenda-body${group.date === defaultOpenDate ? '' : ' collapsed'}" id="${idPrefix}-body-${group.date}">
        ${group.shopGroups.map(sg => `
          <div class="source-subgroup">
            <div class="shop-row">
              <span class="shop-row-label" style="color: ${sg.color};"><span class="source-dot" style="background: ${sg.color};"></span>${escapeHtml(sg.shop)}</span>
              <span class="mono">${formatCurrency(sg.subtotal, currencySymbol)}</span>
            </div>
            <ul class="item-list">${sg.items.map(item => itemRowHtml(item, { showBulkSelect: true })).join('')}</ul>
            ${shipmentGroupShippingHtml(sg, group.allPaid)}
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');

  groupsEl.querySelectorAll('[data-toggle]').forEach(head => {
    head.addEventListener('click', () => {
      const body = document.getElementById(`${idPrefix}-body-${head.dataset.toggle}`);
      if (!body) return;
      body.classList.toggle('collapsed');
      const arrow = head.querySelector('.cal-accordion-arrow');
      if (arrow) arrow.innerHTML = body.classList.contains('collapsed') ? '&#9656;' : '&#9662;';
    });
  });
}

/** Matches the web app's own eBay-filter hint: eBay orders are usually
 * already paid and delivered by the time they'd show up in a due-soon
 * list, so an empty This-week/Month-by-shipment view while filtered to
 * eBay is expected, not a sign anything's missing - point at Search
 * instead, where the full eBay history actually lives. */
function ebayFilterHintHtml() {
  return '<p class="muted ebay-filter-hint">eBay orders are usually already paid and delivered, so they won\'t show up here often - try <button type="button" class="link-btn" id="ebay-hint-search-link">Search</button> to browse your full eBay history instead.</p>';
}

function wireEbayFilterHintLinks() {
  document.querySelectorAll('#ebay-hint-search-link').forEach(btn => {
    btn.addEventListener('click', () => switchView('search'));
  });
}

function renderThisWeek(items) {
  const weekItems = findNextWeekReleases(items, getToday());
  const totals = computeSpentRemainingWithShipping(weekItems);
  document.getElementById('this-week-total').textContent =
    `${formatCurrency(totals.remaining, currencySymbol)} left of ${formatCurrency(computeStillDueTotalWithShipping(weekItems), currencySymbol)}`;
  renderShipmentGroups(
    groupItemsByDateAndShop(weekItems), 'this-week-groups', 'this-week', 'Nothing due in the next 7 days.',
    selectedShop === 'eBay' ? ebayFilterHintHtml() : '',
  );
  wireEbayFilterHintLinks();
}

function renderMonthByShipment(items) {
  const now = getToday();
  const monthItems = itemsInMonth(items, dashYear, dashMonth);
  const isCurrentMonth = dashYear === now.getFullYear() && dashMonth === now.getMonth();
  document.getElementById('dash-shipment-month-label').textContent = `${MONTH_NAMES[dashMonth]} ${dashYear}, by shipment`;
  document.getElementById('dash-shipment-today-btn').classList.toggle('hidden', isCurrentMonth);
  const totals = computeSpentRemainingWithShipping(monthItems);
  document.getElementById('dash-shipment-total').textContent =
    `${formatCurrency(totals.remaining, currencySymbol)} left of ${formatCurrency(computeStillDueTotalWithShipping(monthItems), currencySymbol)}`;
  renderShipmentGroups(
    groupItemsByDateAndShop(monthItems), 'dash-shipment-groups', 'dash-shipment',
    `Nothing due in ${MONTH_NAMES[dashMonth]} ${dashYear}.`,
    selectedShop === 'eBay' ? ebayFilterHintHtml() : '',
  );
  wireEbayFilterHintLinks();
}

function renderDashboard(allItems) {
  const now = getToday();
  renderShopTabs(allItems);
  renderDuplicates(allItems);
  renderGhostItems(allItems);
  renderAwaitingCharge(allItems);
  const items = filterByShop(allItems, selectedShop);

  const currentMonthItems = itemsInMonth(items, now.getFullYear(), now.getMonth());
  const currentMonthTotals = computeSpentRemainingWithShipping(currentMonthItems);
  const monthTotal = currentMonthTotals.spent + currentMonthTotals.remaining;
  const paidPct = monthTotal > 0 ? Math.round((currentMonthTotals.spent / monthTotal) * 100) : 0;
  document.getElementById('still-due-total').textContent = formatCurrency(currentMonthTotals.remaining, currencySymbol);
  renderProgressRing('still-due-ring-wrap', paidPct, false);
  document.getElementById('still-due-caption').textContent =
    `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()} \u00b7 ${currentMonthItems.length} item${currentMonthItems.length !== 1 ? 's' : ''} this month`;
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextMonthSpend = computeMonthSpendWithFallback(items, nextMonth.getFullYear(), nextMonth.getMonth());
  document.getElementById('next-month-forecast').textContent =
    `${MONTH_NAMES[nextMonth.getMonth()]} is forecast at ${formatCurrency(nextMonthSpend, currencySymbol)} so far.`;

  const est = defaultSourceShippingEstimate;
  const noteEl = document.getElementById('shipping-estimate-note');
  if (est.tier === 'exact') {
    noteEl.textContent = `Shipping estimated at ${formatCurrency(est.rate, currencySymbol)} per parcel \u00b7 based on ${est.samples} actual shipment${est.samples !== 1 ? 's' : ''} from your order pages`;
  } else {
    noteEl.textContent = `Shipping estimated at ${formatCurrency(est.rate, currencySymbol)} per parcel \u00b7 default estimate - only ${est.samples} real shipment${est.samples !== 1 ? 's' : ''} logged so far (need at least 3)`;
  }

  renderThisWeek(items);

  const monthSpend = computeCycleSpend(items, budgetCycle, now);
  const effectiveBudget = computeEffectiveBudget(monthlyBudget, budgetCycle, budgetRollover, items, now);
  const progress = computeBudgetProgress(monthSpend, effectiveBudget);
  if (progress === null) {
    document.getElementById('budget-ring-wrap').closest('.dual-ring-col').style.display = 'none';
    document.querySelector('.dual-ring-divider').style.display = 'none';
  } else {
    document.getElementById('budget-ring-wrap').closest('.dual-ring-col').style.display = '';
    document.querySelector('.dual-ring-divider').style.display = '';
    const isOver = monthSpend > effectiveBudget;
    document.getElementById('budget-line').textContent =
      `${formatCurrency(monthSpend, currencySymbol)} of ${formatCurrency(effectiveBudget, currencySymbol)}`;
    renderProgressRing('budget-ring-wrap', progress, isOver);
  }

  renderMonthByShipment(items);
  renderRecentlyCancelled(allItems);

  const yearStats = computeYearStats(items, now.getFullYear());
  document.getElementById('year-stats-label-text').textContent = `${now.getFullYear()} so far`;
  document.getElementById('year-stats-line').textContent =
    `${formatCurrency(yearStats.year.spent, currencySymbol)} spent · ${formatCurrency(yearStats.year.total, currencySymbol)} tracked total across ${yearStats.year.count} item${yearStats.year.count !== 1 ? 's' : ''} this year.`;
  document.getElementById('all-time-stats-line').textContent =
    `All time: ${formatCurrency(yearStats.allTime.spent, currencySymbol)} spent · ${formatCurrency(yearStats.allTime.total, currencySymbol)} tracked total across ${yearStats.allTime.count} item${yearStats.allTime.count !== 1 ? 's' : ''}.`;

  renderTrendSvg(getDashboardTrend(items), 'spend-trend-chart', currencySymbol);

  const priciest = findPriciestItem(items);
  document.getElementById('stat-total-tracked').textContent = formatCurrency(computeStillDueTotal(items.filter(i => i.status !== 'cancelled')), currencySymbol);
  document.getElementById('stat-priciest').textContent = priciest ? formatCurrency(priciest.price, currencySymbol) : formatCurrency(0, currencySymbol);
  document.getElementById('stat-average').textContent = formatCurrency(computeAveragePrice(items), currencySymbol);
  const dashPriciestNote = document.getElementById('stat-priciest-note');
  if (priciest) {
    dashPriciestNote.textContent = `Priciest so far: ${priciest.name}, ${formatCurrency(priciest.price, currencySymbol)}.`;
    dashPriciestNote.dataset.editId = priciest.id;
    dashPriciestNote.classList.remove('hidden');
  } else {
    dashPriciestNote.classList.add('hidden');
  }

  syncBulkSelection(selectedDashboardIds, updateDashboardBulkToolbar, ['awaiting-charge-list', 'this-week-groups', 'dash-shipment-groups', 'duplicates-groups', 'ghost-items-list']);
}

let knownShops = [];
let sessionLastShop = null;

function renderLogOrders(items) {
  const shopField = document.getElementById('field-shop');
  if (sessionLastShop && !shopField.value) {
    shopField.value = sessionLastShop;
  }
  knownShops = [...new Set(items.map(i => i.shop).filter(Boolean))].sort();
}

function renderCalendarShopTabs(allItems) {
  const shops = [...new Set(allItems.map(i => i.shop).filter(Boolean).map(shopGroupName))].sort();
  const container = document.getElementById('calendar-shop-tabs');
  if (shops.length < 2) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = shopTabsHtml(shops);
  container.querySelectorAll('[data-shop]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedShop = btn.dataset.shop;
      renderCalendar(allItemsCache);
    });
  });
}

function renderCalendar(allItems) {
  renderCalendarShopTabs(allItems);
  const items = filterByShop(allItems, selectedShop);
  const now = getToday();

  document.getElementById('cal-month-label').textContent = `${MONTH_NAMES[calMonth]} ${calYear}`;
  const isCurrentMonth = calYear === now.getFullYear() && calMonth === now.getMonth();
  document.getElementById('cal-today-btn').classList.toggle('hidden', isCurrentMonth);
  const weeks = buildCalendarGrid(items, calYear, calMonth, now);
  const gridEl = document.getElementById('cal-grid');

  gridEl.innerHTML = weeks.flat().map(day => {
    if (day === null) return '<div class="cal-day cal-day-empty"></div>';
    const hasItems = day.items.length > 0;
    const classes = ['cal-day'];
    if (hasItems) classes.push('cal-has-items');
    if (day.isToday) classes.push('cal-today');
    if (day.date === selectedCalDate) classes.push('cal-day-selected');
    return `
      <div class="${classes.join(' ')}" ${hasItems ? `data-jump-date="${day.date}"` : ''}>
        <span>${day.day}</span>
        ${hasItems ? `
          <span class="cal-day-total">${formatCurrency(day.total, currencySymbol)}</span>
          <span class="cal-day-count">${day.items.length} issue${day.items.length !== 1 ? 's' : ''}</span>
        ` : ''}
      </div>
    `;
  }).join('');

  document.getElementById('cal-agenda-label').textContent = `${MONTH_NAMES[calMonth]} ${calYear} releases`;
  renderCalendarAgenda(items);
}

function renderCalendarAgenda(items) {
  const monthItems = itemsInMonth(items, calYear, calMonth);
  const groups = groupItemsByDateAndShop(monthItems);

  renderShipmentGroups(groups, 'cal-agenda', 'cal-agenda', 'Nothing due this month.', '', null);
  syncBulkSelection(selectedCalendarIds, updateCalendarBulkToolbar, ['cal-agenda']);
}

function populateSearchShopDropdown(allItems) {
  const shops = [...new Set(allItems.map(i => i.shop).filter(Boolean))].sort();
  const select = document.getElementById('search-shop');
  const current = select.value;
  select.innerHTML = '<option value="">All shops</option>' + shops.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  select.value = current;
}

function updateActiveDatePreset(startDate, endDate) {
  const now = getToday();
  const y = now.getFullYear(), m = now.getMonth();
  const pad = (n) => String(n).padStart(2, '0');
  const monthStart = `${y}-${pad(m + 1)}-01`;
  const monthEnd = `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`;
  const yearStart = `${y}-01-01`;
  const yearEnd = `${y}-12-31`;

  let active = null;
  if (startDate === monthStart && endDate === monthEnd) active = 'month';
  else if (startDate === yearStart && endDate === yearEnd) active = 'year';

  document.querySelectorAll('.date-preset-btn[data-preset]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === active);
  });

  const label = document.getElementById('search-preset-label');
  if (active) {
    label.classList.remove('hidden');
    label.innerHTML = `Showing: <strong>${active === 'month' ? 'This Month' : 'This Year'}</strong> (${active === 'month' ? now.toLocaleString('en-GB', { month: 'long', year: 'numeric' }) : y})`;
  } else {
    label.classList.add('hidden');
  }
}

let selectedSearchIds = new Set();
let lastSearchResults = [];

function renderSearch(allItems) {
  populateSearchShopDropdown(allItems);
  const query = document.getElementById('search-query').value;
  const minPrice = document.getElementById('search-min-price').value;
  const maxPrice = document.getElementById('search-max-price').value;
  const startDate = document.getElementById('search-start-date').value;
  const endDate = document.getElementById('search-end-date').value;
  const shop = document.getElementById('search-shop').value;
  const status = document.getElementById('search-status').value;
  const sortKey = document.getElementById('search-sort').value;
  const includeUndated = document.getElementById('search-include-undated').checked;

  let results = [];
  const filterActive = hasActiveSearchFilter({ query, minPrice, maxPrice, startDate, endDate, shop, status });
  if (filterActive) {
    results = filterItems(allItems, { query, minPrice, maxPrice, startDate, endDate, shop, includeUndated });
    results = results.filter(i => matchesStatusFilter(i, status));
    results = sortItemsBy(results, sortKey);
  }
  lastSearchResults = results;

  // Drop any selected id that's no longer in the current result set (e.g.
  // the filter changed, or the item was removed), so the bulk toolbar's
  // count never refers to something no longer visible.
  const resultIds = new Set(results.map(i => i.id));
  selectedSearchIds = new Set([...selectedSearchIds].filter(id => resultIds.has(id)));
  updateBulkToolbar();

  updateActiveDatePreset(startDate, endDate);
  document.getElementById('sort-most-expensive-btn').classList.toggle('active', sortKey === 'price_desc');
  document.getElementById('sort-cheapest-btn').classList.toggle('active', sortKey === 'price_asc');

  const totalsEl = document.getElementById('search-totals-row');
  if (results.length === 0) {
    totalsEl.innerHTML = '';
  } else {
    const totals = computeSearchTotals(results);
    totalsEl.innerHTML = `
      <span><span class="mono">${results.length}</span> match${results.length !== 1 ? 'es' : ''}</span>
      <span class="search-totals-spent">Spent: <span class="mono">${formatCurrency(totals.spent, currencySymbol)}</span></span>
      <span class="search-totals-remaining">Still due: <span class="mono">${formatCurrency(totals.remaining, currencySymbol)}</span></span>
      ${totals.cancelledCount ? `<span>+ ${totals.cancelledCount} cancelled (${formatCurrency(totals.cancelledTotal, currencySymbol)}, not counted above)</span>` : ''}
      <button type="button" class="btn-tiny search-csv-btn" id="search-csv-btn">Download CSV</button>
    `;
  }

  const resultsEl = document.getElementById('search-results');
  resultsEl.innerHTML = !filterActive
    ? '<li class="muted item-list-empty">Type a name, pick a shop, or set a date range to start.</li>'
    : results.length === 0
      ? '<li class="muted item-list-empty">No matches.</li>'
      : results.map(item => itemRowHtml(item, { showBulkSelect: true })).join('');
  resultsEl.querySelectorAll('[data-bulk-select]').forEach(cb => {
    cb.checked = selectedSearchIds.has(parseInt(cb.dataset.bulkSelect, 10));
  });
}

function updateBulkToolbar() {
  const toolbar = document.getElementById('bulk-toolbar');
  const count = selectedSearchIds.size;
  toolbar.classList.toggle('hidden', count === 0);
  document.getElementById('bulk-count').textContent = `${count} selected`;
}

let selectedDashboardIds = new Set();
let selectedCalendarIds = new Set();

function updateDashboardBulkToolbar() {
  const toolbar = document.getElementById('dashboard-bulk-toolbar');
  const count = selectedDashboardIds.size;
  toolbar.classList.toggle('hidden', count === 0);
  document.getElementById('dashboard-bulk-count').textContent = `${count} selected`;
}

function updateCalendarBulkToolbar() {
  const toolbar = document.getElementById('calendar-bulk-toolbar');
  const count = selectedCalendarIds.size;
  toolbar.classList.toggle('hidden', count === 0);
  document.getElementById('calendar-bulk-count').textContent = `${count} selected`;
}

/** Drops any selected id no longer rendered in these containers (filter
 * changed, item removed, etc.), reflects the surviving selection back onto
 * the checkboxes, and refreshes the toolbar - shared by Dashboard, Calendar,
 * and Search so each behaves identically after a re-render. */
function syncBulkSelection(selectionSet, updateToolbarFn, containerIds) {
  const visibleIds = new Set();
  containerIds.forEach(cid => {
    document.querySelectorAll(`#${cid} [data-bulk-select]`).forEach(cb => visibleIds.add(parseInt(cb.dataset.bulkSelect, 10)));
  });
  for (const id of [...selectionSet]) {
    if (!visibleIds.has(id)) selectionSet.delete(id);
  }
  containerIds.forEach(cid => {
    document.querySelectorAll(`#${cid} [data-bulk-select]`).forEach(cb => {
      cb.checked = selectionSet.has(parseInt(cb.dataset.bulkSelect, 10));
    });
  });
  updateToolbarFn();
}


/** Small up/down trend indicator for a stat box - e.g. "↑ 12% vs your
 * average" - comparing a current figure against a baseline. Skips
 * rendering anything when the baseline is 0 (nothing to compare against). */
function renderStatTrend(elementId, current, baseline, label) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (!baseline || baseline <= 0) { el.textContent = ''; return; }
  const diffPct = Math.round(((current - baseline) / baseline) * 100);
  if (diffPct === 0) {
    el.textContent = `On par ${label}`;
    el.className = 'stat-trend';
    return;
  }
  const isUp = diffPct > 0;
  el.innerHTML = `${isUp ? '&#9650;' : '&#9660;'} ${Math.abs(diffPct)}% ${label}`;
  el.className = `stat-trend ${isUp ? 'trend-up' : 'trend-down'}`;
}

function renderInsights(items) {
  const now = getToday();
  const bestMonth = findMostExpensiveMonth(items);
  document.getElementById('insights-best-month').textContent = bestMonth
    ? `${formatCurrency(bestMonth.total, currencySymbol)}` : 'No dated items yet';
  document.getElementById('insights-best-month-sub').textContent = bestMonth
    ? `${new Date(`${bestMonth.month}-01T00:00:00`).toLocaleString('en-GB', { month: 'long', year: 'numeric' })} \u00b7 ${bestMonth.count} issue${bestMonth.count !== 1 ? 's' : ''}`
    : '';

  const priciest = findPriciestItem(items);
  document.getElementById('insights-priciest').textContent = priciest ? formatCurrency(priciest.price, currencySymbol) : formatCurrency(0, currencySymbol);
  const priciestSub = document.getElementById('insights-priciest-sub');
  if (priciest) {
    priciestSub.textContent = `Priciest so far: ${priciest.name}, ${formatCurrency(priciest.price, currencySymbol)}.`;
    priciestSub.dataset.editId = priciest.id;
    priciestSub.classList.remove('hidden');
  } else {
    priciestSub.classList.add('hidden');
  }

  const yearStats = computeYearStats(items, now.getFullYear());
  document.getElementById('insights-count').textContent = String(yearStats.allTime.count);

  const avgVsPriciestPct = computeAvgVsPriciestIssuePct(items);
  document.getElementById('insights-avg-vs-priciest-label').textContent = `${avgVsPriciestPct}% of priciest`;
  document.getElementById('insights-avg-vs-priciest-fill').style.width = `${Math.min(avgVsPriciestPct, 100)}%`;

  const split = computeAllTimeComicsVsShippingSplit(items);
  document.getElementById('insights-comics-shipping-label').textContent =
    `${formatCurrency(split.comicsTotal, currencySymbol)} \u00b7 ${formatCurrency(split.shippingTotal, currencySymbol)}`;
  document.getElementById('insights-comics-fill').style.width = `${split.comicsPct}%`;
  document.getElementById('insights-shipping-split-fill').style.width = `${split.shippingPct}%`;

  document.getElementById('insights-count-sub').textContent = `${formatCurrency(split.comicsTotal + split.shippingTotal, currencySymbol)} total, all time`;
  const monthsTracked = countAllTimeMonthsWithData(items);
  const avgPerMonth = (split.comicsTotal + split.shippingTotal) / monthsTracked;
  document.getElementById('insights-avg-per-month').textContent = formatCurrency(avgPerMonth, currencySymbol);
  document.getElementById('insights-average').textContent = formatCurrency(computeAveragePrice(items), currencySymbol);

  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthSpend = computeMonthSpend(items, lastMonth.getFullYear(), lastMonth.getMonth());
  renderStatTrend('insights-avg-per-month-trend', lastMonthSpend, avgPerMonth, 'vs your average (last month)');

  document.getElementById('insights-spend-note').textContent = bestMonth
    ? `${new Date(`${bestMonth.month}-01T00:00:00`).toLocaleString('en-GB', { month: 'long' })} was your priciest month so far.`
    : 'Nothing dated yet - add a few items to see spend patterns.';

  const budgetBarWrap = document.getElementById('insights-budget-bar-wrap');
  const thisMonthSpend = computeMonthSpend(items, now.getFullYear(), now.getMonth());
  const budgetPct = computeBudgetProgress(thisMonthSpend, monthlyBudget);
  if (budgetPct === null) {
    budgetBarWrap.classList.add('hidden');
  } else {
    budgetBarWrap.classList.remove('hidden');
    document.getElementById('insights-budget-bar-label').textContent =
      `${formatCurrency(thisMonthSpend, currencySymbol)} of ${formatCurrency(monthlyBudget, currencySymbol)} \u00b7 ${budgetPct}%`;
    const fill = document.getElementById('insights-budget-bar-fill');
    fill.style.width = `${budgetPct}%`;
    fill.style.background = budgetPct >= 100 ? 'var(--neon-pink)' : 'var(--neon-blue)';
  }

  const preorderPct = computePreorderPct(items);
  const releasedPct = Math.round((100 - preorderPct) * 10) / 10;
  const { preorder: preorderCount, released: releasedCount } = computePreorderVsReleased(items);
  renderTwoSegmentRing(
    'insights-preorder-ring', preorderPct, 'var(--neon-blue)', releasedPct, 'var(--neon-violet)',
    preorderCount + releasedCount, 'issues',
  );
  document.getElementById('insights-preorder-legend-pct').textContent = `${preorderPct}%`;
  document.getElementById('insights-released-legend-pct').textContent = `${releasedPct}%`;

  const upcoming = findUpcomingReleases(items, now, 2);
  const comingUpWrap = document.getElementById('insights-coming-up-wrap');
  if (upcoming.length === 0) {
    comingUpWrap.classList.add('hidden');
  } else {
    comingUpWrap.classList.remove('hidden');
    document.getElementById('insights-coming-up-list').innerHTML = upcoming.map(item => `
      <div class="insight-next-list-row">
        <span class="insight-next-list-when mono">${item.daysUntilLabel}</span>
        <span class="insight-next-list-name">${escapeHtml(item.name)}</span>
        <span class="insight-next-list-price mono">${formatCurrency(item.price, currencySymbol)}</span>
      </div>
    `).join('');
  }
  const shippingRatioPct = computeShippingRatioPct(items);
  document.getElementById('insights-shipping-ratio').textContent = `${shippingRatioPct}%`;

  const weekdayChart = computeWeekdayReleaseChart(items);
  document.getElementById('insights-weekday-chart').innerHTML = weekdayChart.map(day => `
    <div class="insight-weekday-bar-wrap">
      <div class="insight-weekday-bar" style="height: ${day.barPct}%; background: ${day.isBusiest ? 'var(--neon-pink)' : 'var(--neon-blue)'};"></div>
      <span class="insight-weekday-label">${day.label}</span>
    </div>
  `).join('');

  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  document.getElementById('insights-next-month').textContent = formatCurrency(computeMonthSpendWithFallback(items, nextMonth.getFullYear(), nextMonth.getMonth()), currencySymbol);

  const shipping = computeShippingStats(items);
  // "Average shipping per month" - total shipping spread across every
  // month tracked, not a per-charge average (the label says "per month",
  // so the number needs to actually mean that, matching the web app).
  // This part correctly uses the full blended (real + estimated) total,
  // same as the webui's own avg_shipping_per_month.
  const avgShippingPerMonth = shipping.total / monthsTracked;
  // "Biggest shipping charge" specifically is real-data-only on the
  // webui, undivided - never an estimate, and never a per-item share of
  // a real shipment split across several items. Sourced from the raw
  // order_shipping rows rather than computeShippingStats, which mixes
  // real and estimated per-item shares together (correct for the total,
  // wrong for "biggest single real charge").
  const biggestReal = rawRealShipments.length
    ? rawRealShipments.reduce((max, r) => (r.amount > max.amount ? r : max), rawRealShipments[0])
    : null;
  document.getElementById('insights-shipping-note').textContent = biggestReal
    ? `Biggest shipping charge was ${formatCurrency(biggestReal.amount, currencySymbol)} (${biggestReal.source || 'Unknown shop'}) \u00b7 averaging ${formatCurrency(avgShippingPerMonth, currencySymbol)}/month.`
    : 'Biggest shipping charge and avg shipping/month need a few real postage figures logged first.';

  const busiest = findBusiestWeekday(items);
  document.getElementById('insights-busiest-day').textContent = busiest
    ? `${busiest.day} (${busiest.count})` : 'No dated items yet';

  document.getElementById('insights-cancelled-savings').textContent = formatCurrency(computeCancelledSavings(items), currencySymbol);

  const top3 = topExpensiveItems(items, 3);
  document.getElementById('insights-top3').innerHTML = top3.length === 0
    ? '<li class="muted item-list-empty">Nothing tracked yet.</li>'
    : top3.map((item, i) => `
        <li class="insight-top-title-row">
          <span class="insight-top-title-rank">${i + 1}</span>
          <button type="button" class="insight-top-title-name" data-edit-id="${item.id}">${escapeHtml(item.name)}</button>
          <span class="mono">${formatCurrency(item.price, currencySymbol)}</span>
        </li>
      `).join('');

  renderTrendSvg(buildMonthlySpendTrend(items, 12, now), 'insights-trend-chart', currencySymbol);

  const priceCreep = computePriceCreep(items);
  const priceCreepSection = document.getElementById('insights-price-creep-section');
  if (priceCreep.length === 0) {
    priceCreepSection.classList.add('hidden');
  } else {
    priceCreepSection.classList.remove('hidden');
    document.getElementById('insights-price-creep-list').innerHTML = priceCreep.map(p => `
      <div class="insight-price-creep-row">
        <span class="insight-price-creep-name">${escapeHtml(p.series)} <span class="muted">(${p.issueCount} issues)</span></span>
        <span class="mono">
          <span class="muted">${formatCurrency(p.firstPrice, currencySymbol)}</span>
          &rarr;
          <span style="color: var(--neon-pink);">${formatCurrency(p.latestPrice, currencySymbol)}</span>
          <span class="muted">(+${p.increasePct}%)</span>
        </span>
      </div>
    `).join('');
  }

  const byShop = groupSpendByShopWithSellers(items);
  document.getElementById('insights-by-shop').innerHTML = byShop.length === 0
    ? '<li class="muted item-list-empty">Nothing tracked yet.</li>'
    : byShop.map((s, i) => `
        <li>
          <div class="shop-row shop-row-bar ${s.subShops.length ? 'shop-row-expandable' : ''}" ${s.subShops.length ? `data-toggle-shop="shop-detail-${i}"` : ''}>
            <div class="shop-row-top">
              <span class="shop-row-label">
                ${s.subShops.length ? '<span class="shop-expand-arrow">&#9656;</span>' : ''}
                <span class="source-dot" style="background: ${s.color};"></span>
                <span>${escapeHtml(s.shop)}</span>
                ${s.subShops.length ? `<span class="muted">(${s.subShops.length} seller${s.subShops.length !== 1 ? 's' : ''})</span>` : ''}
              </span>
              <span class="shop-row-figures">
                <span class="mono">${formatCurrency(s.total, currencySymbol)}</span>
                <span class="muted shop-row-count">${s.count} issue${s.count !== 1 ? 's' : ''}</span>
              </span>
            </div>
            <div class="shop-bar-track"><div class="shop-bar-fill" style="width: ${s.pct}%; background: ${s.color};"></div></div>
          </div>
          ${s.subShops.length ? `
            <ul class="shop-detail hidden" id="shop-detail-${i}">
              ${s.subShops.map(sub => `
                <li class="shop-row shop-row-bar shop-subrow">
                  <div class="shop-row-top">
                    <span class="shop-row-label">
                      <span class="source-dot" style="background: ${sub.color};"></span>
                      <span>${escapeHtml(sub.shop)}</span>
                    </span>
                    <span class="shop-row-figures">
                      <span class="mono">${formatCurrency(sub.total, currencySymbol)}</span>
                      <span class="muted shop-row-count">${sub.count} issue${sub.count !== 1 ? 's' : ''}</span>
                    </span>
                  </div>
                  <div class="shop-bar-track"><div class="shop-bar-fill" style="width: ${sub.pct}%; background: ${sub.color};"></div></div>
                </li>
              `).join('')}
            </ul>
          ` : ''}
        </li>
      `).join('');

  document.querySelectorAll('[data-toggle-shop]').forEach(row => {
    row.addEventListener('click', () => {
      const target = document.getElementById(row.dataset.toggleShop);
      const arrow = row.querySelector('.shop-expand-arrow');
      const isOpen = !target.classList.contains('hidden');
      target.classList.toggle('hidden', isOpen);
      if (arrow) arrow.innerHTML = isOpen ? '&#9656;' : '&#9662;';
    });
  });
}

let allItemsCache = [];
// Raw real shipment rows (undivided, not blended with estimates) -
// populated by fetchAllItems, used specifically for "biggest/cheapest
// real shipping charge" which the webui deliberately only ever computes
// from actual captured postage, never an estimate.
let rawRealShipments = [];
let shipmentGroupDebugLog = [];
// Forbidden-Planet-only, all-time estimate - matches the webui's
// Dashboard note exactly (it calls estimate_for(DEFAULT_SOURCE)
// specifically, not a sitewide pool of every shop's samples).
let defaultSourceShippingEstimate = { rate: 4.00, tier: 'default', samples: 0 };

/** Schedules tomorrow's release reminder, computed fresh from whatever's
 * tracked right now. Local notifications have a real constraint worth
 * being honest about: unlike the web app's server-side daily digest,
 * there's no background process here to recompute content overnight - so
 * this reschedules a single one-off notification (not a repeating one)
 * every time the app is opened, using the freshest data available at
 * that moment. This means the reminder is only as fresh as the last time
 * the app was opened, not a true always-current background job. */
async function scheduleNotification(enabled, time, notifyOnQuietDays) {
  await LocalNotifications.cancel({ notifications: [{ id: 1 }] });
  if (!enabled) return;

  const permission = await LocalNotifications.requestPermissions();
  if (permission.display !== 'granted') return;

  const tomorrowItems = findTomorrowReleases(allItemsCache, new Date());
  if (tomorrowItems.length === 0 && !notifyOnQuietDays) return;

  const [hour, minute] = time.split(':').map(Number);
  const { title, body } = buildTomorrowNotification(tomorrowItems, currencySymbol);

  const scheduleAt = new Date();
  scheduleAt.setHours(hour, minute, 0, 0);
  if (scheduleAt <= new Date()) scheduleAt.setDate(scheduleAt.getDate() + 1);

  await LocalNotifications.schedule({
    notifications: [{ id: 1, title, body, schedule: { at: scheduleAt } }],
  });
}

/** Same real constraint as the daily reminder - rescheduled fresh each
 * time the app opens, using a fixed weekday and the same reminder time
 * as the daily one. */
async function scheduleWeeklyNotification(enabled, weekday, time) {
  await LocalNotifications.cancel({ notifications: [{ id: 3 }] });
  if (!enabled) return;

  const permission = await LocalNotifications.requestPermissions();
  if (permission.display !== 'granted') return;

  const [hour, minute] = time.split(':').map(Number);
  const weekItems = findNextWeekReleases(allItemsCache, new Date());
  const { title, body } = buildWeeklyNotification(weekItems, currencySymbol);

  const scheduleAt = new Date();
  scheduleAt.setHours(hour, minute, 0, 0);
  const targetDay = parseInt(weekday, 10);
  let daysAhead = (targetDay - scheduleAt.getDay() + 7) % 7;
  if (daysAhead === 0 && scheduleAt <= new Date()) daysAhead = 7;
  scheduleAt.setDate(scheduleAt.getDate() + daysAhead);

  await LocalNotifications.schedule({
    notifications: [{ id: 3, title, body, schedule: { at: scheduleAt } }],
  });
}

/** Fires once when this month's spend crosses 80% of the monthly budget -
 * a fixed threshold, not user-editable, matching the same "one sensible
 * default beats a slider nobody tunes" reasoning as the web app. Since
 * there's no persistent background process here (this only runs while
 * the app itself is open), it's checked after every data change rather
 * than on a fixed schedule - realistically similar in practice, since
 * spend only changes when the app's actually being used to log something.
 * Sends at most once per calendar month, tracked via a hidden setting,
 * so it doesn't repeat every time refreshAll() runs for the rest of the
 * month once crossed. force=true (the manual test button) bypasses both
 * the enabled check and the once-per-month gate. */
async function checkBudgetAlert(items, force = false) {
  const enabled = (await getSetting('budget_alert_enabled', 'no')) === 'yes';
  if (!enabled && !force) return null;
  if (!monthlyBudget || monthlyBudget <= 0) {
    return force ? { sent: false, reason: 'No monthly budget is set in Settings.' } : null;
  }

  const now = new Date();
  const spend = computeMonthSpend(items, now.getFullYear(), now.getMonth());
  const pct = Math.round((spend / monthlyBudget) * 100);
  const periodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastAlerted = await getSetting('budget_alert_last_period', '');
  const alreadySentThisPeriod = lastAlerted === periodKey;

  if (pct < 80 && !force) return null;
  if (alreadySentThisPeriod && !force) return null;

  let title = `Budget alert: ${pct}% of this month's budget`;
  let body = `${formatCurrency(spend, currencySymbol)} of ${formatCurrency(monthlyBudget, currencySymbol)} spent so far this month.`;
  if (force && pct < 80) {
    body += ' (Not yet at the 80% threshold - this is a test send.)';
  }

  if (!(window.Capacitor && window.Capacitor.isNativePlatform())) {
    return { sent: false, reason: 'Notifications only work on-device, not in this browser preview.' };
  }

  try {
    const permission = await LocalNotifications.requestPermissions();
    if (permission.display !== 'granted') {
      return { sent: false, reason: 'Notification permission not granted.' };
    }
    await LocalNotifications.schedule({
      notifications: [{ id: 4, title, body, schedule: { at: new Date(Date.now() + 1000) } }],
    });
    if (pct >= 80) {
      await setSetting('budget_alert_last_period', periodKey);
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message || String(err) };
  }
}

async function refreshAll() {
  allItemsCache = await fetchAllItems();
  renderDashboard(allItemsCache);
  renderLogOrders(allItemsCache);
  renderCalendar(allItemsCache);
  renderSearch(allItemsCache);
  renderInsights(allItemsCache);
  document.getElementById('db-stats-line').textContent =
    `${allItemsCache.length} item${allItemsCache.length !== 1 ? 's' : ''} tracked on this device.`;
  checkBudgetAlert(allItemsCache).catch(err => console.error('Budget alert check failed:', err));
}

function switchView(viewName) {
  document.querySelectorAll('.view').forEach(el => el.classList.add('hidden'));
  document.getElementById(`view-${viewName}`).classList.remove('hidden');
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  document.getElementById('menu-btn').classList.toggle('active', viewName === 'settings');
}

function wireRemoveButtons(containerId) {
  document.getElementById(containerId).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove-id]');
    if (!btn) return;
    await deleteItem(parseInt(btn.dataset.removeId, 10));
    await refreshAll();
  });
}

function wirePaidToggle(containerId) {
  document.getElementById(containerId).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-toggle-paid]');
    if (!btn) return;
    await toggleChargeStatus(parseInt(btn.dataset.togglePaid, 10));
    await refreshAll();
  });
}

function wireCancelButton(containerId) {
  document.getElementById(containerId).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cancel-id]');
    if (!btn) return;
    const confirmed = window.confirm('Mark this item as cancelled? It stays visible but stops counting toward what\'s still due.');
    if (!confirmed) return;
    await cancelItem(parseInt(btn.dataset.cancelId, 10));
    await refreshAll();
  });
}

// Same match key the web app itself uses when deciding whether a pasted
// row is something already tracked: order number (null-safe), name, and
// price. If all three line up, this is the same real-world item turning
// up again in another paste of the same order history.
function findMatchingTrackedItem(row) {
  return allItemsCache.find(i =>
    (i.order_number || null) === (row.order_number || null) &&
    i.name === row.name && i.price === row.price
  );
}

function importReviewRowHtml(r, i) {
  const existing = findMatchingTrackedItem(r);
  let flag = '';
  if (existing && existing.manual_override) {
    flag = '<span class="preview-duplicate-flag">&#9888; Already tracked &amp; manually set - re-adding will be skipped</span>';
  } else if (existing) {
    flag = '<span class="preview-duplicate-flag">&#9888; Already tracked - this will refresh it, not duplicate it</span>';
  }
  return `
    <div class="preview-row" data-preview-index="${i}">
      <label class="preview-keep">
        <span class="toggle">
          <input type="checkbox" data-preview-field="keep" data-preview-index="${i}" checked>
          <span class="toggle-track"></span>
        </span>
      </label>
      <input type="text" data-preview-field="name" data-preview-index="${i}" value="${escapeHtml(r.name)}" class="preview-name-input">
      <input type="number" step="0.01" data-preview-field="price" data-preview-index="${i}" value="${r.price}" class="preview-price-input">
      <input type="date" data-preview-field="release_date" data-preview-index="${i}" value="${r.release_date || ''}" class="preview-date-input">
      ${r.shop || r.order_number || r.charge_status === 'charged' ? `
        <p class="muted paste-preview-meta">${r.shop ? escapeHtml(r.shop) : ''}${r.order_number ? ` &middot; order #${escapeHtml(r.order_number)}` : ''}${r.charge_status === 'charged' ? ' &middot; paid' : ''}</p>
      ` : ''}
      ${flag ? `<div class="preview-row-note">${flag}</div>` : ''}
    </div>
  `;
}

function importPreviewTotalsHtml(keptIndexes) {
  const rows = keptIndexes ? pastedResults.filter((r, i) => keptIndexes.has(i)) : pastedResults;
  const itemsTotal = Math.round(rows.reduce((s, r) => s + (r.price || 0), 0) * 100) / 100;
  const withShipping = rows.filter(r => r.shipping != null);
  let shippingLine = '';
  if (withShipping.length > 0) {
    const shippingTotal = Math.round(withShipping.reduce((s, r) => s + r.shipping, 0) * 100) / 100;
    shippingLine = shippingTotal === 0
      ? '<p class="muted preview-shipping-detected">Free shipping detected on this paste.</p>'
      : `<p class="muted preview-shipping-detected">Shipping detected: <span class="mono">${formatCurrency(shippingTotal, currencySymbol)}</span></p>`;
  }
  return `<p class="muted">Items total on this paste: <span class="mono">${formatCurrency(itemsTotal, currencySymbol)}</span></p>${shippingLine}`;
}

function openImportReviewModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'edit-modal-backdrop';
  backdrop.innerHTML = `
    <div class="edit-modal">
      <div class="edit-modal-head">
        <h2>Review before adding</h2>
        <button type="button" class="edit-modal-close" aria-label="Close">&times;</button>
      </div>
      <p class="muted item-form-hint">
        Nothing's been saved yet. Check each row, fix anything that's wrong,
        untick anything you don't want, then confirm.
      </p>
      <div id="preview-totals">${importPreviewTotalsHtml()}</div>
      <div id="preview-rows">
        ${pastedResults.map((r, i) => importReviewRowHtml(r, i)).join('')}
      </div>
      <button type="button" id="add-preview-row-btn" class="btn-add-row">+ Add another row</button>
      <div class="preview-actions">
        <button type="button" id="preview-confirm-btn">Confirm &amp; add</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = () => { unregisterModal(close); backdrop.remove(); };
  registerModal(close);
  backdrop.querySelector('.edit-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  const refreshTotals = () => {
    const totalsEl = backdrop.querySelector('#preview-totals');
    if (!totalsEl) return;
    const keptIndexes = new Set(
      [...backdrop.querySelectorAll('[data-preview-field="keep"]')]
        .filter(cb => cb.checked)
        .map(cb => parseInt(cb.dataset.previewIndex, 10))
    );
    totalsEl.innerHTML = importPreviewTotalsHtml(keptIndexes);
  };

  const wirePreviewInput = (input, idx) => {
    input.addEventListener('input', () => {
      const field = input.dataset.previewField;
      if (field !== 'keep') pastedResults[idx][field] = field === 'price' ? parseFloat(input.value) : input.value;
      if (field === 'keep' || field === 'price') refreshTotals();
    });
  };

  backdrop.querySelectorAll('[data-preview-field]').forEach(input => {
    wirePreviewInput(input, parseInt(input.dataset.previewIndex, 10));
  });

  backdrop.querySelector('#add-preview-row-btn').addEventListener('click', () => {
    const i = pastedResults.length;
    pastedResults.push({ name: '', price: 0, release_date: null, shop: null, order_number: null, status: 'preorder', charge_status: 'not_charged' });
    const rowsEl = backdrop.querySelector('#preview-rows');
    rowsEl.insertAdjacentHTML('beforeend', importReviewRowHtml(pastedResults[i], i));
    const newRow = rowsEl.querySelector(`[data-preview-index="${i}"].preview-name-input`) || rowsEl.querySelector(`[data-preview-index="${i}"]`);
    if (newRow) newRow.focus();
    rowsEl.querySelectorAll(`[data-preview-index="${i}"][data-preview-field]`).forEach(input => {
      wirePreviewInput(input, i);
    });
    refreshTotals();
  });

  backdrop.querySelector('#preview-confirm-btn').addEventListener('click', async () => {
    const keptIndexes = [...backdrop.querySelectorAll('[data-preview-field="keep"]')]
      .filter(cb => cb.checked)
      .map(cb => parseInt(cb.dataset.previewIndex, 10));

    let imported = 0, refreshed = 0, skipped = 0;
    for (const idx of keptIndexes) {
      const r = pastedResults[idx];
      if (!r.name || !r.name.trim()) continue;
      const shop = r.shop || document.getElementById('field-shop').value || null;
      const existing = findMatchingTrackedItem(r);
      if (!existing) {
        await insertItem({
          name: r.name, price: r.price, release_date: r.release_date,
          shop, order_number: r.order_number || null,
          placed_date: r.placed_date || null,
          status: r.status || 'preorder',
          charge_status: r.charge_status || 'not_charged',
          tracking_number: r.tracking_number || null,
          shipping: r.shipping ?? null,
        });
        imported++;
      } else if (existing.manual_override) {
        // Already tracked and the person has manually acted on it since
        // (edited, marked paid, cancelled) - a re-paste must never
        // silently revert that, so this one's left untouched.
        skipped++;
      } else {
        await refreshItemFromImport(existing.id, {
          status: r.status || 'preorder',
          release_date: r.release_date,
          charge_status: r.charge_status || 'not_charged',
          placed_date: r.placed_date || null,
          tracking_number: r.tracking_number || null,
          shipping: r.shipping ?? null,
        });
        refreshed++;
      }
    }
    const keptResults = keptIndexes.map(idx => pastedResults[idx]).filter(r => r.name && r.name.trim());
    await upsertOrderShipping(computeOrderShippingTotals(keptResults), keptResults[0]?.shop || null);
    const keptOrderNumbers = new Set(keptResults.map(r => r.order_number).filter(Boolean));
    const keptDeclaredTotals = new Map([...pastedDeclaredTotals].filter(([orderNumber]) => keptOrderNumbers.has(orderNumber)));
    await upsertOrderTotals(keptDeclaredTotals);
    pastedResults = [];
    pastedDeclaredTotals = new Map();
    document.getElementById('paste-textarea').value = '';
    document.getElementById('paste-detected-label').textContent = '';
    document.getElementById('paste-detected-label').classList.add('hidden');
    await refreshAll();
    close();
    document.getElementById('paste-import-result').textContent =
      `Found ${imported + refreshed + skipped} item${imported + refreshed + skipped !== 1 ? 's' : ''} \u00b7 added ${imported} new \u00b7 refreshed ${refreshed} \u00b7 skipped ${skipped} already set.`;
    switchView('log-orders');
  });
}

function isoDateLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Mirrors the web app's daily auto-backup, adapted for a device with no
// always-on background process: rather than running at a fixed hour every
// night, this checks once per app launch whether today's backup has
// already been made, and if not, writes one and prunes to the last 7.
async function runAutoBackupIfDue() {
  const todayIso = isoDateLocal(new Date());
  const lastBackupDate = await getSetting('last_auto_backup_date', '');
  if (lastBackupDate === todayIso) return;

  const items = await fetchAllItems();
  const json = buildJsonBackup(items);
  const filename = `kaching-auto-${todayIso}.json`;
  await Filesystem.writeFile({
    path: `backups/${filename}`, data: json, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true,
  });
  await setSetting('last_auto_backup_date', todayIso);

  try {
    const list = await Filesystem.readdir({ path: 'backups', directory: Directory.Documents });
    const autoBackups = (list.files || [])
      .map(f => f.name || f)
      .filter(name => name.startsWith('kaching-auto-'))
      .sort();
    const toRemove = autoBackups.slice(0, -7);
    for (const name of toRemove) {
      await Filesystem.deleteFile({ path: `backups/${name}`, directory: Directory.Documents });
    }
  } catch (err) {
    console.error('Auto backup pruning failed:', err);
  }
}

async function main() {
  if (window.Capacitor && window.Capacitor.isNativePlatform()) {
    App.addListener('backButton', ({ canGoBack }) => {
      if (openModalStack.length > 0) {
        openModalStack[openModalStack.length - 1]();
        return;
      }
      if (canGoBack) {
        window.history.back();
      } else {
        App.exitApp();
      }
    });
  }

  await initDatabase();
  currencySymbol = await getSetting('currency_symbol', '£');
  document.getElementById('settings-currency').value = currencySymbol;

  const storedBudget = await getSetting('monthly_budget', '');
  monthlyBudget = storedBudget ? parseFloat(storedBudget) : null;
  document.getElementById('settings-budget').value = storedBudget || '';
  budgetCycle = await getSetting('budget_cycle', 'monthly');
  document.getElementById('settings-budget-cycle').value = budgetCycle;
  budgetRollover = (await getSetting('budget_rollover', 'no')) === 'yes';
  document.getElementById('settings-budget-rollover').checked = budgetRollover;
  document.getElementById('settings-budget-alert-enabled').checked =
    (await getSetting('budget_alert_enabled', 'no')) === 'yes';

  try {
    const storedDismissed = await getSetting('dismissed_duplicates', '[]');
    dismissedDuplicates = new Set(JSON.parse(storedDismissed));
  } catch {
    dismissedDuplicates = new Set();
  }

  const notifyEnabled = (await getSetting('notify_enabled', 'no')) === 'yes';
  const notifyTime = await getSetting('notify_time', '08:00');
  document.getElementById('settings-notifications-enabled').checked = notifyEnabled;
  document.getElementById('settings-notify-time').value = notifyTime;
  const notifyQuietDays = (await getSetting('notify_on_quiet_days', 'no')) === 'yes';
  document.getElementById('settings-notify-quiet-days').checked = notifyQuietDays;
  const weeklyEnabled = (await getSetting('weekly_digest_enabled', 'no')) === 'yes';
  const weeklyDay = await getSetting('weekly_digest_day', '1');
  document.getElementById('settings-weekly-digest-enabled').checked = weeklyEnabled;
  document.getElementById('settings-weekly-digest-day').value = weeklyDay;
  if (notifyEnabled || weeklyEnabled) {
    await refreshAll();
    await scheduleNotification(notifyEnabled, notifyTime, notifyQuietDays).catch(err => console.error('Notification scheduling failed:', err));
    await scheduleWeeklyNotification(weeklyEnabled, weeklyDay, notifyTime).catch(err => console.error('Weekly notification scheduling failed:', err));
  }

  const landingPage = await getSetting('default_landing_page', 'dashboard');
  document.getElementById('settings-landing-page').value = landingPage;
  if (landingPage !== 'dashboard') switchView(landingPage);

  const autoBackupEnabled = (await getSetting('auto_backup_enabled', 'no')) === 'yes';
  document.getElementById('settings-auto-backup-enabled').checked = autoBackupEnabled;
  if (autoBackupEnabled) {
    runAutoBackupIfDue().catch(err => console.error('Auto backup failed:', err));
  }

  document.getElementById('settings-sync-url').value = await getSetting('sync_server_url', '');
  document.getElementById('settings-sync-key').value = await getSetting('sync_key', '');
  document.getElementById('settings-sync-label').value = await getSetting('sync_client_label', '');
  const lastSynced = await getSetting('sync_last_synced_at', null);
  document.getElementById('sync-status').textContent = lastSynced
    ? `Last synced ${new Date(lastSynced).toLocaleString()}`
    : '';
  await updateConflictBanner();

  document.getElementById('about-version').textContent = 'Ka-Ching! App v2026.07.31.1';

  const devToolsUnlocked = await getSetting('dev_tools_unlocked', false);
  if (devToolsUnlocked) {
    document.getElementById('dev-tools-section').classList.remove('hidden');
  }
  const versionEl = document.getElementById('about-version');
  if (!versionEl.dataset.tapWired) {
    versionEl.dataset.tapWired = 'true';
    let tapCount = 0;
    versionEl.addEventListener('click', async () => {
      tapCount++;
      if (tapCount >= 7) {
        document.getElementById('dev-tools-section').classList.remove('hidden');
        await setSetting('dev_tools_unlocked', true);
        tapCount = 0;
      }
    });
  }

  const sortSelect = document.getElementById('search-sort');
  sortSelect.innerHTML = Object.entries(SORT_OPTIONS).map(([key, opt]) => `<option value="${key}">${opt.label}</option>`).join('');

  await refreshAll();

  document.querySelectorAll('#dashboard-chart-range-tabs [data-range]').forEach(btn => {
    btn.addEventListener('click', () => {
      dashboardChartRange = btn.dataset.range;
      document.querySelectorAll('#dashboard-chart-range-tabs [data-range]').forEach(b => b.classList.toggle('active', b === btn));
      renderTrendSvg(getDashboardTrend(filterByShop(allItemsCache, selectedShop)), 'spend-trend-chart', currencySymbol);
    });
  });

  initTrendTooltipDismissal();

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  const menuBtn = document.getElementById('menu-btn');
  const menuDropdown = document.getElementById('menu-dropdown');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menuDropdown.classList.contains('hidden');
    menuDropdown.classList.toggle('hidden', !willOpen);
    menuBtn.setAttribute('aria-expanded', String(willOpen));
  });
  menuDropdown.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view);
      menuDropdown.classList.add('hidden');
      menuBtn.setAttribute('aria-expanded', 'false');
    });
  });
  document.addEventListener('click', (e) => {
    if (!menuDropdown.classList.contains('hidden') && !menuDropdown.contains(e.target)) {
      menuDropdown.classList.add('hidden');
      menuBtn.setAttribute('aria-expanded', 'false');
    }
  });

  // Scoped to [data-tab] specifically - shop-filter tabs also use the
  // .tab-btn class (for shared styling) but carry data-shop instead, so
  // matching on .tab-btn alone here would fire on every shop tab click
  // too: dataset.tab would be undefined, tab-undefined doesn't exist,
  // and .classList on that null throws.
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });

  const shopInput = document.getElementById('field-shop');
  const shopList = document.getElementById('shop-autocomplete-list');

  function renderShopSuggestions() {
    const query = shopInput.value.trim().toLowerCase();
    const matches = knownShops.filter(s => !query || s.toLowerCase().includes(query)).slice(0, 8);
    if (matches.length === 0) { shopList.classList.add('hidden'); return; }
    shopList.innerHTML = matches.map(s => `<li data-shop="${escapeHtml(s)}">${escapeHtml(s)}</li>`).join('');
    shopList.classList.remove('hidden');
  }

  shopInput.addEventListener('focus', () => {
    setTimeout(() => shopInput.select(), 0);
    renderShopSuggestions();
  });
  shopInput.addEventListener('input', renderShopSuggestions);
  shopList.addEventListener('click', (e) => {
    const li = e.target.closest('[data-shop]');
    if (!li) return;
    shopInput.value = li.dataset.shop;
    shopList.classList.add('hidden');
  });
  document.addEventListener('click', (e) => {
    if (e.target === shopInput || shopList.contains(e.target)) return;
    shopList.classList.add('hidden');
  });

  document.getElementById('manual-shop-hint-whatnot').addEventListener('click', () => {
    document.getElementById('field-shop').value = 'Whatnot';
    document.querySelector('#comic-rows .comic-row-name').focus();
  });

  document.getElementById('add-item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const statusEl = document.getElementById('form-status');
    const releaseDate = document.getElementById('field-release-date').value;
    const shop = document.getElementById('field-shop').value;
    const orderNumber = document.getElementById('field-order-number').value || null;
    const shippingVal = document.getElementById('field-shipping').value;
    const shipping = shippingVal ? parseFloat(shippingVal) : null;
    const trackingNumber = document.getElementById('field-tracking-number').value || null;
    const chargeStatus = document.getElementById('field-already-paid').checked ? 'charged' : 'not_charged';

    const rows = [...document.querySelectorAll('#comic-rows .comic-row')];
    const cleanedRows = [];
    const allErrors = [];
    for (const row of rows) {
      const name = row.querySelector('.comic-row-name').value;
      const price = row.querySelector('.comic-row-price').value;
      const { valid, errors, cleaned } = validateItemInput({ name, price, release_date: releaseDate, shop });
      if (!valid) { allErrors.push(...errors); continue; }
      cleanedRows.push(cleaned);
    }

    if (allErrors.length > 0) {
      statusEl.textContent = [...new Set(allErrors)].join(' ');
      statusEl.className = 'item-form-hint error';
      return;
    }

    for (const cleaned of cleanedRows) {
      cleaned.order_number = orderNumber;
      cleaned.shipping = shipping;
      cleaned.tracking_number = trackingNumber;
      cleaned.charge_status = chargeStatus;
      cleaned.manualOverride = true;
      await insertItem(cleaned);
    }
    // Manual entry's shipping field is a single total as typed, applied
    // identically to every row here rather than divided - so it's
    // written straight through as one order-level figure, not summed
    // via computeOrderShippingTotals (which would multiply it by however
    // many rows were on the form).
    if (orderNumber && shipping) {
      await upsertOrderShipping(new Map([[orderNumber, shipping]]), shop);
    }
    sessionLastShop = shop;

    // Reset back to a single blank comic row, but keep the shop, release
    // date, tracking number, and paid status - a single delivery (a
    // Whatnot bundle especially) can cover several separate orders that
    // all share these, with only the order number and the item itself
    // actually changing between them.
    document.getElementById('comic-rows').innerHTML = `
      <div class="comic-row">
        <input type="text" required placeholder="Comic name (e.g. Comic On Screen #4)" class="comic-row-name">
        <input type="number" step="0.01" min="0" required placeholder="Price" class="comic-row-price">
        <button type="button" class="btn-remove-row" title="Remove this row" aria-label="Remove this row">&times;</button>
      </div>
    `;
    document.getElementById('field-order-number').value = '';
    document.getElementById('field-shipping').value = '';
    statusEl.textContent = cleanedRows.length > 1 ? `Added ${cleanedRows.length} items.` : 'Added.';
    statusEl.className = 'item-form-hint success';
    await refreshAll();
  });

  document.getElementById('add-row-btn').addEventListener('click', () => {
    const container = document.getElementById('comic-rows');
    const row = document.createElement('div');
    row.className = 'comic-row';
    row.innerHTML = `
      <input type="text" required placeholder="Comic name (e.g. Comic On Screen #4)" class="comic-row-name">
      <input type="number" step="0.01" min="0" required placeholder="Price" class="comic-row-price">
      <button type="button" class="btn-remove-row" title="Remove this row" aria-label="Remove this row">&times;</button>
    `;
    container.appendChild(row);
    row.querySelector('.comic-row-name').focus();
  });

  document.getElementById('comic-rows').addEventListener('click', (e) => {
    if (!e.target.classList.contains('btn-remove-row')) return;
    const container = document.getElementById('comic-rows');
    if (container.children.length > 1) {
      e.target.closest('.comic-row').remove();
    }
  });

  document.getElementById('paste-parse-btn').addEventListener('click', () => {
    const text = document.getElementById('paste-textarea').value;
    document.getElementById('paste-import-result').textContent = '';
    const detectedLabel = document.getElementById('paste-detected-label');
    const notFoundHint = document.getElementById('paste-not-found-hint');
    detectedLabel.classList.add('hidden');
    notFoundHint.classList.add('hidden');
    detectedLabel.classList.remove('preview-meta-tag-generic');

    const useForbiddenPlanet = forcedShopHint === 'forbidden_planet' || (!forcedShopHint && looksLikeForbiddenPlanet(text));
    const useEbay = !useForbiddenPlanet && (forcedShopHint === 'ebay' || (!forcedShopHint && looksLikeEbay(text)));
    if (useForbiddenPlanet) {
      pastedResults = parseForbiddenPlanetOrders(text);
      pastedDeclaredTotals = extractFpDeclaredTotals(text);
      if (pastedResults.length > 0) {
        detectedLabel.textContent = 'Detected: Forbidden Planet';
        detectedLabel.classList.remove('hidden');
      } else {
        notFoundHint.textContent = 'Looked like Forbidden Planet, but no items were found - check the paste includes the [image]/order lines.';
        notFoundHint.classList.remove('hidden');
      }
    } else if (useEbay) {
      pastedResults = parseEbayOrders(text);
      if (pastedResults.length > 0) {
        detectedLabel.textContent = 'Detected: eBay';
        detectedLabel.classList.remove('hidden');
      } else {
        notFoundHint.textContent = 'Looked like eBay, but no items were found - non-GBP orders are skipped for now, and the paste needs the "Item details" section included.';
        notFoundHint.classList.remove('hidden');
      }
    } else {
      const generic = parseGenericOrder(text);
      const perItemShipping = generic.shipping != null && generic.items.length > 0
        ? Math.round((generic.shipping / generic.items.length) * 100) / 100 : null;
      pastedResults = generic.items.map(r => ({
        name: r.name, price: r.price, release_date: r.release_date,
        order_number: generic.order_number, status: 'preorder', shop: null,
        shipping: perItemShipping,
      }));
      if (pastedResults.length > 0) {
        detectedLabel.textContent = "Shop not recognised automatically - confirm each row's shop below";
        detectedLabel.classList.add('preview-meta-tag-generic');
        detectedLabel.classList.remove('hidden');
      }
    }
    if (pastedResults.length > 0) openImportReviewModal();
  });

  document.getElementById('paste-shop-hint-fp').addEventListener('click', (e) => {
    const isActive = e.target.classList.contains('active');
    forcedShopHint = isActive ? null : 'forbidden_planet';
    e.target.classList.toggle('active', !isActive);
    document.getElementById('paste-shop-hint-ebay').classList.remove('active');
  });

  document.getElementById('paste-shop-hint-ebay').addEventListener('click', (e) => {
    const isActive = e.target.classList.contains('active');
    forcedShopHint = isActive ? null : 'ebay';
    e.target.classList.toggle('active', !isActive);
    document.getElementById('paste-shop-hint-fp').classList.remove('active');
  });

  wireRemoveButtons('cal-agenda');
  wireRemoveButtons('search-results');
  wireRemoveButtons('awaiting-charge-list');
  wireRemoveButtons('this-week-groups');
  wireRemoveButtons('dash-shipment-groups');
  wireRemoveButtons('duplicates-groups');
  wireRemoveButtons('ghost-items-list');
  wireRemoveButtons('recently-cancelled-list');
  wirePaidToggle('cal-agenda');
  wirePaidToggle('search-results');
  wirePaidToggle('insights-top3');
  wirePaidToggle('awaiting-charge-list');
  wirePaidToggle('this-week-groups');
  wirePaidToggle('dash-shipment-groups');
  wirePaidToggle('duplicates-groups');
  wirePaidToggle('ghost-items-list');
  wireCancelButton('cal-agenda');
  wireCancelButton('search-results');
  wireCancelButton('awaiting-charge-list');
  wireCancelButton('this-week-groups');
  wireCancelButton('dash-shipment-groups');
  wireCancelButton('duplicates-groups');
  wireCancelButton('ghost-items-list');
  wireEditButtons('cal-agenda');
  wireEditButtons('search-results');
  wireEditButtons('insights-top3');
  document.getElementById('insights-priciest-sub').addEventListener('click', (e) => {
    const id = parseInt(e.currentTarget.dataset.editId, 10);
    const item = allItemsCache.find(i => i.id === id);
    if (item) openEditModal(item);
  });
  document.getElementById('stat-priciest-note').addEventListener('click', (e) => {
    const id = parseInt(e.currentTarget.dataset.editId, 10);
    const item = allItemsCache.find(i => i.id === id);
    if (item) openEditModal(item);
  });
  wireEditButtons('awaiting-charge-list');
  wireEditButtons('this-week-groups');
  wireEditButtons('dash-shipment-groups');
  wireEditButtons('duplicates-groups');
  wireEditButtons('ghost-items-list');

  // Tracking numbers are added dynamically across views, so the copy-to-clipboard
  // behaviour is delegated on the document rather than bound per-row. The link
  // still opens PostTrack in a new tab as normal; this just also puts the
  // tracking number on the clipboard first, ready to paste.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.track-link-btn');
    if (!link) return;
    const tracking = link.dataset.tracking;
    if (tracking && navigator.clipboard) {
      navigator.clipboard.writeText(tracking).catch(() => {});
    }
  });

  ['search-query', 'search-min-price', 'search-max-price', 'search-start-date', 'search-end-date', 'search-include-undated', 'search-shop', 'search-status', 'search-sort'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => renderSearch(allItemsCache));
    document.getElementById(id).addEventListener('change', () => renderSearch(allItemsCache));
  });

  document.querySelectorAll('.date-preset-btn[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const now = new Date();
      const y = now.getFullYear(), m = now.getMonth();
      const pad = (n) => String(n).padStart(2, '0');
      let start, end;
      if (btn.dataset.preset === 'month') {
        start = `${y}-${pad(m + 1)}-01`;
        end = `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`;
      } else {
        start = `${y}-01-01`;
        end = `${y}-12-31`;
      }
      document.getElementById('search-start-date').value = start;
      document.getElementById('search-end-date').value = end;
      renderSearch(allItemsCache);
    });
  });
  document.getElementById('sort-most-expensive-btn').addEventListener('click', () => {
    document.getElementById('search-sort').value = 'price_desc';
    renderSearch(allItemsCache);
  });
  document.getElementById('sort-cheapest-btn').addEventListener('click', () => {
    document.getElementById('search-sort').value = 'price_asc';
    renderSearch(allItemsCache);
  });
  document.getElementById('search-clear-btn').addEventListener('click', () => {
    document.getElementById('search-query').value = '';
    document.getElementById('search-shop').value = '';
    document.getElementById('search-status').value = 'all';
    document.getElementById('search-sort').value = 'date_desc';
    document.getElementById('search-start-date').value = '';
    document.getElementById('search-end-date').value = '';
    document.getElementById('search-include-undated').checked = true;
    document.getElementById('search-min-price').value = '';
    document.getElementById('search-max-price').value = '';
    renderSearch(allItemsCache);
  });

  // Item lists are re-rendered on every filter/data change, so drawer-toggle
  // and undo are delegated once per (stable) container rather than rebound
  // per row.
  function wireItemActionsDrawer(containerId) {
    const el = document.getElementById(containerId);
    el.addEventListener('click', async (e) => {
      const drawerToggle = e.target.closest('[data-drawer-toggle]');
      if (drawerToggle) {
        const group = drawerToggle.closest('.item-actions-group');
        const wasOpen = group.classList.contains('drawer-open');
        document.querySelectorAll('.item-actions-group.drawer-open').forEach(g => g.classList.remove('drawer-open'));
        if (!wasOpen) group.classList.add('drawer-open');
        return;
      }
      const undoBtn = e.target.closest('[data-undo-cancel-id]');
      if (undoBtn) {
        await undoCancelItem(parseInt(undoBtn.dataset.undoCancelId, 10));
        await refreshAll();
        return;
      }
    });
  }
  wireItemActionsDrawer('awaiting-charge-list');
  wireItemActionsDrawer('cal-agenda');
  wireItemActionsDrawer('search-results');
  wireItemActionsDrawer('this-week-groups');
  wireItemActionsDrawer('dash-shipment-groups');
  wireItemActionsDrawer('duplicates-groups');
  wireItemActionsDrawer('ghost-items-list');
  wireItemActionsDrawer('recently-cancelled-list');
  // Close any open actions-drawer when tapping elsewhere on the page.
  document.addEventListener('click', (e) => {
    if (e.target.closest('.item-actions-group')) return;
    document.querySelectorAll('.item-actions-group.drawer-open').forEach(g => g.classList.remove('drawer-open'));
  });

  const searchResultsEl = document.getElementById('search-results');
  searchResultsEl.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-bulk-select]');
    if (!cb) return;
    const id = parseInt(cb.dataset.bulkSelect, 10);
    if (cb.checked) selectedSearchIds.add(id); else selectedSearchIds.delete(id);
    updateBulkToolbar();
  });

  function wireBulkSelectChange(containerId, selectionSet, updateToolbarFn) {
    document.getElementById(containerId).addEventListener('change', (e) => {
      const cb = e.target.closest('[data-bulk-select]');
      if (!cb) return;
      const id = parseInt(cb.dataset.bulkSelect, 10);
      if (cb.checked) selectionSet.add(id); else selectionSet.delete(id);
      updateToolbarFn();
    });
  }
  wireBulkSelectChange('awaiting-charge-list', selectedDashboardIds, updateDashboardBulkToolbar);
  wireBulkSelectChange('this-week-groups', selectedDashboardIds, updateDashboardBulkToolbar);
  wireBulkSelectChange('dash-shipment-groups', selectedDashboardIds, updateDashboardBulkToolbar);
  wireBulkSelectChange('duplicates-groups', selectedDashboardIds, updateDashboardBulkToolbar);
  wireBulkSelectChange('ghost-items-list', selectedDashboardIds, updateDashboardBulkToolbar);
  wireBulkSelectChange('cal-agenda', selectedCalendarIds, updateCalendarBulkToolbar);

  document.getElementById('search-totals-row').addEventListener('click', async (e) => {
    if (!e.target.closest('#search-csv-btn')) return;
    const csv = buildCsvExport(lastSearchResults);
    const filename = `kaching-search-${new Date().toISOString().slice(0, 10)}.csv`;
    await writeAndShare(filename, csv, 'text/csv');
  });

  document.getElementById('bulk-mark-paid-btn').addEventListener('click', async () => {
    for (const id of selectedSearchIds) await setChargeStatus(id, 'charged');
    selectedSearchIds.clear();
    await refreshAll();
  });
  document.getElementById('bulk-cancel-btn').addEventListener('click', async () => {
    for (const id of selectedSearchIds) await cancelItem(id);
    selectedSearchIds.clear();
    await refreshAll();
  });
  document.getElementById('bulk-remove-btn').addEventListener('click', async () => {
    if (!window.confirm('Remove these permanently? This cannot be undone.')) return;
    for (const id of selectedSearchIds) await deleteItem(id);
    selectedSearchIds.clear();
    await refreshAll();
  });

  function wireBulkActionButtons(prefix, selectionSet) {
    document.getElementById(`${prefix}-bulk-mark-paid-btn`).addEventListener('click', async () => {
      for (const id of selectionSet) await setChargeStatus(id, 'charged');
      selectionSet.clear();
      await refreshAll();
    });
    document.getElementById(`${prefix}-bulk-cancel-btn`).addEventListener('click', async () => {
      for (const id of selectionSet) await cancelItem(id);
      selectionSet.clear();
      await refreshAll();
    });
    document.getElementById(`${prefix}-bulk-remove-btn`).addEventListener('click', async () => {
      if (!window.confirm('Remove these permanently? This cannot be undone.')) return;
      for (const id of selectionSet) await deleteItem(id);
      selectionSet.clear();
      await refreshAll();
    });
  }
  wireBulkActionButtons('dashboard', selectedDashboardIds);
  wireBulkActionButtons('calendar', selectedCalendarIds);

  document.getElementById('dash-shipment-prev-btn').addEventListener('click', () => {
    dashMonth -= 1;
    if (dashMonth < 0) { dashMonth = 11; dashYear -= 1; }
    renderDashboard(allItemsCache);
  });
  document.getElementById('dash-shipment-next-btn').addEventListener('click', () => {
    dashMonth += 1;
    if (dashMonth > 11) { dashMonth = 0; dashYear += 1; }
    renderDashboard(allItemsCache);
  });
  document.getElementById('dash-shipment-today-btn').addEventListener('click', () => {
    const now = getToday();
    dashYear = now.getFullYear();
    dashMonth = now.getMonth();
    renderDashboard(allItemsCache);
  });
  document.querySelectorAll('.section-collapse-toggle[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = document.getElementById(btn.dataset.target);
      if (!body) return;
      const collapsed = body.classList.toggle('collapsed');
      btn.innerHTML = collapsed ? '&#9656;' : '&#9662;';
      btn.setAttribute('aria-label', collapsed ? 'Expand section' : 'Collapse section');
    });
  });

  // Tapping an order number (in the meta line of any item row, wherever
  // it's shown - Dashboard, Calendar, Search, Insights) opens the whole
  // order in a modal, same style as editing a single item, so you can
  // see and act on everything from that order at once.
  document.addEventListener('click', (e) => {
    const orderBtn = e.target.closest('[data-search-order]');
    if (!orderBtn) return;
    openOrderOverviewModal(orderBtn.dataset.searchOrder);
  });

  document.getElementById('cal-prev-btn').addEventListener('click', () => {
    calMonth -= 1;
    if (calMonth < 0) { calMonth = 11; calYear -= 1; }
    selectedCalDate = null;
    renderCalendar(allItemsCache);
  });
  document.getElementById('cal-next-btn').addEventListener('click', () => {
    calMonth += 1;
    if (calMonth > 11) { calMonth = 0; calYear += 1; }
    selectedCalDate = null;
    renderCalendar(allItemsCache);
  });
  document.getElementById('cal-grid').addEventListener('click', (e) => {
    const dayEl = e.target.closest('[data-jump-date]');
    if (!dayEl) return;
    const date = dayEl.dataset.jumpDate;
    const group = document.getElementById(`cal-agenda-group-${date}`);
    if (!group) return;
    const body = document.getElementById(`cal-agenda-body-${date}`);
    if (body) body.classList.remove('collapsed');
    group.scrollIntoView({ behavior: 'smooth', block: 'start' });

    selectedCalDate = date;
    document.querySelectorAll('#cal-grid .cal-day-selected').forEach(el => el.classList.remove('cal-day-selected'));
    dayEl.classList.add('cal-day-selected');
  });

  document.getElementById('cal-today-btn').addEventListener('click', () => {
    const now = getToday();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    selectedCalDate = null;
    renderCalendar(allItemsCache);
  });

  document.getElementById('cal-export-ics-btn').addEventListener('click', async () => {
    const ics = buildIcsExport(allItemsCache);
    const filename = `kaching-calendar-${new Date().toISOString().slice(0, 10)}.ics`;
    try {
      const result = await Filesystem.writeFile({
        path: filename, data: ics, directory: Directory.Documents, encoding: Encoding.UTF8,
      });
      await Share.share({ title: filename, url: result.uri });
    } catch (err) {
      console.error('Calendar export failed:', err);
    }
  });

  document.getElementById('settings-currency').addEventListener('change', async (e) => {
    currencySymbol = e.target.value;
    await setSetting('currency_symbol', currencySymbol);
    await refreshAll();
  });

  document.getElementById('settings-save-notifications-btn').addEventListener('click', async () => {
    const enabled = document.getElementById('settings-notifications-enabled').checked;
    const time = document.getElementById('settings-notify-time').value || '08:00';
    const notifyQuietDays = document.getElementById('settings-notify-quiet-days').checked;
    const weeklyEnabled = document.getElementById('settings-weekly-digest-enabled').checked;
    const weeklyDay = document.getElementById('settings-weekly-digest-day').value;
    await setSetting('notify_enabled', enabled ? 'yes' : 'no');
    await setSetting('notify_time', time);
    await setSetting('notify_on_quiet_days', notifyQuietDays ? 'yes' : 'no');
    await setSetting('weekly_digest_enabled', weeklyEnabled ? 'yes' : 'no');
    await setSetting('weekly_digest_day', weeklyDay);
    const statusEl = document.getElementById('notification-status');
    try {
      await scheduleNotification(enabled, time, notifyQuietDays);
      await scheduleWeeklyNotification(weeklyEnabled, weeklyDay, time);
      statusEl.textContent = 'Saved.';
    } catch (err) {
      statusEl.textContent = `Couldn't schedule: ${err.message || err}`;
    }
  });

  document.getElementById('settings-test-notification-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('notification-status');
    try {
      const permission = await LocalNotifications.requestPermissions();
      if (permission.display !== 'granted') {
        statusEl.textContent = 'Notification permission was not granted.';
        return;
      }
      const tomorrowItems = findTomorrowReleases(allItemsCache, new Date());
      const { title, body } = buildTomorrowNotification(tomorrowItems, currencySymbol);
      await LocalNotifications.schedule({
        notifications: [{ id: 2, title, body, schedule: { at: new Date(Date.now() + 2000) } }],
      });
      statusEl.textContent = 'Test notification sent.';
    } catch (err) {
      statusEl.textContent = `Test failed: ${err.message || err}`;
    }
  });

  document.getElementById('settings-save-budget-btn').addEventListener('click', async () => {
    const value = document.getElementById('settings-budget').value;
    monthlyBudget = value ? parseFloat(value) : null;
    await setSetting('monthly_budget', value || '');
    budgetCycle = document.getElementById('settings-budget-cycle').value;
    await setSetting('budget_cycle', budgetCycle);
    budgetRollover = document.getElementById('settings-budget-rollover').checked;
    await setSetting('budget_rollover', budgetRollover ? 'yes' : 'no');
    await setSetting('budget_alert_enabled', document.getElementById('settings-budget-alert-enabled').checked ? 'yes' : 'no');
    await refreshAll();
  });

  document.getElementById('settings-test-budget-alert-btn').addEventListener('click', async () => {
    const btn = document.getElementById('settings-test-budget-alert-btn');
    const original = btn.textContent;
    btn.textContent = 'Sending...';
    btn.disabled = true;
    try {
      const result = await checkBudgetAlert(allItemsCache, true);
      btn.textContent = result && result.sent ? 'Sent!' : (result && result.reason) || 'Failed';
    } catch (err) {
      btn.textContent = err.message || 'Failed';
    } finally {
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2500);
    }
  });

  document.getElementById('settings-landing-page').addEventListener('change', async (e) => {
    await setSetting('default_landing_page', e.target.value);
  });

  document.getElementById('settings-auto-backup-enabled').addEventListener('change', async (e) => {
    await setSetting('auto_backup_enabled', e.target.checked ? 'yes' : 'no');
    if (e.target.checked) {
      runAutoBackupIfDue().catch(err => console.error('Auto backup failed:', err));
    }
  });

  document.getElementById('settings-sync-save-btn').addEventListener('click', async () => {
    const url = document.getElementById('settings-sync-url').value.trim();
    const key = document.getElementById('settings-sync-key').value.trim();
    const label = document.getElementById('settings-sync-label').value.trim();
    await setSetting('sync_server_url', url);
    await setSetting('sync_key', key);
    await setSetting('sync_client_label', label);
    document.getElementById('sync-status').textContent = 'Saved.';
  });

  document.getElementById('settings-sync-now-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('sync-status');
    statusEl.textContent = 'Syncing...';
    const result = await runSync();
    if (!result.ok) {
      statusEl.textContent = result.message;
      return;
    }
    let message = `Synced - sent ${result.pushed}, received ${result.pulled}.`;
    if (result.reconciled) {
      message += ` ${result.reconciled} item(s) were linked with an existing matching record on the server.`;
    }
    if (result.conflicts) {
      message += ` ${result.conflicts} item(s) need your review.`;
    }
    if (result.skippedDuplicates) {
      message += ` ${result.skippedDuplicates} couldn't be automatically linked and were skipped for now.`;
    }
    statusEl.textContent = message;
    await updateConflictBanner();
    await refreshAll();
  });

  document.getElementById('settings-sync-review-conflicts-btn').addEventListener('click', () => {
    openConflictsModal();
  });

  document.getElementById('settings-sync-force-full-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('sync-status');
    await forceFullResync();
    statusEl.textContent = 'Syncing everything...';
    const result = await runSync();
    if (!result.ok) {
      statusEl.textContent = result.message;
      return;
    }
    let message = `Synced - sent ${result.pushed}, received ${result.pulled}.`;
    if (result.reconciled) {
      message += ` ${result.reconciled} item(s) were linked with an existing matching record on the server.`;
    }
    if (result.conflicts) {
      message += ` ${result.conflicts} item(s) need your review.`;
    }
    if (result.skippedDuplicates) {
      message += ` ${result.skippedDuplicates} couldn't be automatically linked and were skipped for now.`;
    }
    statusEl.textContent = message;
    await updateConflictBanner();
    await refreshAll();
  });

  document.getElementById('settings-reset-btn').addEventListener('click', async () => {
    const typed = document.getElementById('settings-reset-confirm').value;
    if (typed !== 'RESET') {
      window.alert('Type RESET (in capitals) to confirm.');
      return;
    }
    const confirmed = window.confirm('This permanently deletes every tracked item. This cannot be undone. Continue?');
    if (!confirmed) return;
    await deleteAllItems();
    document.getElementById('settings-reset-confirm').value = '';
    await refreshAll();
  });

  async function writeAndShare(filename, contents, mimeType) {
    const statusEl = document.getElementById('export-status');
    try {
      const result = await Filesystem.writeFile({
        path: filename,
        data: contents,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
      });
      await Share.share({ title: filename, url: result.uri });
      statusEl.textContent = `Exported ${filename}.`;
    } catch (err) {
      statusEl.textContent = `Export failed: ${err.message || err}`;
    }
  }

  document.getElementById('settings-export-csv-btn').addEventListener('click', async () => {
    const csv = buildCsvExport(allItemsCache);
    const filename = `kaching-export-${new Date().toISOString().slice(0, 10)}.csv`;
    await writeAndShare(filename, csv, 'text/csv');
  });

  document.getElementById('settings-show-shipping-debug-btn').addEventListener('click', () => {
    const out = document.getElementById('shipping-debug-output');
    out.classList.remove('hidden');
    if (shipmentGroupDebugLog.length === 0) {
      out.textContent = 'No Forbidden Planet shipment groups found.';
      return;
    }
    const totalReal = shipmentGroupDebugLog.filter(g => g.source === 'real').reduce((s, g) => s + g.rate, 0);
    const totalEstimated = shipmentGroupDebugLog.filter(g => g.source === 'estimated').reduce((s, g) => s + g.rate, 0);
    const lines = [
      `${shipmentGroupDebugLog.length} shipment groups \u00b7 ${shipmentGroupDebugLog.filter(g => g.source === 'real').length} real (\u00a3${totalReal.toFixed(2)}) \u00b7 ${shipmentGroupDebugLog.filter(g => g.source === 'estimated').length} estimated (\u00a3${totalEstimated.toFixed(2)})`,
      '',
      ...shipmentGroupDebugLog.map(g =>
        `${g.date}  [${g.source.toUpperCase().padEnd(9)}]  £${g.rate.toFixed(2)}  (${g.itemCount} item${g.itemCount !== 1 ? 's' : ''}, order ${g.orders || 'none'})`
      ),
    ];
    out.textContent = lines.join('\n');
  });

  document.getElementById('settings-export-json-btn').addEventListener('click', async () => {
    const json = buildJsonBackup(allItemsCache);
    const filename = `kaching-backup-${new Date().toISOString().slice(0, 10)}.json`;
    await writeAndShare(filename, json, 'application/json');
  });

  document.getElementById('settings-restore-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = document.getElementById('export-status');
    const text = await file.text();
    const { valid, error, items } = parseJsonBackup(text);
    if (!valid) {
      statusEl.textContent = `Restore failed: ${error}`;
      return;
    }
    const confirmed = window.confirm(`Restore ${items.length} item(s) from this backup? This adds to what's already tracked, it doesn't replace it.`);
    if (!confirmed) return;
    for (const item of items) {
      await insertItem({
        name: item.name, price: item.price, release_date: item.release_date || null,
        shop: item.shop || null, order_number: item.order_number || null,
        shipping: item.shipping ?? null, status: item.status || 'preorder',
        placed_date: item.placed_date || null,
        manualOverride: !!item.manual_override,
      });
    }
    await upsertOrderShipping(computeOrderShippingTotals(items), null);
    statusEl.textContent = `Restored ${items.length} item(s).`;
    e.target.value = '';
    await refreshAll();
  });
}

if (typeof window !== 'undefined') {
  main().catch((err) => console.error('Ka-Ching! failed to start:', err));
}
