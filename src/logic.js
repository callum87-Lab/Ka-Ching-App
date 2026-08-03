// Pure logic - no SQLite, no DOM, no Capacitor. Genuinely testable in
// plain Node, exactly like Ka-Ching!'s own web app keeps its parsing
// logic separate from its database code.

/**
 * Validates a new item's input before it's ever written to storage.
 * Mirrors the same "never guess, leave it for the person to fix" spirit
 * as the main web app - required fields are genuinely required, optional
 * ones stay optional, nothing gets silently defaulted to something wrong.
 */
export function validateItemInput({ name, price, release_date, shop }) {
  const errors = [];
  const trimmedName = (name || "").trim();
  if (!trimmedName) errors.push("Name is required.");

  const parsedPrice = parseFloat(price);
  if (price === "" || price === undefined || price === null || Number.isNaN(parsedPrice)) {
    errors.push("Price is required.");
  } else if (parsedPrice < 0) {
    errors.push("Price can't be negative.");
  }

  if (release_date && !/^\d{4}-\d{2}-\d{2}$/.test(release_date)) {
    errors.push("Release date must be in YYYY-MM-DD format.");
  }

  return {
    valid: errors.length === 0,
    errors,
    cleaned: errors.length === 0 ? {
      name: trimmedName,
      price: Math.round(parsedPrice * 100) / 100,
      release_date: release_date || null,
      shop: (shop || "").trim() || null,
    } : null,
  };
}

/** Formats a number as a currency string - matches the main web app's
 * own "%.2f" formatting exactly, so figures always look consistent.
 * Defaults to £, but accepts any symbol for the Settings currency choice. */
export function formatCurrency(amount, symbol = '£') {
  return `${symbol}${(Math.round(amount * 100) / 100).toFixed(2)}`;
}

/** Sums every tracked item's price - Stage 1 has no paid/cancelled
 * status yet, so "still due" simply means "everything tracked". Rounds
 * the final sum to avoid floating-point drift (e.g. 4.99 + 3.5 + 12.00
 * coming out as 20.490000000000002 instead of 20.49). */
export function computeStillDueTotal(items) {
  const total = items.reduce((sum, item) => sum + item.price, 0);
  return Math.round(total * 100) / 100;
}

/** Comics + shipping combined - matches the webui's own approach for
 * every "current/forecast spend" figure (Dashboard hero, budget, next
 * month forecast, This Week/Month totals, Search totals). Kept separate
 * from computeStillDueTotal, which stays comics-only for its own correct
 * consumers (the shipping-ratio and comics-vs-shipping split calculations
 * specifically need comics isolated from shipping, not combined). */
export function computeStillDueTotalWithShipping(items) {
  const total = items.filter(i => i.status !== 'cancelled').reduce((sum, item) => sum + item.price + (parseFloat(item.shipping) || 0), 0);
  return Math.round(total * 100) / 100;
}

/** Sorts items by release date (soonest first), with no-date items last -
 * same ordering logic as the main dashboard's own item lists. */
export function sortItemsByReleaseDate(items) {
  return [...items].sort((a, b) => {
    if (!a.release_date && !b.release_date) return 0;
    if (!a.release_date) return 1;
    if (!b.release_date) return -1;
    return a.release_date.localeCompare(b.release_date);
  });
}

/** Groups items by release date for the Calendar view - items with no
 * date go in their own "no date set" group, kept last rather than mixed
 * in confusingly with real dates. Each group is { date, items, total }. */
export function groupItemsByReleaseDate(items) {
  const groups = new Map();
  const noDateItems = [];

  for (const item of items) {
    if (!item.release_date) {
      noDateItems.push(item);
      continue;
    }
    if (!groups.has(item.release_date)) groups.set(item.release_date, []);
    groups.get(item.release_date).push(item);
  }

  const sortedDates = [...groups.keys()].sort();
  const result = sortedDates.map(date => ({
    date,
    items: groups.get(date),
    total: computeStillDueTotal(groups.get(date)),
  }));

  if (noDateItems.length > 0) {
    result.push({ date: null, items: noDateItems, total: computeStillDueTotal(noDateItems) });
  }

  return result;
}

/** Filters items down to a single shop - returns everything unfiltered
 * if shop is empty/null, matching the web app's "All shops" tab. */
export function filterByShop(items, shop) {
  if (!shop) return items;
  return items.filter(i => shopGroupName(i.shop || 'Unknown shop') === shop);
}

/** Spent/total/count for a given calendar year, plus the same three
 * figures across everything ever tracked - matches the web app's
 * "this year so far" and "all time" dashboard block. Non-cancelled items
 * only count toward "spent" if charged; "total" counts everything
 * non-cancelled regardless of paid status. */
/** The date an item counts toward for month/year spend history - its
 * release date if known, otherwise when the order was placed. Matches
 * the web app's own COALESCE(release_date, placed_date): a dispatched
 * item often has no release date at all (it already shipped before we
 * ever tracked a date for it), but it still happened on a real day and
 * should still show up in past spend rather than vanishing from every
 * month-based chart forever. This is only for retrospective spend
 * views - the still-due lists (This week, Month by shipment) stay
 * release-date-only, since those are about what's still to come. */
function effectiveDate(item) {
  return item.release_date || item.placed_date || null;
}

export function computeYearStats(items, year) {
  const build = (list) => {
    const active = list.filter(i => i.status !== 'cancelled');
    const spent = active.filter(i => i.charge_status === 'charged').reduce((s, i) => s + i.price, 0);
    const total = active.reduce((s, i) => s + i.price, 0);
    return {
      spent: Math.round(spent * 100) / 100,
      total: Math.round(total * 100) / 100,
      count: active.length,
    };
  };
  const yearItems = items.filter(i => effectiveDate(i) && effectiveDate(i).startsWith(String(year)));
  return { year: build(yearItems), allTime: build(items) };
}

/** Builds monthly spend totals for the last N months (including the
 * current one), oldest first - the data behind the dashboard's spend
 * trend chart. Each entry is { label, total }. */
/** Comics/shipping/count breakdown for a set of items already narrowed to
 * one period - shared by the trend builders below so the chart's tap
 * tooltip can show the same split the web app's does. */
function computePeriodBreakdown(items) {
  const dated = items.filter(i => i.status !== 'cancelled');
  const comics = Math.round(dated.reduce((sum, i) => sum + i.price, 0) * 100) / 100;
  const shipping = Math.round(dated.reduce((sum, i) => sum + (i.shipping || 0), 0) * 100) / 100;
  return { comics, shipping, total: Math.round((comics + shipping) * 100) / 100, count: dated.length };
}

export function buildMonthlySpendTrend(items, monthsBack, referenceDate) {
  const result = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - i, 1);
    const label = d.toLocaleString('en-GB', { month: 'short' });
    const monthPrefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    // Strict release_date only, no placed_date fallback - matches the
    // webui's month_stats exactly (`dated_items = [i for i in all_items
    // if i["release_date"]]`), which is what this specific 12-month
    // Insights chart is built from on the webui side. This is
    // deliberately different from Dashboard's own charts/hero figures,
    // which correctly DO fall back to placed_date - don't "fix" those to
    // match this, they're already right.
    const monthItems = items.filter(it => it.release_date && it.release_date.startsWith(monthPrefix));
    result.push({ label, ...computePeriodBreakdown(monthItems) });
  }
  return result;
}

/** Same shape as buildMonthlySpendTrend but spans back AND forward from
 * today, e.g. 3 months back + 5 forward - used by the dashboard's
 * WEEK/MONTH/6M range toggle, mirroring the web app's own range tabs. */
export function buildMonthlySpendTrendRange(items, monthsBack, monthsForward, referenceDate) {
  const result = [];
  for (let i = -monthsBack; i <= monthsForward; i++) {
    const d = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + i, 1);
    const label = d.toLocaleString('en-GB', { month: 'short' });
    const monthPrefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const monthItems = items.filter(it => effectiveDate(it) && effectiveDate(it).startsWith(monthPrefix));
    result.push({ label, ...computePeriodBreakdown(monthItems) });
  }
  return result;
}

/** Week-by-week version of the same trend, weeks starting Monday - spans
 * back AND forward from today's week, e.g. 4 weeks back + 8 forward. */
export function buildWeeklySpendTrend(items, weeksBack, weeksForward, referenceDate) {
  const day = referenceDate.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const thisMonday = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() + mondayOffset);
  const result = [];
  for (let i = -weeksBack; i <= weeksForward; i++) {
    const wStart = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() + i * 7);
    const wEnd = new Date(wStart.getFullYear(), wStart.getMonth(), wStart.getDate() + 6);
    const startIso = isoDate(wStart);
    const endIso = isoDate(wEnd);
    const weekItems = items.filter(it => effectiveDate(it) && effectiveDate(it) >= startIso && effectiveDate(it) <= endIso);
    const label = wStart.toLocaleString('en-GB', { day: '2-digit', month: 'short' });
    result.push({ label, ...computePeriodBreakdown(weekItems) });
  }
  return result;
}

/** Builds a real iCalendar (.ics) file for every dated, non-cancelled
 * item - one VEVENT per release date, matching the web app's own
 * calendar export. Escapes text per the iCalendar spec (commas,
 * semicolons, and literal newlines all need escaping, or a real
 * calendar app can misparse the file). */
export function buildIcsExport(items) {
  const escapeIcs = (str) => String(str).replace(/[\\,;]/g, (m) => `\\${m}`).replace(/\n/g, '\\n');
  const dated = items.filter(i => i.release_date && i.status !== 'cancelled');
  const groups = groupItemsByReleaseDate(dated).filter(g => g.date !== null);

  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ka-Ching!//App//EN'];
  for (const group of groups) {
    const dateCompact = group.date.replace(/-/g, '');
    const summary = group.items.length === 1
      ? group.items[0].name
      : `${group.items.length} items releasing`;
    const description = group.items.map(i => `${i.name} (${i.price.toFixed(2)})`).join('\\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:kaching-${group.date}@kaching.app`,
      `DTSTART;VALUE=DATE:${dateCompact}`,
      `SUMMARY:${escapeIcs(summary)}`,
      `DESCRIPTION:${escapeIcs(description)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/** Spent/still-due/cancelled totals for a set of search results - matches
 * the web app's own breakdown. "Spent" only counts charged items;
 * "remaining" is everything else non-cancelled; cancelled items are
 * reported separately and don't count toward either. */
export function computeSearchTotals(items) {
  const active = items.filter(i => i.status !== 'cancelled');
  const cancelled = items.filter(i => i.status === 'cancelled');
  const spent = active.filter(i => i.charge_status === 'charged').reduce((s, i) => s + i.price, 0);
  const remaining = active.filter(i => i.charge_status !== 'charged').reduce((s, i) => s + i.price, 0);
  const cancelledTotal = cancelled.reduce((s, i) => s + i.price, 0);
  return {
    spent: Math.round(spent * 100) / 100,
    remaining: Math.round(remaining * 100) / 100,
    cancelledCount: cancelled.length,
    cancelledTotal: Math.round(cancelledTotal * 100) / 100,
  };
}

/** Same as computeSearchTotals, but comics+shipping combined - matches
 * the webui's Dashboard hero (hero_spent_total/hero_remaining_total),
 * which is a genuinely different figure from the webui's own Search
 * page (comics-only there). Used for Dashboard/This Week/This Month,
 * never for Search itself. */
export function computeSpentRemainingWithShipping(items) {
  const active = items.filter(i => i.status !== 'cancelled');
  const spent = active.filter(i => i.charge_status === 'charged').reduce((s, i) => s + i.price + (parseFloat(i.shipping) || 0), 0);
  const remaining = active.filter(i => i.charge_status !== 'charged').reduce((s, i) => s + i.price + (parseFloat(i.shipping) || 0), 0);
  return { spent: Math.round(spent * 100) / 100, remaining: Math.round(remaining * 100) / 100 };
}

/** Matches the web app's own "has_filter" gate: with nothing entered -
 * no text query, no shop/status/date/price filter set - Search should
 * show nothing rather than every tracked item. Only once something is
 * actually set does it make sense to run filterItems at all. */
export function hasActiveSearchFilter({ query, minPrice, maxPrice, startDate, endDate, shop, status } = {}) {
  const trimmedQuery = (query || '').trim();
  const hasMin = minPrice !== undefined && minPrice !== null && minPrice !== '';
  const hasMax = maxPrice !== undefined && maxPrice !== null && maxPrice !== '';
  return Boolean(trimmedQuery || shop || (status && status !== 'all') || startDate || endDate || hasMin || hasMax);
}

/** Non-cancelled, dated items released within a given calendar month -
 * the same "fetch_items_between" scoping the web app's own Dashboard
 * uses for its browsable month section, as raw items rather than just
 * a spend total. */
export function itemsInMonth(items, year, month) {
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  return items.filter(i => {
    const d = effectiveDate(i);
    return d && d.startsWith(monthPrefix) && i.status !== 'cancelled';
  });
}

const SHIPMENT_DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHIPMENT_MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Wed 08 Jul" - the same date label style the web app's own shipment
 * groups use, built from a plain ISO date so it doesn't depend on the
 * browser's locale settings. */
export function formatShipmentDateLabel(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  return `${SHIPMENT_DAY_ABBR[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${SHIPMENT_MONTH_ABBR[d.getMonth()]}`;
}

/** "19 Aug 2026" - the web app's own Search result row date style: no
 * weekday, but includes the year (unlike the shipment-group label,
 * which has a weekday but drops the year since it's always the
 * currently-viewed month). Returns "no date set" for a null date,
 * matching the web app's own fallback text exactly. */
export function formatSearchDateLabel(isoDate) {
  if (!isoDate) return 'no date set';
  const d = new Date(`${isoDate}T00:00:00`);
  return `${String(d.getDate()).padStart(2, '0')} ${SHIPMENT_MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
}

/** Groups items by release date, then sub-groups each date by the exact
 * shop/source string - matches the web app's own Dashboard "by shipment"
 * view, where one release date can hold several separate shipments
 * (e.g. two different eBay sellers on the same day stay as two distinct
 * shipments rather than being folded into one "eBay" group). Only dated,
 * non-cancelled items are grouped - filter the input with itemsInMonth
 * or a week-range filter first. Each group is
 * { date, dateLabel, shopGroups: [{ shop, color, items, subtotal }],
 * subtotal, allPaid }, sorted oldest date first. */
export function groupItemsByDateAndShop(items) {
  const byDate = new Map();
  for (const item of items) {
    const date = effectiveDate(item);
    if (!date || item.status === 'cancelled') continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(item);
  }

  const sortedDates = [...byDate.keys()].sort();
  return sortedDates.map(date => {
    const dateItems = byDate.get(date);
    const byShop = new Map();
    for (const item of dateItems) {
      const shop = item.shop || 'Unknown shop';
      if (!byShop.has(shop)) byShop.set(shop, []);
      byShop.get(shop).push(item);
    }
    const shopGroups = [...byShop.entries()].map(([shop, entries]) => ({
      shop,
      color: assignShopColor(shop),
      items: entries,
      subtotal: computeStillDueTotal(entries),
    }));
    return {
      date,
      dateLabel: formatShipmentDateLabel(date),
      shopGroups,
      subtotal: computeStillDueTotal(dateItems),
      allPaid: dateItems.every(i => i.charge_status === 'charged'),
    };
  });
}

/** Filters items for the Search screen - matches name or shop
 * (case-insensitive), and an optional min/max price range. An empty
 * query with no price bounds returns everything, matching the main web
 * app's own "no filter set" behaviour.
 *
 * Undated items (release_date: null - e.g. dispatched Forbidden Planet
 * orders with no "Release date:" line) have no way to fall inside a
 * From/To range or a date preset, so a date filter alone can't say
 * whether they belong. includeUndated controls what happens to them
 * when a date filter IS active: true (default) keeps them visible
 * alongside the dated matches; false hides them, for a strict
 * "only things dated in this range" view. */
export function filterItems(items, { query, minPrice, maxPrice, startDate, endDate, shop, includeUndated = true } = {}) {
  const trimmedQuery = (query || '').trim().toLowerCase();
  const min = (minPrice !== undefined && minPrice !== null && minPrice !== '') ? parseFloat(minPrice) : null;
  const max = (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') ? parseFloat(maxPrice) : null;

  return items.filter(item => {
    if (trimmedQuery) {
      const nameMatch = item.name.toLowerCase().includes(trimmedQuery);
      const shopMatch = (item.shop || '').toLowerCase().includes(trimmedQuery);
      const orderMatch = (item.order_number || '').toLowerCase().includes(trimmedQuery);
      if (!nameMatch && !shopMatch && !orderMatch) return false;
    }
    if (min !== null && !Number.isNaN(min) && item.price < min) return false;
    if (max !== null && !Number.isNaN(max) && item.price > max) return false;
    if (shop && item.shop !== shop) return false;
    if (startDate || endDate) {
      if (!item.release_date) {
        if (!includeUndated) return false;
      } else {
        if (startDate && item.release_date < startDate) return false;
        if (endDate && item.release_date > endDate) return false;
      }
    }
    return true;
  });
}

/** Average price across every tracked item - 0 for an empty list, rather
 * than NaN from dividing by zero. */
export function computeAveragePrice(items) {
  const active = items.filter(i => i.status !== 'cancelled');
  if (active.length === 0) return 0;
  return Math.round((computeStillDueTotal(active) / active.length) * 100) / 100;
}

/** The single most expensive tracked item, or null if there are none.
 * Cancelled items don't count - something you backed out of was never
 * really "tracked" spend. */
export function findPriciestItem(items) {
  const active = items.filter(i => i.status !== 'cancelled');
  if (active.length === 0) return null;
  return active.reduce((max, item) => (item.price > max.price ? item : max), active[0]);
}

/** The top N most expensive items, highest first - same idea as the main
 * web app's "Top 3 most expensive titles" card. Cancelled items excluded,
 * same reasoning as findPriciestItem. */
export function topExpensiveItems(items, count = 3) {
  return items.filter(i => i.status !== 'cancelled').sort((a, b) => b.price - a.price).slice(0, count);
}

/** Groups spend by shop - unlabelled/blank shops are grouped together
 * under "Unknown shop" rather than silently dropped or mixed into a real
 * shop's total. Sorted highest-spend first. */
export function groupSpendByShop(items) {
  const totals = new Map();
  for (const item of items) {
    const shop = item.shop || 'Unknown shop';
    totals.set(shop, (totals.get(shop) || 0) + item.price);
  }
  return [...totals.entries()]
    .map(([shop, total]) => ({ shop, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);
}

const SOURCE_PALETTE = ['#3cf2a6', '#9b7bff', '#ff4d8d', '#ffd166', '#5ec8f2', '#ff9f5e'];

/** Stable colour per shop name, matching the web app's own palette - a
 * simple string hash rather than the web app's MD5, since the goal is a
 * consistent distinct colour per shop rather than an identical pick.
 * Forbidden Planet always gets the app's primary accent, same as web. */
export function assignShopColor(name) {
  if (name === 'Forbidden Planet') return '#2fd8ff';
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return SOURCE_PALETTE[hash % SOURCE_PALETTE.length];
}

/** The "top-level shop" a per-seller eBay source belongs to under - e.g.
 * 'eBay - sad_lemon_comics' groups under 'eBay'. Mirrors the web app's own
 * grouping, since a separate row per eBay seller gets unwieldy fast. */
export function shopGroupName(shop) {
  if (shop === 'eBay' || shop.startsWith('eBay -')) return 'eBay';
  return shop;
}

/** Spend-by-shop breakdown for Insights, with per-seller eBay sources
 * collapsed into one expandable "eBay" row - each top-level entry carries
 * its own colour, bar percentage (relative to the biggest shop), and,
 * where it groups sub-sellers, a sorted sub_shops list with the same
 * shape. Mirrors the web app's shop_stats exactly. */
export function groupSpendByShopWithSellers(items) {
  const bySource = new Map();
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    const shop = item.shop || 'Unknown shop';
    if (!bySource.has(shop)) bySource.set(shop, { shop, total: 0, count: 0 });
    const entry = bySource.get(shop);
    entry.total += item.price + (parseFloat(item.shipping) || 0);
    entry.count += 1;
  }

  const grouped = new Map();
  for (const s of bySource.values()) {
    const groupName = shopGroupName(s.shop);
    if (!grouped.has(groupName)) {
      grouped.set(groupName, { shop: groupName, color: assignShopColor(groupName), total: 0, count: 0, subShops: [] });
    }
    const g = grouped.get(groupName);
    g.total += s.total;
    g.count += s.count;
    if (groupName !== s.shop) {
      g.subShops.push({ shop: s.shop, color: assignShopColor(s.shop), total: Math.round(s.total * 100) / 100, count: s.count });
    }
  }

  const shopStats = [...grouped.values()].map(s => ({ ...s, total: Math.round(s.total * 100) / 100 }));
  shopStats.forEach(s => s.subShops.sort((a, b) => b.total - a.total));
  shopStats.sort((a, b) => b.total - a.total);
  const maxTotal = Math.max(...shopStats.map(s => s.total), 1);
  shopStats.forEach(s => {
    s.pct = Math.round((s.total / maxTotal) * 1000) / 10;
    s.subShops.forEach(sub => { sub.pct = Math.round((sub.total / maxTotal) * 1000) / 10; });
  });
  return shopStats;
}

/** Builds a real calendar month grid (like the main web app's Calendar
 * page) for a given year/month (0-indexed month, matching JS Date) -
 * an array of week rows, each a fixed 7-day array (nulls for the blank
 * leading/trailing days outside the month), each real day annotated
 * with its own items and total. */
export function buildCalendarGrid(items, year, month, referenceDate) {
  const byDate = new Map();
  for (const item of items) {
    if (!item.release_date) continue;
    if (!byDate.has(item.release_date)) byDate.set(item.release_date, []);
    byDate.get(item.release_date).push(item);
  }

  const todayIso = referenceDate ? isoDate(referenceDate) : null;
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // JS getUTCDay(): 0=Sunday..6=Saturday. Convert to a Monday-first index
  // (0=Monday..6=Sunday), matching the main web app's calendar layout.
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;

  const days = [];
  for (let i = 0; i < leadingBlanks; i++) days.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayItems = byDate.get(iso) || [];
    days.push({ date: iso, day: d, items: dayItems, total: computeStillDueTotal(dayItems), isToday: iso === todayIso });
  }
  while (days.length % 7 !== 0) days.push(null);

  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

/** How much has been spent so far this month (by release date falling
 * within it) - the same idea as the main dashboard's monthly forecast,
 * just without a separate shipping estimate (Stage 1 has no shipping
 * concept yet). */
export function computeMonthSpend(items, year, month) {
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthItems = items.filter(i => i.status !== 'cancelled' && i.release_date && i.release_date.startsWith(monthPrefix));
  return computeStillDueTotalWithShipping(monthItems);
}

/** Same as computeMonthSpend, but falls back to placed_date when there's
 * no release_date yet - matches the webui's "next month forecast"
 * specifically (explicitly documented there as deliberately reusing the
 * Dashboard hero's fetch_items_between/COALESCE convention, even on the
 * Insights page where every other stat - avg, priciest, the trend badge,
 * budget - correctly stays strict release_date-only). A future pre-order
 * is much more likely to still be undated the further out the forecast
 * month is, which is why this only showed up as a real mismatch for a
 * forecast several months ahead, not for the current month. */
export function computeMonthSpendWithFallback(items, year, month) {
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthItems = items.filter(i => i.status !== 'cancelled' && effectiveDate(i) && effectiveDate(i).startsWith(monthPrefix));
  return computeStillDueTotalWithShipping(monthItems);
}

/** Budget progress as a percentage (0-100, capped at 100 for display
 * purposes) - null if no budget is set, so the caller can decide to hide
 * the bar entirely rather than show a meaningless 0%. */
export function computeBudgetProgress(spend, budget) {
  if (!budget || budget <= 0) return null;
  return Math.min(100, Math.round((spend / budget) * 100));
}

/** Works out the effective budget for the current cycle when rollover is
 * enabled - unused budget from the previous monthly cycle carries
 * forward, same as the web app's own rollover feature. Only applies to
 * "monthly" cycles, matching the web app's own restriction (a rolling
 * 28-day or weekly cycle has no single well-defined "previous cycle" to
 * roll over from in the same simple way). Returns the plain budget
 * unchanged if rollover is off or the cycle isn't monthly. */
export function computeEffectiveBudget(baseBudget, cycle, rolloverEnabled, items, referenceDate) {
  if (!rolloverEnabled || cycle !== 'monthly' || !baseBudget) return baseBudget;
  const prevMonth = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - 1, 1);
  const prevSpend = computeMonthSpend(items, prevMonth.getFullYear(), prevMonth.getMonth());
  const unused = Math.max(0, baseBudget - prevSpend);
  return Math.round((baseBudget + unused) * 100) / 100;
}

/** Works out the start and end date (inclusive, both as real Date
 * objects) of the current budget cycle - "monthly" is the calendar
 * month, "weekly" is the Monday-starting week containing today, and
 * "28day" is a rolling 28-day window ending today, matching the three
 * cycle types the main web app supports. */
export function computeCycleBounds(cycle, referenceDate) {
  const ref = new Date(Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate()));

  if (cycle === 'weekly') {
    const dayIndex = (ref.getUTCDay() + 6) % 7; // Monday-first index
    const start = new Date(ref);
    start.setUTCDate(ref.getUTCDate() - dayIndex);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    return { start, end };
  }

  if (cycle === '28day') {
    const start = new Date(ref);
    start.setUTCDate(ref.getUTCDate() - 27);
    return { start, end: ref };
  }

  // Default: monthly (calendar month)
  const start = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1));
  const end = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0));
  return { start, end };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Spend within the current budget cycle (whichever type is chosen),
 * based on release date - the cycle-aware equivalent of computeMonthSpend. */
export function computeCycleSpend(items, cycle, referenceDate) {
  const { start, end } = computeCycleBounds(cycle, referenceDate);
  const startIso = isoDate(start);
  const endIso = isoDate(end);
  const inCycle = items.filter(i => i.status !== 'cancelled' && i.release_date && i.release_date >= startIso && i.release_date <= endIso);
  return computeStillDueTotalWithShipping(inCycle);
}

/** Finds every non-cancelled item releasing exactly tomorrow, relative to
 * a given reference date - the basis for the daily local reminder. */
export function findTomorrowReleases(items, referenceDate) {
  const tomorrow = new Date(Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate() + 1));
  const tomorrowIso = isoDate(tomorrow);
  return items.filter(i => i.release_date === tomorrowIso && i.status !== 'cancelled');
}

/** Items with the same name and release date but more than one distinct
 * order number - almost always an accidental double-order rather than
 * two genuinely different things releasing the same day. Items with no
 * order number at all don't count as distinguishing (matches the web
 * app's own COUNT(DISTINCT order_number) logic - two undated/unordered
 * items can't be told apart this way, that's what findGhostItems is
 * for). dismissedKeys is a Set of "name|||release_date" strings the
 * user has already said aren't duplicates. */
export function findDuplicateGroups(items, dismissedKeys = new Set()) {
  const active = items.filter(i => i.status !== 'cancelled' && i.release_date);
  const byKey = new Map();
  for (const item of active) {
    const key = `${item.name}|||${item.release_date}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  }

  const groups = [];
  for (const [key, entries] of byKey.entries()) {
    if (dismissedKeys.has(key)) continue;
    const distinctOrders = new Set(entries.map(i => i.order_number).filter(Boolean));
    if (distinctOrders.size > 1) {
      groups.push({
        name: entries[0].name,
        release_date: entries[0].release_date,
        entries: [...entries].sort((a, b) => (a.order_number || '').localeCompare(b.order_number || '')),
      });
    }
  }
  return groups.sort((a, b) => a.release_date.localeCompare(b.release_date));
}

/** Forbidden Planet items with no order number at all - always a parser
 * artifact, never legitimate, since every real Forbidden Planet item
 * comes with an order number attached. Items manually added under other
 * shops are untouched, since having no order number there is normal. */
export function findGhostItems(items) {
  return items
    .filter(i => i.shop === 'Forbidden Planet' && !i.order_number && i.status !== 'cancelled')
    .sort((a, b) => (b.release_date || '').localeCompare(a.release_date || ''));
}

/** The most recently cancelled items, newest first - lets an accidental
 * cancel be undone from the Dashboard without having to go hunt it down
 * in Search. */
/** Last 15 cancelled items, but also dropped after 30 days so a single
 * old cancellation doesn't sit here forever if nothing newer has
 * cancelled since. updated_at is set at the moment the cancel action
 * happens, so it doubles as "when cancelled" here - an item with no
 * updated_at at all (shouldn't happen in practice) is kept rather than
 * silently dropped, since there's nothing to judge its age against. */
export function findRecentlyCancelled(items, limit = 15, referenceDate = new Date(), maxAgeDays = 30) {
  const cutoff = new Date(referenceDate.getTime() - maxAgeDays * 86400000);
  return items
    .filter(i => i.status === 'cancelled' && (!i.updated_at || new Date(i.updated_at) >= cutoff))
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}

/** Items whose release date has already passed but are still sitting unpaid
 * and unmarked - worth a look, since the retailer usually charges right
 * around release day. Mirrors the web app's "Awaiting charge" list. */
export function findAwaitingCharge(items, referenceDate) {
  const todayIso = isoDate(new Date(Date.UTC(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate())));
  return items
    .filter(i => i.status !== 'cancelled' && i.charge_status !== 'charged' && i.release_date && i.release_date < todayIso)
    .map(i => ({ ...i, days_late: Math.round((new Date(todayIso) - new Date(i.release_date)) / 86400000) }))
    .sort((a, b) => (a.release_date < b.release_date ? -1 : a.release_date > b.release_date ? 1 : 0));
}

/** Builds the actual notification title/body for tomorrow's releases,
 * grouped by shop - same shape as the main web app's own daily digest
 * message, just generated locally rather than sent from a server. */
export function buildTomorrowNotification(items, currencySymbol) {
  if (items.length === 0) {
    return { title: 'Ka-Ching!', body: 'Nothing releasing tomorrow.' };
  }
  const total = computeStillDueTotal(items);
  const byShop = groupSpendByShop(items);
  const title = `Tomorrow: ${items.length} item${items.length !== 1 ? 's' : ''}, ${currencySymbol}${total.toFixed(2)}`;
  const body = byShop.map(g => `${g.shop}: ${currencySymbol}${g.total.toFixed(2)}`).join(' \u00b7 ');
  return { title, body };
}

/** Finds every non-cancelled item releasing within the next 7 days
 * (inclusive of today) - the basis for the weekly digest reminder. */
export function findNextWeekReleases(items, referenceDate) {
  const start = isoDate(referenceDate);
  const end = new Date(referenceDate);
  end.setDate(end.getDate() + 6);
  const endIso = isoDate(end);
  return items.filter(i => i.release_date && i.release_date >= start && i.release_date <= endIso && i.status !== 'cancelled');
}

/** Builds the weekly digest notification content - same per-shop
 * breakdown style as the daily one, just covering the next 7 days. */
export function buildWeeklyNotification(items, currencySymbol) {
  if (items.length === 0) {
    return { title: 'Ka-Ching!', body: 'Nothing releasing this week.' };
  }
  const total = computeStillDueTotal(items);
  const byShop = groupSpendByShop(items);
  const title = `This week: ${items.length} item${items.length !== 1 ? 's' : ''}, ${currencySymbol}${total.toFixed(2)}`;
  const body = byShop.map(g => `${g.shop}: ${currencySymbol}${g.total.toFixed(2)}`).join(' \u00b7 ');
  return { title, body };
}

/** Builds a real CSV string of every tracked item - a plain spreadsheet
 * export, not something this app reads back in. Escapes any field
 * containing a comma or quote properly, rather than letting it silently
 * corrupt the file. */
export function buildCsvExport(items) {
  const escape = (val) => {
    const str = String(val ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = 'Name,Price,Release Date,Shop,Status,Order Number,Shipping';
  const rows = items.map(i => [
    escape(i.name), escape(i.price.toFixed(2)), escape(i.release_date || ''),
    escape(i.shop || ''), escape(i.status || ''), escape(i.order_number || ''),
    escape(i.shipping ?? ''),
  ].join(','));
  return [header, ...rows].join('\n');
}

/** Builds the JSON backup payload - everything needed to fully restore
 * every tracked item, plus a version marker so a future restore can tell
 * whether the file's shape is one it actually understands. */
export function buildJsonBackup(items) {
  return JSON.stringify({ version: 1, exported_at: new Date().toISOString(), items }, null, 2);
}

/** Parses and validates a JSON backup file before it's ever trusted -
 * returns { valid, error, items }. Never assumes a file is safe just
 * because it parsed as JSON; checks the actual shape matches what a
 * genuine backup from this app would produce. */
export function parseJsonBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { valid: false, error: 'Not valid JSON.', items: null };
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    return { valid: false, error: 'Not a recognised Ka-Ching! backup file.', items: null };
  }
  for (const item of data.items) {
    if (typeof item.name !== 'string' || typeof item.price !== 'number') {
      return { valid: false, error: 'Backup file contains an invalid item.', items: null };
    }
  }
  return { valid: true, error: null, items: data.items };
}

/** Generic paste-in parser - looks for lines with a name followed by a
 * price anywhere on the same or next line (e.g. "Amazing Spider-Man #5
 * ... £4.99"), and an optional date in DD/MM/YYYY or YYYY-MM-DD form
 * nearby. Deliberately conservative: only returns rows it found a real
 * name and a real price for - never guesses a price or invents a name.
 * Matches the main web app's own generic-fallback parser in spirit, not
 * feature-for-feature - this has no knowledge of any specific retailer's
 * page layout, unlike the web app's dedicated shop parsers. */
const FP_MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/** Parses "16 Sep 2026" or "16 September 2026" into an ISO date string,
 * matching the two formats Forbidden Planet's own pages use. Returns null
 * for anything else, same as the web app's own parse_date. */
function parseFpDate(raw) {
  const m = (raw || '').trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const month = FP_MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  const day = parseInt(m[1], 10);
  const year = parseInt(m[3], 10);
  const d = new Date(year, month, day);
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Same currency-stripping the web app's parse_price does, so "£3.30",
 * "GBP 3.30" and "3.30" all resolve the same way. */
function parseFpPrice(raw) {
  let s = (raw || '').trim();
  for (const sign of ['£', '$', '€', 'GBP', 'USD', 'EUR']) s = s.split(sign).join('');
  s = s.replace(/,/g, '').trim();
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

function classifyFpStatus(line) {
  const l = line.trim();
  if (/^Dispatched/i.test(l)) return 'dispatched';
  if (/^Cancelled/i.test(l)) return 'cancelled';
  if (/^(Pre-?order|Processing|Awaiting Stock|Backordered|Charged)/i.test(l)) return 'preorder';
  return 'unknown';
}

const FP_BLOCK_HEADER_RE = /\b(Placed|Generated|Order\s*#|Subscription Order\s*#|Delivery To|Billing)\b/;

/** Strips a leading bullet marker ("*", "-") and its indentation, since
 * Forbidden Planet's sub-fields (release date, charge status, etc.) render
 * as a nested bullet list under each item. */
function stripFpBullet(line) {
  return line.replace(/^[ \t]*[*\-]\s*/, '').trim();
}

/** True if pasted text looks like a Forbidden Planet order page (either
 * the order-history list or a single order-detail page) - used to
 * auto-route Paste Orders to the dedicated parser below instead of the
 * generic name/price reader. */
export function looksLikeForbiddenPlanet(text) {
  const t = text || '';
  if (/Order\s*#\[?\d/.test(t) && /£\s*\d/.test(t)) return true;
  if (/\[Awaiting product image\]/i.test(t)) return true;
  if (/Release date:/i.test(t) && /(Not charged|Fully charged)/i.test(t)) return true;
  return false;
}

/** Ports the web app's own Forbidden Planet parsing (a blend of
 * parse_order_history and parse_order_detail_items): a line-based,
 * deliberately tolerant walk through a pasted order-history or
 * order-detail page. Handles item names as "[Name](url)" links (with an
 * optional Cancel-item link skipped, not mistaken for a new item), an
 * order number that may itself be "[54621806](url)" or plain text, and
 * sub-fields (release date, charge/dispatch status) appearing as an
 * indented bullet list under each item rather than bare lines. Returns
 * items shaped for insertItem, with Forbidden Planet as the shop. */
export function parseForbiddenPlanetOrders(text) {
  const lines = (text || '').split('\n');
  const n = lines.length;
  let i = 0;
  let currentOrder = null;
  let currentPlacedDate = null;
  const items = [];

  const orderNumberRe = /^Order\s*#\s*\[?(\d+)\]?/i;
  const subscriptionOrderRe = /^Subscription Order\s*#\s*\[?(\d+)\]?/i;
  // Some paste formats split this across two lines entirely - "Order#"
  // on its own, with the bare number on the next line - rather than
  // ever putting the number on the same line at all.
  const orderLabelOnlyRe = /^(?:Subscription\s+)?Order\s*#\s*$/i;
  const bareNumberRe = /^\[?(\d+)\]?$/;
  // When an order has no release date at all (a dispatched item, say),
  // the date it was actually placed/confirmed is the next best thing for
  // month/year spend history - captured from either page format below.
  const confirmedOnRe = /^Confirmed on:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i;
  const placedRe = /^Placed\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i;
  const placedLabelOnlyRe = /^Placed\s*$/i;
  const bareDateRe = /^(\d{1,2}\s+[A-Za-z]+\s+\d{4})$/;
  // A real item link has a trailing (url): "[Name](url)". A bracketed line
  // with nothing after it - "[Awaiting product image]" - is a placeholder
  // shown when the item has no thumbnail yet; the real name is the next
  // line, not the bracket text itself.
  const itemLinkRe = /^\[([^\[\]]+)\]\([^)]*\)$/;
  const bracketOnlyRe = /^\[([^\[\]]+)\]$/;

  function nextNonBlank(idx) {
    while (idx < n && lines[idx].trim() === '') idx++;
    return idx;
  }

  while (i < n) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    if (line === '') { i++; continue; }

    // Strip any leading bullet before testing for either an order-number
    // line or an item link - the order-history LIST page (multiple orders
    // shown together) bullets its "Order#[...]" line the same way it
    // bullets items, unlike the single order-DETAIL page where the order
    // number stands on its own line. Only checking the item link case
    // for a bullet meant an order number arriving with one silently never
    // matched, leaving every item under it with no order number at all.
    const bulletStripped = stripFpBullet(line);
    const subOrderMatch = bulletStripped.match(subscriptionOrderRe);
    const orderMatch = subOrderMatch || bulletStripped.match(orderNumberRe);
    if (orderMatch) {
      currentOrder = orderMatch[1];
      i++;
      continue;
    }
    if (orderLabelOnlyRe.test(bulletStripped)) {
      const next = nextNonBlank(i + 1);
      const numMatch = next < n && lines[next].trim().match(bareNumberRe);
      if (numMatch) {
        currentOrder = numMatch[1];
        i = next + 1;
        continue;
      }
    }

    const confirmedMatch = bulletStripped.match(confirmedOnRe);
    if (confirmedMatch) {
      currentPlacedDate = parseFpDate(confirmedMatch[1]);
      i++;
      continue;
    }
    const placedMatch = bulletStripped.match(placedRe);
    if (placedMatch) {
      currentPlacedDate = parseFpDate(placedMatch[1]);
      i++;
      continue;
    }
    if (placedLabelOnlyRe.test(bulletStripped)) {
      const next = nextNonBlank(i + 1);
      const dateMatch = next < n && lines[next].trim().match(bareDateRe);
      if (dateMatch) {
        currentPlacedDate = parseFpDate(dateMatch[1]);
        i = next + 1;
        continue;
      }
    }

    const linkMatch = bulletStripped.match(itemLinkRe);
    const placeholderMatch = !linkMatch && bulletStripped.match(bracketOnlyRe);
    const isRealItemLink = linkMatch && linkMatch[1].trim().toLowerCase() !== 'cancel item';

    if (isRealItemLink || placeholderMatch) {
      let itemName;
      if (isRealItemLink) {
        itemName = linkMatch[1].trim();
        i++;
      } else {
        // Placeholder line ("[Awaiting product image]") - the actual name
        // is the next non-blank line instead of the bracket text.
        i = nextNonBlank(i + 1);
        if (i >= n) break;
        itemName = lines[i].trim();
        i++;
      }
      i = nextNonBlank(i);
      if (i >= n) break;
      const status = classifyFpStatus(lines[i].trim());
      i++;

      let releaseDate = null;
      let chargeStatus = null;
      let price = null;
      let dispatchGroup = null;

      while (i < n) {
        const l = stripFpBullet(lines[i]);
        if (l.startsWith('£')) {
          price = parseFpPrice(l);
          i++;
          break;
        }
        if (l === '') { i++; continue; }
        if (FP_BLOCK_HEADER_RE.test(l)) {
          price = null;
          break;
        }
        const releaseMatch = l.match(/^Release date:\s*(.+)$/i);
        const dispatchLinkMatch = l.match(/^\[Dispatched[^\]]*\]\([^)]*\/dispatch\/(\d+)\/?\)$/i);
        if (releaseMatch) {
          releaseDate = parseFpDate(releaseMatch[1]);
        } else if (dispatchLinkMatch) {
          dispatchGroup = dispatchLinkMatch[1];
        } else if (/^Not charged/i.test(l)) {
          chargeStatus = 'not_charged';
        } else if (/^Fully charged/i.test(l)) {
          chargeStatus = 'charged';
        }
        i++;
      }

      if (price === null) continue;

      items.push({
        name: itemName,
        price,
        release_date: releaseDate,
        shop: 'Forbidden Planet',
        order_number: currentOrder,
        placed_date: currentPlacedDate,
        status,
        charge_status: chargeStatus || (status === 'dispatched' ? 'charged' : 'not_charged'),
        _fpDispatchGroup: dispatchGroup,
      });
      continue;
    }

    i++;
  }

  // Order-detail pages (unlike the order-history list) show a real,
  // exact postage figure - either one flat "Postage:£X.XX" line for the
  // whole order, or, when it genuinely shipped in several separate
  // parcels on different dates, a per-parcel breakdown ("One package
  // with 11 items...£5.99", "One package with 6 items...£5.99"). Either
  // way this is real, exact data - split it across the items it actually
  // covers so it lands in the same per-item shipping field manual entry
  // already uses.
  const postageByOrder = extractFpPostageByOrder(text);
  if (postageByOrder.size > 0) {
    const itemsByOrder = new Map();
    for (const item of items) {
      if (!item.order_number || item.status === 'cancelled') continue;
      if (!itemsByOrder.has(item.order_number)) itemsByOrder.set(item.order_number, []);
      itemsByOrder.get(item.order_number).push(item);
    }
    for (const [orderNumber, postage] of postageByOrder) {
      const orderItems = itemsByOrder.get(orderNumber);
      if (!orderItems || orderItems.length === 0) continue;

      if (postage.shipments.length > 1) {
        // Group this order's items by which parcel they actually shipped
        // in (same dispatch link = physically shipped together), in the
        // order each distinct parcel first appears - matching that same
        // order against the sequential per-parcel breakdown above it.
        const groups = [];
        const groupIndexByKey = new Map();
        for (const item of orderItems) {
          const key = item._fpDispatchGroup || '';
          if (!groupIndexByKey.has(key)) {
            groupIndexByKey.set(key, groups.length);
            groups.push([]);
          }
          groups[groupIndexByKey.get(key)].push(item);
        }
        if (groups.length === postage.shipments.length) {
          groups.forEach((groupItems, idx) => {
            const perItem = Math.round((postage.shipments[idx] / groupItems.length) * 100) / 100;
            for (const item of groupItems) item.shipping = perItem;
          });
          continue;
        }
        // Parcel count didn't line up with the breakdown (an edge case
        // the grouping assumption didn't hold for) - fall through to
        // the safe even-split below using the combined total instead.
      }

      const total = postage.shipments.length > 1
        ? postage.shipments.reduce((sum, s) => sum + s, 0)
        : postage.shipments[0];
      const perItem = Math.round((total / orderItems.length) * 100) / 100;
      for (const item of orderItems) item.shipping = perItem;
    }
  }

  for (const item of items) delete item._fpDispatchGroup;

  return items;
}

/** A second, independent pass over the same order-history text, looking
 * only for each order's declared "Total" line - kept completely separate
 * from parseForbiddenPlanetOrders above rather than merged into it, so
 * there's zero risk of this touching the already-tested item extraction.
 * Mirrors the webui's own order-history parser: "Total" standing alone
 * on a line, with the price on the next non-blank line, following
 * whichever "Order#" most recently appeared above it. Used to calibrate
 * a shipping estimate later (declared total minus item prices = an
 * implied shipping figure) for orders with no exact postage captured. */
export function extractFpDeclaredTotals(text) {
  const lines = (text || '').split('\n');
  const n = lines.length;
  let i = 0;
  let currentOrder = null;
  const totals = new Map();

  const orderNumberRe = /^Order\s*#\s*\[?(\d+)\]?/i;
  const subscriptionOrderRe = /^Subscription Order\s*#\s*\[?(\d+)\]?/i;
  const orderLabelOnlyRe = /^(?:Subscription\s+)?Order\s*#\s*$/i;
  const bareNumberRe = /^\[?(\d+)\]?$/;
  // Real pasted data often has no space at all between the label and its
  // value ("Total£55.99"), same quirk already handled for Placed/Order#
  // above - but a plain "Total" alone on its own line (the value on the
  // next line) is also supported as a fallback, matching the webui's own
  // simpler parser for whatever paste formats land that way instead.
  const totalInlineRe = /^Total\s*[£$€]\s*(\d+\.\d{2})/i;
  const totalLabelOnlyRe = /^Total\s*$/i;

  function nextNonBlank(idx) {
    while (idx < n && lines[idx].trim() === '') idx++;
    return idx;
  }

  while (i < n) {
    const line = lines[i].trim();
    if (line === '') { i++; continue; }

    const bulletStripped = stripFpBullet(line);
    const subOrderMatch = bulletStripped.match(subscriptionOrderRe);
    const orderMatch = subOrderMatch || bulletStripped.match(orderNumberRe);
    if (orderMatch) {
      currentOrder = orderMatch[1];
      i++;
      continue;
    }
    if (orderLabelOnlyRe.test(bulletStripped)) {
      const next = nextNonBlank(i + 1);
      const numMatch = next < n && lines[next].trim().match(bareNumberRe);
      if (numMatch) {
        currentOrder = numMatch[1];
        i = next + 1;
        continue;
      }
    }

    const totalInlineMatch = bulletStripped.match(totalInlineRe);
    if (totalInlineMatch && currentOrder) {
      totals.set(currentOrder, parseFloat(totalInlineMatch[1]));
      i++;
      continue;
    }
    if (totalLabelOnlyRe.test(bulletStripped) && currentOrder) {
      const next = nextNonBlank(i + 1);
      if (next < n) {
        const val = parseFpPrice(lines[next].trim());
        if (val !== null) totals.set(currentOrder, val);
      }
      i = next + 1;
      continue;
    }

    i++;
  }

  return totals;
}

const FP_ORDER_DETAIL_HEADING_RE = /Order\s*#\s*\[?(\d+)\]?/gi;
const FP_POSTAGE_RE = /Postage:?\s*£(\d+\.\d{2})/i;
const FP_MULTI_SHIPMENT_RE = /One package with \d+ items?[^\d£\n]*?£?\s*(\d+\.\d{2})/gi;

/** Finds the declared postage for each order-detail block in the pasted
 * text, keyed by order number - either a single-entry list (one flat
 * "Postage:£X.XX" line) or several entries in appearance order (a
 * multi-parcel breakdown). Order-history list pages never have either
 * line at all, so this naturally only ever applies to order-detail
 * pastes. */
function extractFpPostageByOrder(text) {
  const postageByOrder = new Map();
  const headings = [...text.matchAll(FP_ORDER_DETAIL_HEADING_RE)];
  for (let idx = 0; idx < headings.length; idx++) {
    const heading = headings[idx];
    const orderNumber = heading[1];
    const start = heading.index + heading[0].length;
    const end = idx + 1 < headings.length ? headings[idx + 1].index : text.length;
    const block = text.slice(start, end);

    const multiMatches = [...block.matchAll(FP_MULTI_SHIPMENT_RE)];
    if (multiMatches.length > 0) {
      postageByOrder.set(orderNumber, { shipments: multiMatches.map(m => parseFloat(m[1])) });
      continue;
    }
    const postageMatch = block.match(FP_POSTAGE_RE);
    if (postageMatch) postageByOrder.set(orderNumber, { shipments: [parseFloat(postageMatch[1])] });
  }
  return postageByOrder;
}

/** True if pasted text looks like an eBay order/order-history page -
 * used to auto-route Paste Orders to the eBay parser instead of the
 * generic name/price reader. */
export function looksLikeEbay(text) {
  const t = text || '';
  return /Item number:\s*\d+/i.test(t) && /Order number/i.test(t);
}

const EBAY_ORDER_NUM_RE = /Order number\s*\n?\s*([\w-]+)/i;
const EBAY_TOTAL_RE = /Total\s*\n?\s*£(\d+\.\d{2})/i;
const EBAY_SELLER_RE = /Sold by\s*\n?\s*\[?([\w.-]+)/i;
const EBAY_ITEM_PRICE_RE = /£(\d+\.\d{2})\s*Unit price/i;
const EBAY_PLACED_RE = /Time placed\s*\n?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i;
const EBAY_DELIVERED_RE = /Delivered on\s+[A-Za-z]+,?\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i;
const EBAY_PAID_RE = /Paid on\s+\d{1,2}\s+[A-Za-z]+/i;
const EBAY_TRACKING_RE = /Number\s*\n?\s*([A-Z0-9]{8,})/i;
// eBay's own payment breakdown states postage explicitly - "Standard
// tracked delivery £X.XX" or just "Postage £X.XX" - so unlike Forbidden
// Planet's order total, there's no need to subtract anything out (which
// would risk pulling in VAT too); this is already the exact figure.
const EBAY_POSTAGE_RE = /(?:Standard tracked delivery|Postage)\s*\n?\s*£(\d+\.\d{2})/i;
// Markdown links that show up around every eBay item but aren't
// themselves items - "[Buy again](...)" and friends look exactly like
// an item link ("[Name](url)"), so they need excluding by name, the
// same way the Forbidden Planet parser excludes "[Cancel item]".
const EBAY_LINK_SKIP = new Set([
  'buy again', 'view invoice', 'contact seller', 'track package',
  'learn more', 'explore this shop', 'view this shop on ebay', 'tell us what you think',
]);
const EBAY_ITEM_LINE_SKIP = new Set([
  'item details', 'incl.', 'buyer protection', 'more actions', 'other actions',
]);

/** Splits a bulk eBay order-history paste into one chunk per order, each
 * starting at its own "Order info" boundary - a single paste often
 * contains several separate orders back to back (one per seller), not
 * just one. Simple substring search, so it works whether or not a given
 * order happens to be bulleted (the order-history list page bullets
 * each "Order info" header when several orders are shown together; a
 * single order-detail page doesn't). */
function splitEbayOrders(text) {
  const marker = 'Order info';
  const positions = [];
  let idx = text.indexOf(marker);
  while (idx !== -1) {
    positions.push(idx);
    idx = text.indexOf(marker, idx + marker.length);
  }
  if (positions.length <= 1) return [text];
  return positions.map((pos, i) => text.slice(pos, i + 1 < positions.length ? positions[i + 1] : text.length));
}

/** Parses one eBay order chunk into its items. Skips the order entirely
 * if its total isn't in GBP (a different currency needs an exchange
 * rate to make sense of, which this doesn't attempt yet) - matches
 * asking to ignore non-GBP orders for now rather than guess.
 * isOnlyOrderInPaste guards the exact-postage attachment below: when
 * several orders are pasted together, the trailing payment summary is
 * a single combined total for all of them, not per-order, so there's
 * no safe way to attribute it to just one - only a genuinely
 * single-order paste has its own dedicated, unambiguous total. */
function parseEbayOrder(chunk, isOnlyOrderInPaste) {
  const totalMatch = chunk.match(EBAY_TOTAL_RE);
  if (!totalMatch) return [];

  const orderMatch = chunk.match(EBAY_ORDER_NUM_RE);
  const orderNumber = orderMatch ? orderMatch[1] : null;

  const sellerMatch = chunk.match(EBAY_SELLER_RE);
  const shop = sellerMatch ? `eBay - ${sellerMatch[1]}` : 'eBay';

  const deliveredMatch = chunk.match(EBAY_DELIVERED_RE);
  const alreadyDelivered = !!deliveredMatch;
  const alreadyPaid = EBAY_PAID_RE.test(chunk);
  const trackingMatch = chunk.match(EBAY_TRACKING_RE);
  const trackingNumber = trackingMatch ? trackingMatch[1] : null;
  const placedMatch = chunk.match(EBAY_PLACED_RE);
  const placedDate = placedMatch ? parseFpDate(placedMatch[1]) : null;
  // eBay orders aren't pre-orders, so there's no separate "release date"
  // the way Forbidden Planet has one - but the order itself has a real,
  // unambiguous date attached (when it arrived, or failing that when it
  // was placed), so use that rather than leaving every item undated.
  const releaseDate = deliveredMatch ? parseFpDate(deliveredMatch[1]) : placedDate;
  const status = alreadyDelivered ? 'dispatched' : 'preorder';
  const chargeStatus = alreadyPaid ? 'charged' : 'not_charged';

  const startIdx = chunk.indexOf('Item details');
  const afterStart = startIdx !== -1 ? chunk.slice(startIdx) : chunk;
  // "Delivery address" reliably marks the end of the item list in every
  // real sample - cutting the scan off there means the trailing address/
  // payment block never has a chance to be mistaken for an item name.
  const endIdx = afterStart.indexOf('Delivery address');
  const itemSection = endIdx !== -1 ? afterStart.slice(0, endIdx) : afterStart;
  const lines = itemSection.split('\n').map(l => l.trim());

  const items = [];
  let pendingName = null;
  for (const rawLine of lines) {
    const line = stripFpBullet(rawLine);
    if (!line || EBAY_ITEM_LINE_SKIP.has(line.toLowerCase())) continue;

    const priceMatch = line.match(EBAY_ITEM_PRICE_RE);
    if (priceMatch) {
      if (pendingName) {
        items.push({
          name: pendingName,
          price: parseFloat(priceMatch[1]),
          release_date: releaseDate,
          shop,
          order_number: orderNumber,
          placed_date: placedDate,
          status,
          charge_status: chargeStatus,
          tracking_number: trackingNumber,
        });
        pendingName = null;
      }
      continue;
    }

    if (/^Item number/i.test(line) || /^Return window/i.test(line)) continue;

    // Real eBay pastes have no markdown links at all - each item's name
    // just appears as plain text (duplicated once for the thumbnail and
    // once for the title). A markdown-link form can still turn up if the
    // text arrived via some reader/markdown-conversion step first, so
    // both are handled: prefer the link's own text when present, fall
    // back to the bare line otherwise. Either way this only ever matters
    // once a price line actually follows, so junk lines in between
    // (Buy again, More actions, Item number, ...) get silently
    // overwritten and never produce a phantom item.
    const linkMatch = line.match(/^\[([^\[\]]+)\]\([^)]*\)$/);
    const candidate = linkMatch ? linkMatch[1].trim() : line;
    if (!EBAY_LINK_SKIP.has(candidate.toLowerCase())) pendingName = candidate;
  }

  const postageMatch = isOnlyOrderInPaste ? chunk.match(EBAY_POSTAGE_RE) : null;
  if (postageMatch && items.length > 0) {
    const perItem = Math.round((parseFloat(postageMatch[1]) / items.length) * 100) / 100;
    for (const item of items) item.shipping = perItem;
  }

  return items;
}

/** Parses a bulk eBay purchase-history paste (one or several orders) into
 * a flat list of items, one per comic - each item carries its own order's
 * seller, order number, tracking number, and best-available date. */
export function parseEbayOrders(text) {
  const chunks = splitEbayOrders(text);
  return chunks.flatMap(chunk => parseEbayOrder(chunk, chunks.length === 1));
}

// --- Generic order confirmation parser ("Shopify-style") --------------------
//
// For anything that isn't Forbidden Planet or eBay. Built around patterns
// common to small-shop checkouts generally - most run on shared platforms
// (Shopify chief among them), so order confirmations tend to share a
// recognisable shape (Order Number / itemised list / Subtotal / Shipping /
// Total) even though the exact wording varies shop to shop. Deliberately a
// best-effort parser: anything it can't confidently extract is left blank
// rather than guessed at wrong - the review screen is where a person fills
// in whatever's missing.

const GENERIC_CURRENCY_SIGN = '(?:£|\\$|€|GBP\\s?|USD\\s?|EUR\\s?)';
const GENERIC_PRICE_RE = new RegExp(`${GENERIC_CURRENCY_SIGN}\\s?(\\d+\\.\\d{2})`, 'gi');
const GENERIC_EXCLUDE_KEYWORDS = ['subtotal', 'total', 'postage', 'p&p', 'shipping'];
const GENERIC_START_ANCHORS = [/Line Items/i, /Items Ordered/i, /Item Description[\s\S]*?Price/i, /Order Details/i];
const GENERIC_ORDER_NUM_RE = /(?:Order\s*(?:Number|Ref|#)|Order\s*ID)\s*:?\s*#?\s*([A-Za-z0-9-]+)/i;
const GENERIC_TOTAL_RE = new RegExp(`\\b(?:Grand\\s*Total|Total)\\b\\s*:?\\s*${GENERIC_CURRENCY_SIGN}\\s?(\\d+\\.\\d{2})`, 'i');
const GENERIC_SHIPPING_RE = new RegExp(`(?:Postage\\s*&?\\s*Packaging|P\\s*&\\s*P|Shipping|Postage)\\s*:?\\s*${GENERIC_CURRENCY_SIGN}\\s?(\\d+\\.\\d{2})`, 'i');
const GENERIC_EXACT_DATE_RE = /(?:Expected Release|Release Date|Ships?)\s*:?\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/i;
const GENERIC_INFORMAL_NOTE_RE = /\((expected[^)]*|ships?[^)]*|pre-?order[^)]*|in stock[^)]*)\)/i;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prefers the LATEST recognised header that still comes before the first
 * price - avoids stopping at an earlier, less specific anchor and dragging
 * in header-row text as part of the first item's name. */
function genericFindStart(text, firstPricePos) {
  let best = null;
  for (const pat of GENERIC_START_ANCHORS) {
    const m = text.match(pat);
    if (m && m.index + m[0].length <= firstPricePos) {
      const end = m.index + m[0].length;
      if (best === null || end > best) best = end;
    }
  }
  return best !== null ? best : 0;
}

function genericCleanName(s) {
  s = s.replace(/^[\s,;:-]+(and\s+)?/i, '');
  s = s.replace(/[\s,;:-]+$/, '');
  s = s.replace(/\s+\d+\s+(In Stock|Pre-?order)\s*$/i, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

/** Returns {order_number, declared_total, shipping, items: [{name, price,
 * release_date, note}]}. Pure parsing, doesn't touch the database. */
export function parseGenericOrder(text) {
  text = text || '';
  const orderMatch = text.match(GENERIC_ORDER_NUM_RE);
  const orderNumber = orderMatch ? orderMatch[1] : null;

  const totalMatch = text.match(GENERIC_TOTAL_RE);
  const declaredTotal = totalMatch ? parseFloat(totalMatch[1]) : null;

  const shippingMatch = text.match(GENERIC_SHIPPING_RE);
  const shipping = shippingMatch ? parseFloat(shippingMatch[1]) : null;

  const priceMatches = [...text.matchAll(GENERIC_PRICE_RE)];
  const items = [];
  if (priceMatches.length > 0) {
    const start = genericFindStart(text, priceMatches[0].index);
    let cursor = start;
    for (const m of priceMatches) {
      const contextBefore = text.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
      if (GENERIC_EXCLUDE_KEYWORDS.some(kw => contextBefore.includes(kw))) {
        cursor = m.index + m[0].length;
        continue;
      }

      const prefix = text.slice(cursor, m.index);
      let releaseDate = null;
      let note = null;
      let nameSource = prefix;

      const dm = prefix.match(GENERIC_EXACT_DATE_RE);
      const informalMatch = prefix.match(GENERIC_INFORMAL_NOTE_RE);
      if (dm) {
        const parenRe = new RegExp(`\\([^)]*${escapeRegExp(dm[0])}[^)]*\\)`, 'i');
        const paren = prefix.match(parenRe);
        if (paren) nameSource = prefix.slice(0, paren.index) + prefix.slice(paren.index + paren[0].length);
        releaseDate = parseFpDate(`${dm[1]} ${dm[2]} ${dm[3]}`);
      } else if (informalMatch) {
        nameSource = prefix.slice(0, informalMatch.index) + prefix.slice(informalMatch.index + informalMatch[0].length);
        note = informalMatch[1].trim();
      } else {
        // Only look past the price if there's a clear comma to stop at -
        // without one, there's no safe boundary and we'd risk stealing
        // the NEXT item's own note instead.
        const priceEnd = m.index + m[0].length;
        const commaPos = text.indexOf(',', priceEnd);
        if (commaPos !== -1 && commaPos - priceEnd < 80) {
          const suffix = text.slice(priceEnd, commaPos);
          const dm2 = suffix.match(GENERIC_EXACT_DATE_RE);
          const im2 = suffix.match(GENERIC_INFORMAL_NOTE_RE);
          if (dm2) {
            releaseDate = parseFpDate(`${dm2[1]} ${dm2[2]} ${dm2[3]}`);
          } else if (im2) {
            note = im2[1].trim();
          }
        }
      }

      const name = genericCleanName(nameSource);
      cursor = m.index + m[0].length;
      if (name) {
        items.push({ name, price: parseFloat(m[1]), release_date: releaseDate, note });
      }
    }
  }

  return { order_number: orderNumber, declared_total: declaredTotal, shipping, items };
}

export function parsePastedText(text) {
  const priceRe = /[£$€]\s*([\d,]+\.\d{2})/;
  const dateIsoRe = /(\d{4})-(\d{2})-(\d{2})/;
  const dateSlashRe = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    const priceMatch = line.match(priceRe);
    if (!priceMatch) continue;

    const price = parseFloat(priceMatch[1].replace(',', ''));
    let namePart = line.slice(0, priceMatch.index);

    let release_date = null;
    const isoMatch = namePart.match(dateIsoRe);
    const slashMatch = namePart.match(dateSlashRe);
    if (isoMatch) {
      release_date = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
      namePart = namePart.slice(0, isoMatch.index) + namePart.slice(isoMatch.index + isoMatch[0].length);
    } else if (slashMatch) {
      release_date = `${slashMatch[3]}-${slashMatch[2].padStart(2, '0')}-${slashMatch[1].padStart(2, '0')}`;
      namePart = namePart.slice(0, slashMatch.index) + namePart.slice(slashMatch.index + slashMatch[0].length);
    }

    const name = namePart.trim().replace(/[\s\-:|]+$/, '').trim();
    if (!name) continue;

    results.push({ name, price, release_date });
  }

  return results;
}

/** Splits items into pre-order vs released/dispatched, matching the main
 * web app's own Insights card - "cancelled" items count toward neither. */
export function computePreorderVsReleased(items) {
  const active = items.filter(i => i.status !== 'cancelled');
  const preorder = active.filter(i => i.status === 'preorder').length;
  // "Released" is deliberately everything else non-cancelled, not just
  // items whose status is exactly 'dispatched' - matches the webui's own
  // released_pct = 100 - preorder_pct. Any item with a status that's
  // neither 'cancelled' nor 'preorder' (dispatched, or any other value
  // that comes up) still needs to count as released, or it silently
  // vanishes from the ring's total while still counting everywhere else
  // on the page - exactly the bug this replaces.
  const released = active.length - preorder;
  return { preorder, released };
}

/** Total value of everything cancelled - what was "saved" by dropping
 * it, same idea as the main web app's own card. */
export function computeCancelledSavings(items) {
  return computeStillDueTotal(items.filter(i => i.status === 'cancelled'));
}

/** The single month (YYYY-MM) with the highest total spend, based on
 * release date - null if there's nothing dated at all. */
export function findMostExpensiveMonth(items) {
  const totals = new Map();
  const counts = new Map();
  for (const item of items) {
    if (!item.release_date || item.status === 'cancelled') continue;
    const month = item.release_date.slice(0, 7);
    totals.set(month, (totals.get(month) || 0) + item.price + (parseFloat(item.shipping) || 0));
    counts.set(month, (counts.get(month) || 0) + 1);
  }
  if (totals.size === 0) return null;
  const [month, total] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
  return { month, total: Math.round(total * 100) / 100, count: counts.get(month) };
}

/** Which day of the week has had the most items released on it overall,
 * across every dated item - same idea as the main web app's card. */
export function findBusiestWeekday(items) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const counts = new Map();
  for (const item of items) {
    if (!item.release_date || item.status === 'cancelled') continue;
    const d = new Date(`${item.release_date}T00:00:00Z`);
    const dayName = dayNames[d.getUTCDay()];
    counts.set(dayName, (counts.get(dayName) || 0) + 1);
  }
  if (counts.size === 0) return null;
  const [day, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { day, count };
}

/** Total real shipping cost captured across every item that has one -
 * items with no shipping figure entered are simply not counted, rather
 * than treated as zero (a genuine £0 shipping and "never entered" are
 * different things, and conflating them would understate the real
 * average once some items do have a figure). */
export function computeShippingStats(items) {
  const withShipping = items.filter(i => i.shipping !== null && i.shipping !== undefined && i.shipping !== '');
  if (withShipping.length === 0) return { total: 0, average: 0, count: 0, biggest: null, cheapest: null, biggestShop: null };
  const total = withShipping.reduce((sum, i) => sum + parseFloat(i.shipping), 0);
  const sorted = [...withShipping].sort((a, b) => parseFloat(b.shipping) - parseFloat(a.shipping));
  return {
    total: Math.round(total * 100) / 100,
    average: Math.round((total / withShipping.length) * 100) / 100,
    count: withShipping.length,
    biggest: parseFloat(sorted[0].shipping),
    cheapest: parseFloat(sorted[sorted.length - 1].shipping),
    biggestShop: sorted[0].shop || null,
  };
}

/** Shipping as a percentage of comic spend - matches the web app's own
 * "shipping vs cover price" card. Returns 0 if there's nothing to
 * compare against, rather than dividing by zero. */
export function computeShippingRatioPct(items) {
  const comicTotal = computeStillDueTotal(items);
  if (comicTotal === 0) return 0;
  const shippingTotal = items.reduce((sum, i) => sum + (parseFloat(i.shipping) || 0), 0);
  return Math.round((shippingTotal / comicTotal) * 1000) / 10;
}

/** Pre-order percentage - what share of active (non-cancelled) items are
 * still pre-order rather than already dispatched, matching the web
 * app's own card. */
export function computePreorderPct(items) {
  const { preorder, released } = computePreorderVsReleased(items);
  const activeTotal = preorder + released;
  if (activeTotal === 0) return 0;
  return Math.round((preorder / activeTotal) * 1000) / 10;
}

/** The next N upcoming (not-yet-past) releases, soonest first - a
 * genuinely different kind of information than a spend figure, capped
 * at a small number so it doesn't turn into a duplicate of the
 * Dashboard's own "This Week" list. daysUntilLabel is precomputed here
 * ("Today"/"Tomorrow"/"N days") since that's a presentation detail the
 * caller shouldn't need to redo. */
export function findUpcomingReleases(items, referenceDate, limit = 2) {
  const todayIso = isoDate(referenceDate);
  const upcoming = items
    .filter(i => i.status !== 'cancelled' && i.release_date && i.release_date >= todayIso)
    .sort((a, b) => a.release_date.localeCompare(b.release_date))
    .slice(0, limit);
  return upcoming.map(item => {
    const days = Math.round((new Date(`${item.release_date}T00:00:00Z`) - new Date(`${todayIso}T00:00:00Z`)) / 86400000);
    const daysUntilLabel = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days`;
    return { ...item, daysUntilLabel };
  });
}

/** How the average issue compares to the priciest one tracked, as a
 * percentage (0 if there's nothing to compare against). */
export function computeAvgVsPriciestIssuePct(items) {
  const priciest = findPriciestItem(items);
  if (!priciest || priciest.price <= 0) return 0;
  const avg = computeAveragePrice(items);
  return Math.round((avg / priciest.price) * 1000) / 10;
}

/** All-time comics vs shipping split - reuses the same totals concept as
 * computeShippingStats/computeShippingRatioPct, just shaped for a split
 * bar instead of a ratio. */
export function computeAllTimeComicsVsShippingSplit(items) {
  const active = items.filter(i => i.status !== 'cancelled');
  const comicsTotal = Math.round(computeStillDueTotal(active) * 100) / 100;
  const shippingTotal = Math.round(active.reduce((sum, i) => sum + (parseFloat(i.shipping) || 0), 0) * 100) / 100;
  const grandTotal = comicsTotal + shippingTotal;
  const comicsPct = grandTotal ? Math.round((comicsTotal / grandTotal) * 1000) / 10 : 0;
  return { comicsTotal, shippingTotal, comicsPct, shippingPct: Math.round((100 - comicsPct) * 10) / 10 };
}

/** Full Mon-Sun release-count breakdown, each day normalised against
 * whichever day is busiest - same underlying counts as
 * findBusiestWeekday, just reshaped into a chart instead of picking
 * only the single busiest one. */
export function computeWeekdayReleaseChart(items) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const counts = new Map();
  for (const item of items) {
    if (!item.release_date || item.status === 'cancelled') continue;
    const d = new Date(`${item.release_date}T00:00:00Z`);
    const dayName = dayNames[d.getUTCDay()];
    counts.set(dayName, (counts.get(dayName) || 0) + 1);
  }
  const maxCount = counts.size ? Math.max(...counts.values()) : 0;
  const busiest = maxCount ? [...counts.entries()].find(([, c]) => c === maxCount)[0] : null;
  return order.map(day => {
    const count = counts.get(day) || 0;
    return {
      label: day.slice(0, 3),
      count,
      barPct: maxCount ? Math.round((count / maxCount) * 100) : 0,
      isBusiest: day === busiest,
    };
  });
}

/** Groups items into a "series" by stripping the issue number and
 * anything after it (variant info usually follows the issue number),
 * then flags any series where the price has genuinely risen between
 * the earliest and most recent tracked issue. A one-shot with no "#N"
 * in its name just won't match anything else, which is correct - no
 * series to track creep across. */
export function computePriceCreep(items, limit = 3) {
  const seriesGroups = new Map();
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    const m = item.name.match(/^(.*?)\s*#\d+/);
    if (!m) continue;
    const seriesKey = m[1].trim();
    const sortKey = item.release_date || item.placed_date || '';
    if (!seriesGroups.has(seriesKey)) seriesGroups.set(seriesKey, []);
    seriesGroups.get(seriesKey).push({ sortKey, price: item.price });
  }
  const results = [];
  for (const [series, entries] of seriesGroups) {
    entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    const firstPrice = entries[0].price;
    const latestPrice = entries[entries.length - 1].price;
    if (latestPrice > firstPrice + 0.01) {
      results.push({
        series,
        firstPrice,
        latestPrice,
        increasePct: firstPrice ? Math.round(((latestPrice - firstPrice) / firstPrice) * 100) : 0,
        issueCount: entries.length,
      });
    }
  }
  results.sort((a, b) => (b.latestPrice - b.firstPrice) - (a.latestPrice - a.firstPrice));
  return results.slice(0, limit);
}

/** Reconstructs real order-level shipping totals from items that already
 * carry a per-item share, however that share was computed (a plain even
 * split, or an already-matched multi-parcel split) - summing always adds
 * back up to the true total regardless of how it was divided. Used at
 * insert time to keep order_shipping as the real source of truth,
 * without needing to touch the parsing logic above that computes the
 * per-item shares in the first place. */
export function computeOrderShippingTotals(items) {
  const totals = new Map();
  for (const item of items) {
    if (!item.order_number || !item.shipping) continue;
    totals.set(item.order_number, Math.round(((totals.get(item.order_number) || 0) + item.shipping) * 100) / 100);
  }
  return totals;
}

/** Replicates the webui's full shipping-estimate tier order: real
 * captured data first, then (Forbidden Planet only) an estimate
 * calibrated from declared order totals, then a plain default - so the
 * app's totals don't just silently show £0 shipping for orders where
 * nothing was ever captured, which is what made the app's totals
 * diverge from the webui's even after real shipping started syncing
 * correctly. calibratedSamples should already be filtered to Forbidden
 * Planet only (or passed as [] for any other shop) by the caller. */
export function computeShippingEstimate(exactSamples, calibratedSamples = [], defaultRate = 4.00) {
  if (exactSamples.length >= 3) {
    const avg = exactSamples.reduce((sum, v) => sum + v, 0) / exactSamples.length;
    return { rate: Math.round(avg * 100) / 100, tier: 'exact', samples: exactSamples.length };
  }
  if (calibratedSamples.length >= 3) {
    const avg = calibratedSamples.reduce((sum, v) => sum + v, 0) / calibratedSamples.length;
    return { rate: Math.round(avg * 100) / 100, tier: 'calibrated', samples: calibratedSamples.length };
  }
  return { rate: defaultRate, tier: 'default', samples: exactSamples.length };
}

/** Tier 2 of the webui's shipping estimate: for Forbidden Planet orders
 * with a declared order-history total but no exact postage capture,
 * backs out an implied shipping figure (declared total minus what the
 * items themselves cost), split across however many distinct release
 * dates that order covers (its likely parcel count). Filtered to
 * plausible values only, same bounds as the webui, so one obviously
 * wrong declared total doesn't skew the average. */
export function computeCalibratedShippingSamples(orders, items) {
  const itemsByOrder = new Map();
  for (const item of items) {
    if (!item.order_number || item.shop !== 'Forbidden Planet') continue;
    if (!itemsByOrder.has(item.order_number)) itemsByOrder.set(item.order_number, []);
    itemsByOrder.get(item.order_number).push(item);
  }

  const samples = [];
  for (const order of orders) {
    const orderItems = itemsByOrder.get(order.order_number);
    if (!orderItems || order.declared_total == null) continue;
    const itemsSum = orderItems.reduce((sum, i) => sum + i.price, 0);
    const distinctDates = new Set(orderItems.map(i => i.release_date).filter(Boolean)).size || 1;
    const impliedTotal = Math.round((order.declared_total - itemsSum) * 100) / 100;
    if (impliedTotal <= 0) continue;
    const perParcel = Math.round((impliedTotal / distinctDates) * 100) / 100;
    if (perParcel > 0 && perParcel <= 15.00) samples.push(perParcel);
  }
  return samples;
}

/** How many distinct calendar months (all-time, not just a recent
 * window) have at least one dated item - matches the webui's own
 * months_with_data exactly, which groups every dated item ever tracked
 * by its release month and counts how many distinct months come out of
 * that. Deliberately not the same as counting populated months within
 * the last 12 - a collection with gaps or a long history can have a
 * very different all-time count than a rolling recent window would
 * suggest, and using the wrong one skews "avg per month" since it's a
 * divisor, not just an additive figure. */
export function countAllTimeMonthsWithData(items) {
  const months = new Set();
  for (const item of items) {
    if (item.status === 'cancelled' || !item.release_date) continue;
    months.add(item.release_date.slice(0, 7));
  }
  return Math.max(1, months.size);
}

export const SORT_OPTIONS = {
  date_desc: { label: 'Release date (newest)', compare: (a, b) => (b.release_date || '').localeCompare(a.release_date || '') },
  date_asc: { label: 'Release date (oldest)', compare: (a, b) => (a.release_date || '9999').localeCompare(b.release_date || '9999') },
  price_desc: { label: 'Price (highest)', compare: (a, b) => b.price - a.price },
  price_asc: { label: 'Price (lowest)', compare: (a, b) => a.price - b.price },
  name_asc: { label: 'Name (A-Z)', compare: (a, b) => a.name.localeCompare(b.name) },
  added_desc: { label: 'Recently added', compare: (a, b) => (b.created_at || '').localeCompare(a.created_at || '') },
};

/** Matches the web app's Search status filter, which is about charge/
 * cancellation state (All/Paid/Unpaid/Cancelled) - a different axis than
 * item.status's preorder/dispatched values. */
export function matchesStatusFilter(item, statusFilter) {
  if (!statusFilter || statusFilter === 'all') return true;
  if (statusFilter === 'cancelled') return item.status === 'cancelled';
  if (statusFilter === 'paid') return item.status !== 'cancelled' && item.charge_status === 'charged';
  if (statusFilter === 'unpaid') return item.status !== 'cancelled' && item.charge_status !== 'charged';
  return true;
}

/** Sorts a list of items by any of the named SORT_OPTIONS - falls back to
 * date_desc for an unrecognised key rather than throwing. */
export function sortItemsBy(items, sortKey) {
  const option = SORT_OPTIONS[sortKey] || SORT_OPTIONS.date_desc;
  return [...items].sort(option.compare);
}
