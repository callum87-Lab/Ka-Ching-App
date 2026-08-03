import { validateItemInput, formatCurrency, computeStillDueTotal, sortItemsByReleaseDate, groupItemsByReleaseDate, filterItems, computeAveragePrice, findPriciestItem, topExpensiveItems, groupSpendByShop, buildCalendarGrid, computeMonthSpend, computeBudgetProgress, parsePastedText, computePreorderVsReleased, computeCancelledSavings, findMostExpensiveMonth, findBusiestWeekday, computeShippingStats, sortItemsBy, computeCycleBounds, computeCycleSpend, buildCsvExport, buildJsonBackup, parseJsonBackup, findTomorrowReleases, buildTomorrowNotification, filterByShop, computeYearStats, buildMonthlySpendTrend, buildIcsExport, computeSearchTotals, computeShippingRatioPct, computePreorderPct, computeEffectiveBudget, findNextWeekReleases, buildWeeklyNotification, findAwaitingCharge, buildMonthlySpendTrendRange, buildWeeklySpendTrend, groupSpendByShopWithSellers, assignShopColor, matchesStatusFilter, shopGroupName, looksLikeForbiddenPlanet, parseForbiddenPlanetOrders, hasActiveSearchFilter, itemsInMonth, formatShipmentDateLabel, formatSearchDateLabel, groupItemsByDateAndShop, findDuplicateGroups, findGhostItems, findRecentlyCancelled, looksLikeEbay, parseEbayOrders, parseGenericOrder, findUpcomingReleases, computeAvgVsPriciestIssuePct, computeAllTimeComicsVsShippingSplit, computeWeekdayReleaseChart, computePriceCreep, computeOrderShippingTotals, computeShippingEstimate, extractFpDeclaredTotals, computeCalibratedShippingSamples, computeStillDueTotalWithShipping, computeSpentRemainingWithShipping, countAllTimeMonthsWithData, computeMonthSpendWithFallback } from '../src/logic.js';
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

console.log('validateItemInput');
test('accepts a fully valid item', () => {
  const r = validateItemInput({ name: 'Amazing Spider-Man #5', price: '4.99', release_date: '2026-08-01', shop: 'Forbidden Planet' });
  assert.equal(r.valid, true);
  assert.deepEqual(r.cleaned, { name: 'Amazing Spider-Man #5', price: 4.99, release_date: '2026-08-01', shop: 'Forbidden Planet' });
});

test('rejects an empty name', () => {
  const r = validateItemInput({ name: '', price: '4.99' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('Name')));
});

test('rejects a name that is only whitespace', () => {
  const r = validateItemInput({ name: '   ', price: '4.99' });
  assert.equal(r.valid, false);
});

test('rejects a missing price', () => {
  const r = validateItemInput({ name: 'Test Comic', price: '' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('Price')));
});

test('rejects a non-numeric price', () => {
  const r = validateItemInput({ name: 'Test Comic', price: 'abc' });
  assert.equal(r.valid, false);
});

test('rejects a negative price', () => {
  const r = validateItemInput({ name: 'Test Comic', price: '-5.00' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('negative')));
});

test('accepts a zero price (e.g. a giveaway)', () => {
  const r = validateItemInput({ name: 'Free Comic Day Special', price: '0' });
  assert.equal(r.valid, true);
  assert.equal(r.cleaned.price, 0);
});

test('accepts no release date at all - optional, not guessed', () => {
  const r = validateItemInput({ name: 'Test Comic', price: '3.50' });
  assert.equal(r.valid, true);
  assert.equal(r.cleaned.release_date, null);
});

test('rejects a malformed release date', () => {
  const r = validateItemInput({ name: 'Test Comic', price: '3.50', release_date: '01/08/2026' });
  assert.equal(r.valid, false);
});

test('accepts no shop - optional', () => {
  const r = validateItemInput({ name: 'Test Comic', price: '3.50' });
  assert.equal(r.valid, true);
  assert.equal(r.cleaned.shop, null);
});

test('trims whitespace from name and shop', () => {
  const r = validateItemInput({ name: '  Test Comic  ', price: '3.50', shop: '  eBay  ' });
  assert.equal(r.cleaned.name, 'Test Comic');
  assert.equal(r.cleaned.shop, 'eBay');
});

test('rounds price to 2 decimal places, avoiding float drift', () => {
  const r = validateItemInput({ name: 'Test Comic', price: '3.1' });
  assert.equal(r.cleaned.price, 3.1);
});

console.log('formatCurrency');
test('formats a whole number with two decimal places', () => {
  assert.equal(formatCurrency(5), '£5.00');
});
test('formats an amount that already has two decimals', () => {
  assert.equal(formatCurrency(4.99), '£4.99');
});
test('formats zero correctly', () => {
  assert.equal(formatCurrency(0), '£0.00');
});
test('rounds a longer float correctly rather than truncating', () => {
  assert.equal(formatCurrency(3.145), '£3.15');
});
test('accepts a different currency symbol', () => {
  assert.equal(formatCurrency(4.99, '$'), '$4.99');
  assert.equal(formatCurrency(4.99, '€'), '€4.99');
});

console.log('computeStillDueTotal');
test('sums an empty list to zero', () => {
  assert.equal(computeStillDueTotal([]), 0);
});
test('sums multiple items correctly', () => {
  assert.equal(computeStillDueTotal([{ price: 4.99 }, { price: 3.5 }, { price: 12.00 }]), 20.49);
});

console.log('computeStillDueTotalWithShipping');
test('adds shipping on top of comics, unlike the comics-only computeStillDueTotal', () => {
  const items = [{ price: 5, shipping: 2 }, { price: 3, shipping: 1.5 }];
  assert.equal(computeStillDueTotalWithShipping(items), 11.5);
});
test('treats a missing shipping figure as 0', () => {
  assert.equal(computeStillDueTotalWithShipping([{ price: 5 }]), 5);
});
test('excludes cancelled items - the real bug this used to have: three separate callers (month forecast, cycle/budget spend) forgot to filter cancelled status themselves before calling this, so a cancelled item quietly still counted toward "current/forecast spend" figures the webui always excludes it from', () => {
  const items = [{ price: 5, shipping: 2, status: 'preorder' }, { price: 99, shipping: 99, status: 'cancelled' }];
  assert.equal(computeStillDueTotalWithShipping(items), 7);
});

console.log('computeSpentRemainingWithShipping');
test('includes shipping in both spent and remaining, and excludes cancelled items', () => {
  const items = [
    { price: 5, shipping: 1, charge_status: 'charged', status: 'preorder' },
    { price: 3, shipping: 2, charge_status: 'not_charged', status: 'preorder' },
    { price: 99, shipping: 99, charge_status: 'not_charged', status: 'cancelled' },
  ];
  const result = computeSpentRemainingWithShipping(items);
  assert.equal(result.spent, 6);
  assert.equal(result.remaining, 5);
});

console.log('countAllTimeMonthsWithData');
test('counts distinct months across ALL time, not just a recent window - the real bug this replaces: a rolling 12-month window undercounted or overcounted the true all-time figure the webui actually uses as the "avg per month" divisor', () => {
  const items = [
    { release_date: '2023-01-15', status: 'preorder' }, // years ago - must still count
    { release_date: '2023-06-15', status: 'preorder' },
    { release_date: '2026-08-01', status: 'preorder' }, // recent
  ];
  assert.equal(countAllTimeMonthsWithData(items), 3);
});
test('excludes cancelled items and items with no release date', () => {
  const items = [
    { release_date: '2026-08-01', status: 'preorder' },
    { release_date: '2026-08-15', status: 'preorder' }, // same month, shouldn't add a second count
    { release_date: '2026-09-01', status: 'cancelled' }, // excluded
    { release_date: null, status: 'preorder' }, // excluded
  ];
  assert.equal(countAllTimeMonthsWithData(items), 1);
});
test('returns 1 rather than 0 with no dated items at all, avoiding a divide-by-zero', () => {
  assert.equal(countAllTimeMonthsWithData([]), 1);
});

console.log('sortItemsByReleaseDate');
test('sorts dated items soonest first', () => {
  const items = [
    { name: 'B', release_date: '2026-09-01' },
    { name: 'A', release_date: '2026-08-01' },
  ];
  const sorted = sortItemsByReleaseDate(items);
  assert.equal(sorted[0].name, 'A');
  assert.equal(sorted[1].name, 'B');
});
test('puts items with no date at the end, not the start', () => {
  const items = [
    { name: 'No date', release_date: null },
    { name: 'Has date', release_date: '2026-08-01' },
  ];
  const sorted = sortItemsByReleaseDate(items);
  assert.equal(sorted[0].name, 'Has date');
  assert.equal(sorted[1].name, 'No date');
});
test('does not mutate the original array', () => {
  const items = [{ name: 'B', release_date: '2026-09-01' }, { name: 'A', release_date: '2026-08-01' }];
  const original = [...items];
  sortItemsByReleaseDate(items);
  assert.deepEqual(items, original);
});

console.log('groupItemsByReleaseDate');
test('groups items sharing the same date together', () => {
  const items = [
    { name: 'A', price: 3, release_date: '2026-08-01' },
    { name: 'B', price: 4, release_date: '2026-08-01' },
  ];
  const groups = groupItemsByReleaseDate(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].date, '2026-08-01');
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[0].total, 7);
});
test('orders groups chronologically, soonest first', () => {
  const items = [
    { name: 'B', price: 1, release_date: '2026-09-01' },
    { name: 'A', price: 1, release_date: '2026-08-01' },
  ];
  const groups = groupItemsByReleaseDate(items);
  assert.equal(groups[0].date, '2026-08-01');
  assert.equal(groups[1].date, '2026-09-01');
});
test('puts undated items in their own group, last', () => {
  const items = [
    { name: 'No date', price: 1, release_date: null },
    { name: 'Dated', price: 1, release_date: '2026-08-01' },
  ];
  const groups = groupItemsByReleaseDate(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].date, '2026-08-01');
  assert.equal(groups[1].date, null);
  assert.equal(groups[1].items[0].name, 'No date');
});
test('handles an empty list without error', () => {
  assert.deepEqual(groupItemsByReleaseDate([]), []);
});

console.log('filterItems');
const sampleItems = [
  { name: 'Amazing Spider-Man #5', price: 4.99, shop: 'Forbidden Planet' },
  { name: 'Batman #12', price: 3.5, shop: 'eBay' },
  { name: 'Amazing X-Men #1', price: 12.00, shop: 'Forbidden Planet' },
];
test('returns everything when no filter is set', () => {
  assert.equal(filterItems(sampleItems, {}).length, 3);
});
test('matches by name, case-insensitively', () => {
  const result = filterItems(sampleItems, { query: 'amazing' });
  assert.equal(result.length, 2);
});
test('matches by shop name too, not just item name', () => {
  const result = filterItems(sampleItems, { query: 'ebay' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Batman #12');
});
test('matches by order number too, not just name or shop', () => {
  const items = [
    { name: 'Comic A', price: 3.30, shop: 'Forbidden Planet', order_number: '54621806' },
    { name: 'Comic B', price: 3.30, shop: 'Forbidden Planet', order_number: '54626030' },
  ];
  const result = filterItems(items, { query: '54621806' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Comic A');
});
test('applies a minimum price filter', () => {
  const result = filterItems(sampleItems, { minPrice: '5' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Amazing X-Men #1');
});
test('applies a maximum price filter', () => {
  const result = filterItems(sampleItems, { maxPrice: '4' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Batman #12');
});
test('combines a text query with a price range', () => {
  const result = filterItems(sampleItems, { query: 'amazing', maxPrice: '10' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Amazing Spider-Man #5');
});
test('filters by a date range', () => {
  const dated = [
    { name: 'A', price: 1, shop: null, release_date: '2026-08-01' },
    { name: 'B', price: 1, shop: null, release_date: '2026-09-01' },
  ];
  const result = filterItems(dated, { startDate: '2026-08-15', endDate: '2026-09-15' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'B');
});
test('filters by shop when a specific one is given', () => {
  const result = filterItems(sampleItems, { shop: 'eBay' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Batman #12');
});
test('a date range still includes undated items by default', () => {
  const mixed = [
    { name: 'Dated', price: 1, shop: null, release_date: '2026-08-01' },
    { name: 'Undated (dispatched)', price: 1, shop: null, release_date: null },
  ];
  const result = filterItems(mixed, { startDate: '2026-08-15', endDate: '2026-09-15' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Undated (dispatched)');
});
test('a date range drops undated items when includeUndated is false', () => {
  const mixed = [
    { name: 'Dated', price: 1, shop: null, release_date: '2026-08-01' },
    { name: 'Undated (dispatched)', price: 1, shop: null, release_date: null },
  ];
  const result = filterItems(mixed, { startDate: '2026-08-15', endDate: '2026-09-15', includeUndated: false });
  assert.equal(result.length, 0);
});

console.log('hasActiveSearchFilter');
test('nothing entered at all is not an active filter', () => {
  assert.equal(hasActiveSearchFilter({}), false);
  assert.equal(hasActiveSearchFilter({ query: '', status: 'all' }), false);
});
test('a text query counts as an active filter', () => {
  assert.equal(hasActiveSearchFilter({ query: 'kylo' }), true);
});
test('a shop, non-"all" status, date, or price bound each count as active', () => {
  assert.equal(hasActiveSearchFilter({ shop: 'eBay' }), true);
  assert.equal(hasActiveSearchFilter({ status: 'paid' }), true);
  assert.equal(hasActiveSearchFilter({ startDate: '2026-08-01' }), true);
  assert.equal(hasActiveSearchFilter({ endDate: '2026-08-01' }), true);
  assert.equal(hasActiveSearchFilter({ minPrice: '5' }), true);
  assert.equal(hasActiveSearchFilter({ maxPrice: '5' }), true);
});

console.log('itemsInMonth');
test('keeps only dated, non-cancelled items within the given month', () => {
  const items = [
    { name: 'In month', price: 1, release_date: '2026-07-15', status: 'preorder' },
    { name: 'Other month', price: 1, release_date: '2026-08-01', status: 'preorder' },
    { name: 'No date', price: 1, release_date: null, status: 'preorder' },
    { name: 'Cancelled', price: 1, release_date: '2026-07-20', status: 'cancelled' },
  ];
  const result = itemsInMonth(items, 2026, 6); // month is 0-indexed, so 6 = July
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'In month');
});
test('a dispatched item with no release date at all still counts toward the month it was placed in', () => {
  const items = [
    { name: 'Jyn Erso', price: 3.30, release_date: null, placed_date: '2026-07-02', status: 'dispatched', charge_status: 'charged' },
  ];
  const result = itemsInMonth(items, 2026, 6);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Jyn Erso');
});
test('a real preorder release date is never overridden by an older placed_date - a comic ordered 3 months ahead still counts toward its actual release month, not when it was placed', () => {
  const items = [
    { name: 'Future preorder', price: 3.30, release_date: '2026-10-28', placed_date: '2026-07-02', status: 'preorder' },
  ];
  assert.equal(itemsInMonth(items, 2026, 6).length, 0); // not July, since it has a real release date
  assert.equal(itemsInMonth(items, 2026, 9).length, 1); // correctly counts toward October
});

console.log('formatShipmentDateLabel');
test('formats an ISO date as "Wed 08 Jul" style', () => {
  assert.equal(formatShipmentDateLabel('2026-07-08'), 'Wed 08 Jul');
});

console.log('formatSearchDateLabel');
test('formats an ISO date as "19 Aug 2026" style - no weekday, includes year', () => {
  assert.equal(formatSearchDateLabel('2026-08-19'), '19 Aug 2026');
});
test('falls back to "no date set" for a null date', () => {
  assert.equal(formatSearchDateLabel(null), 'no date set');
});

console.log('groupItemsByDateAndShop');
test('groups by date, then by exact shop string, keeping separate eBay sellers apart', () => {
  const items = [
    { name: 'A', price: 3.95, shop: 'eBay - sad_lemon_comics', release_date: '2026-05-20', status: 'preorder', charge_status: 'charged' },
    { name: 'B', price: 8.54, shop: 'eBay - bearsgames', release_date: '2026-05-20', status: 'preorder', charge_status: 'charged' },
    { name: 'C', price: 4.99, shop: 'Forbidden Planet', release_date: '2026-05-18', status: 'preorder', charge_status: 'charged' },
    { name: 'Cancelled', price: 99, shop: 'Forbidden Planet', release_date: '2026-05-18', status: 'cancelled', charge_status: 'not_charged' },
  ];
  const groups = groupItemsByDateAndShop(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].date, '2026-05-18');
  assert.equal(groups[0].shopGroups.length, 1);
  assert.equal(groups[0].subtotal, 4.99);
  assert.equal(groups[1].date, '2026-05-20');
  assert.equal(groups[1].shopGroups.length, 2);
  assert.equal(groups[1].allPaid, true);
});
test('a dispatched item with no release date at all still shows up, dated by its placed_date - consistent with itemsInMonth already counting it that way', () => {
  const items = [
    { name: 'Dispatched no date', price: 3.30, shop: 'Forbidden Planet', release_date: null, placed_date: '2026-07-02', status: 'dispatched', charge_status: 'charged' },
  ];
  const groups = groupItemsByDateAndShop(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].date, '2026-07-02');
  assert.equal(groups[0].shopGroups[0].items[0].name, 'Dispatched no date');
});
test('a real release date is never overridden by an older placed_date', () => {
  const items = [
    { name: 'Future preorder', price: 3.30, shop: 'Forbidden Planet', release_date: '2026-10-28', placed_date: '2026-07-02', status: 'preorder', charge_status: 'not_charged' },
  ];
  const groups = groupItemsByDateAndShop(items);
  assert.equal(groups[0].date, '2026-10-28');
});
test('a date group is not "all paid" if any item in it is still unpaid', () => {
  const items = [
    { name: 'A', price: 1, shop: 'Forbidden Planet', release_date: '2026-05-18', status: 'preorder', charge_status: 'charged' },
    { name: 'B', price: 1, shop: 'Forbidden Planet', release_date: '2026-05-18', status: 'preorder', charge_status: 'not_charged' },
  ];
  assert.equal(groupItemsByDateAndShop(items)[0].allPaid, false);
});

console.log('computeAveragePrice');
test('returns 0 for an empty list', () => {
  assert.equal(computeAveragePrice([]), 0);
});
test('computes the correct average', () => {
  assert.equal(computeAveragePrice([{ price: 3 }, { price: 5 }, { price: 4 }]), 4);
});
test('excludes cancelled items from the average - something you backed out of never counted', () => {
  const items = [{ price: 3 }, { price: 5 }, { price: 999, status: 'cancelled' }];
  assert.equal(computeAveragePrice(items), 4);
});

console.log('findPriciestItem');
test('returns null for an empty list', () => {
  assert.equal(findPriciestItem([]), null);
});
test('finds the single most expensive item', () => {
  const items = [{ name: 'A', price: 3 }, { name: 'B', price: 12 }, { name: 'C', price: 5 }];
  assert.equal(findPriciestItem(items).name, 'B');
});
test('a cancelled item never counts as the priciest, even if it genuinely is the most expensive', () => {
  const items = [{ name: 'A', price: 3 }, { name: 'B', price: 999, status: 'cancelled' }, { name: 'C', price: 5 }];
  assert.equal(findPriciestItem(items).name, 'C');
});

console.log('topExpensiveItems');
test('returns the top 3 by default, highest first', () => {
  const items = [
    { name: 'A', price: 3 }, { name: 'B', price: 12 }, { name: 'C', price: 5 }, { name: 'D', price: 20 },
  ];
  const top = topExpensiveItems(items);
  assert.equal(top.length, 3);
  assert.equal(top[0].name, 'D');
  assert.equal(top[1].name, 'B');
  assert.equal(top[2].name, 'C');
});
test('returns fewer than 3 if fewer items exist, without error', () => {
  const top = topExpensiveItems([{ name: 'A', price: 3 }]);
  assert.equal(top.length, 1);
});
test('a cancelled item never appears in the top expensive list, even if it would otherwise rank first', () => {
  const items = [
    { name: 'A', price: 3 }, { name: 'B', price: 999, status: 'cancelled' }, { name: 'C', price: 5 },
  ];
  const top = topExpensiveItems(items);
  assert.equal(top.length, 2);
  assert.ok(!top.some(i => i.name === 'B'));
});

console.log('groupSpendByShop');
test('groups and sums correctly, highest spend first', () => {
  const items = [
    { name: 'A', price: 5, shop: 'Forbidden Planet' },
    { name: 'B', price: 3, shop: 'eBay' },
    { name: 'C', price: 8, shop: 'Forbidden Planet' },
  ];
  const groups = groupSpendByShop(items);
  assert.equal(groups[0].shop, 'Forbidden Planet');
  assert.equal(groups[0].total, 13);
  assert.equal(groups[1].shop, 'eBay');
});
test('groups items with no shop under "Unknown shop" rather than dropping them', () => {
  const items = [{ name: 'A', price: 5, shop: null }];
  const groups = groupSpendByShop(items);
  assert.equal(groups[0].shop, 'Unknown shop');
});

console.log('buildCalendarGrid');
test('produces full weeks of exactly 7 days each', () => {
  const weeks = buildCalendarGrid([], 2026, 7); // August 2026 (0-indexed month)
  weeks.forEach(week => assert.equal(week.length, 7));
});
test('places a real item on the correct day', () => {
  const items = [{ name: 'A', price: 5, release_date: '2026-08-15' }];
  const weeks = buildCalendarGrid(items, 2026, 7);
  const allDays = weeks.flat().filter(d => d !== null);
  const day15 = allDays.find(d => d.day === 15);
  assert.equal(day15.items.length, 1);
  assert.equal(day15.total, 5);
});
test('gives every other real day zero items, not undefined', () => {
  const weeks = buildCalendarGrid([], 2026, 7);
  const allDays = weeks.flat().filter(d => d !== null);
  allDays.forEach(d => assert.deepEqual(d.items, []));
});
test('leaves blank padding as actual null, not fake day objects', () => {
  // August 2026 starts on a Saturday - 5 leading blanks in a Monday-first grid
  const weeks = buildCalendarGrid([], 2026, 7);
  assert.equal(weeks[0][0], null);
});
test('marks the day matching referenceDate as isToday, and no other day', () => {
  const weeks = buildCalendarGrid([], 2026, 7, new Date(2026, 7, 15));
  const allDays = weeks.flat().filter(d => d !== null);
  const today = allDays.find(d => d.isToday);
  assert.equal(today.day, 15);
  assert.equal(allDays.filter(d => d.isToday).length, 1);
});
test('marks no day as isToday when referenceDate falls in a different month', () => {
  const weeks = buildCalendarGrid([], 2026, 7, new Date(2026, 8, 15));
  const allDays = weeks.flat().filter(d => d !== null);
  assert.equal(allDays.filter(d => d.isToday).length, 0);
});
test('without a referenceDate, no day is marked isToday (backward compatible)', () => {
  const weeks = buildCalendarGrid([], 2026, 7);
  const allDays = weeks.flat().filter(d => d !== null);
  assert.equal(allDays.filter(d => d.isToday).length, 0);
});

console.log('computeMonthSpend');
test('sums only items released within the given month', () => {
  const items = [
    { name: 'A', price: 5, release_date: '2026-08-01' },
    { name: 'B', price: 10, release_date: '2026-09-01' },
  ];
  assert.equal(computeMonthSpend(items, 2026, 7), 5);
});
test('ignores items with no release date', () => {
  const items = [{ name: 'A', price: 5, release_date: null }];
  assert.equal(computeMonthSpend(items, 2026, 7), 0);
});
test('includes shipping, matching the webui - the real bug this used to have: shipping was silently missing from every month/forecast figure across the whole app', () => {
  const items = [
    { name: 'A', price: 5, shipping: 2, release_date: '2026-08-01' },
    { name: 'B', price: 3, shipping: 1.5, release_date: '2026-08-15' },
  ];
  assert.equal(computeMonthSpend(items, 2026, 7), 11.5);
});

console.log('computeMonthSpendWithFallback');
test('unlike computeMonthSpend, falls back to placed_date when there is no release_date - matches the webui\'s "next month forecast" specifically, which is documented there as deliberately reusing the Dashboard hero\'s COALESCE convention', () => {
  const items = [{ name: 'A', price: 5, release_date: null, placed_date: '2026-09-10' }];
  assert.equal(computeMonthSpendWithFallback(items, 2026, 8), 5);
  assert.equal(computeMonthSpend(items, 2026, 8), 0, 'the strict version should still correctly exclude this placed_date-only item');
});
test('release_date wins over placed_date when both are present', () => {
  const items = [{ name: 'A', price: 5, release_date: '2026-09-10', placed_date: '2026-06-01' }];
  assert.equal(computeMonthSpendWithFallback(items, 2026, 8), 5);
  assert.equal(computeMonthSpendWithFallback(items, 2026, 5), 0);
});

console.log('computeBudgetProgress');
test('returns null when no budget is set', () => {
  assert.equal(computeBudgetProgress(50, null), null);
  assert.equal(computeBudgetProgress(50, 0), null);
});
test('computes a correct percentage', () => {
  assert.equal(computeBudgetProgress(50, 100), 50);
});
test('caps at 100 even when over budget', () => {
  assert.equal(computeBudgetProgress(150, 100), 100);
});

console.log('parsePastedText');
test('extracts name, price, and ISO date from a real-shaped line', () => {
  const result = parsePastedText('Amazing Spider-Man #5 - 2026-08-01 - £4.99');
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Amazing Spider-Man #5');
  assert.equal(result[0].price, 4.99);
  assert.equal(result[0].release_date, '2026-08-01');
});
test('extracts a DD/MM/YYYY date correctly', () => {
  const result = parsePastedText('Batman #12 - 15/08/2026 - £3.50');
  assert.equal(result[0].release_date, '2026-08-15');
});
test('handles multiple lines, skipping ones with no price', () => {
  const text = 'Batman #12 £3.50\nJust some random note\nX-Men #1 £12.00';
  const result = parsePastedText(text);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Batman #12');
  assert.equal(result[1].name, 'X-Men #1');
});
test('never invents a date when none is present', () => {
  const result = parsePastedText('Batman #12 £3.50');
  assert.equal(result[0].release_date, null);
});
test('handles $ and € symbols, not just £', () => {
  const result = parsePastedText('Item A $4.99\nItem B €3.50');
  assert.equal(result[0].price, 4.99);
  assert.equal(result[1].price, 3.50);
});
test('returns an empty array for text with no prices at all', () => {
  assert.deepEqual(parsePastedText('just some notes\nno prices here'), []);
});

console.log('computePreorderVsReleased');
test('splits correctly and excludes cancelled items', () => {
  const items = [
    { status: 'preorder' }, { status: 'preorder' }, { status: 'dispatched' }, { status: 'cancelled' },
  ];
  const result = computePreorderVsReleased(items);
  assert.equal(result.preorder, 2);
  assert.equal(result.released, 1);
});
test('preorder + released always equals the true non-cancelled total, even with an unexpected status value - the real bug this used to have: an item whose status was neither "preorder" nor exactly "dispatched" used to silently vanish from the ring\'s displayed total while still counting everywhere else on the page', () => {
  const items = [
    { status: 'preorder' }, { status: 'dispatched' }, { status: 'some_other_status' }, { status: 'cancelled' },
  ];
  const result = computePreorderVsReleased(items);
  assert.equal(result.preorder + result.released, 3, 'should equal the 3 non-cancelled items, not just 2');
  assert.equal(result.released, 2, 'the unexpected status should count as released, same as the webui\'s 100-preorder_pct approach');
});

console.log('computeCancelledSavings');
test('sums only cancelled items', () => {
  const items = [{ price: 5, status: 'cancelled' }, { price: 3, status: 'preorder' }, { price: 7, status: 'cancelled' }];
  assert.equal(computeCancelledSavings(items), 12);
});

console.log('findMostExpensiveMonth');
test('finds the month with the highest total', () => {
  const items = [
    { price: 5, release_date: '2026-08-01' },
    { price: 20, release_date: '2026-09-01' },
    { price: 3, release_date: '2026-08-15' },
  ];
  const result = findMostExpensiveMonth(items);
  assert.equal(result.month, '2026-09');
  assert.equal(result.total, 20);
  assert.equal(result.count, 1);
});
test('includes shipping in both the winning month and the displayed total, matching the webui - a month can now win on comics+shipping combined even if it does not have the highest comics-only total', () => {
  const items = [
    { price: 5, shipping: 1, release_date: '2026-08-01' }, // Aug total incl. shipping: 6
    { price: 5, shipping: 0, release_date: '2026-09-01' }, // Sep total incl. shipping: 5
  ];
  const result = findMostExpensiveMonth(items);
  assert.equal(result.month, '2026-08');
  assert.equal(result.total, 6);
});
test('returns the issue count for the winning month, not the total item count', () => {
  const items = [
    { price: 5, release_date: '2026-08-01' },
    { price: 3, release_date: '2026-08-15' },
    { price: 1, release_date: '2026-09-01' },
  ];
  assert.equal(findMostExpensiveMonth(items).count, 2);
});
test('returns null when nothing is dated', () => {
  assert.equal(findMostExpensiveMonth([{ price: 5, release_date: null }]), null);
});
test('a cancelled item never counts toward a month total, even if it would otherwise win', () => {
  const items = [
    { price: 5, release_date: '2026-08-01' },
    { price: 999, release_date: '2026-09-01', status: 'cancelled' },
  ];
  assert.equal(findMostExpensiveMonth(items).month, '2026-08');
});

console.log('findBusiestWeekday');
test('finds the weekday with the most releases', () => {
  // 2026-08-05 is a Wednesday, 2026-08-12 is also a Wednesday
  const items = [
    { release_date: '2026-08-05' }, { release_date: '2026-08-12' }, { release_date: '2026-08-06' },
  ];
  const result = findBusiestWeekday(items);
  assert.equal(result.day, 'Wednesday');
  assert.equal(result.count, 2);
});
test('returns null when nothing is dated', () => {
  assert.equal(findBusiestWeekday([{ release_date: null }]), null);
});
test('a cancelled item never counts toward a weekday tally', () => {
  const items = [
    { release_date: '2026-08-05', status: 'cancelled' }, { release_date: '2026-08-05', status: 'cancelled' },
    { release_date: '2026-08-06' },
  ];
  const result = findBusiestWeekday(items);
  assert.equal(result.day, 'Thursday');
  assert.equal(result.count, 1);
});

console.log('computeShippingStats');
test('only counts items that actually have a shipping figure', () => {
  const items = [{ shipping: 3.5 }, { shipping: null }, { shipping: 2.5 }];
  const stats = computeShippingStats(items);
  assert.equal(stats.count, 2);
  assert.equal(stats.total, 6);
  assert.equal(stats.average, 3);
});
test('returns zeroes, not an error, when nothing has shipping recorded', () => {
  const stats = computeShippingStats([{ shipping: null }]);
  assert.equal(stats.count, 0);
  assert.equal(stats.total, 0);
  assert.equal(stats.biggest, null);
});
test('correctly finds the biggest and cheapest shipping charge', () => {
  const items = [{ shipping: 3.5 }, { shipping: 5.99 }, { shipping: 0.29 }];
  const stats = computeShippingStats(items);
  assert.equal(stats.biggest, 5.99);
  assert.equal(stats.cheapest, 0.29);
});
test('reports which shop the biggest shipping charge came from', () => {
  const items = [{ shipping: 3.5, shop: 'Forbidden Planet' }, { shipping: 5.99, shop: 'eBay - seller' }];
  assert.equal(computeShippingStats(items).biggestShop, 'eBay - seller');
});

console.log('computeShippingRatioPct');
test('computes shipping as a percentage of comic spend', () => {
  const items = [{ price: 100, shipping: 5 }, { price: 100, shipping: 5 }];
  assert.equal(computeShippingRatioPct(items), 5);
});
test('returns 0 rather than dividing by zero when nothing is tracked', () => {
  assert.equal(computeShippingRatioPct([]), 0);
});

console.log('computePreorderPct');
test('computes the correct pre-order percentage', () => {
  const items = [
    { status: 'preorder' }, { status: 'preorder' }, { status: 'dispatched' }, { status: 'cancelled' },
  ];
  assert.equal(computePreorderPct(items), 66.7);
});
test('returns 0 rather than dividing by zero when nothing active exists', () => {
  assert.equal(computePreorderPct([{ status: 'cancelled' }]), 0);
});

console.log('sortItemsBy');
test('sorts by price descending', () => {
  const items = [{ name: 'A', price: 3 }, { name: 'B', price: 10 }];
  const sorted = sortItemsBy(items, 'price_desc');
  assert.equal(sorted[0].name, 'B');
});
test('sorts by name A-Z', () => {
  const items = [{ name: 'Zebra', price: 1 }, { name: 'Apple', price: 1 }];
  const sorted = sortItemsBy(items, 'name_asc');
  assert.equal(sorted[0].name, 'Apple');
});
test('falls back to date_desc for an unrecognised key rather than throwing', () => {
  const items = [{ name: 'A', release_date: '2026-08-01' }, { name: 'B', release_date: '2026-09-01' }];
  const sorted = sortItemsBy(items, 'nonsense_key');
  assert.equal(sorted[0].name, 'B');
});

console.log('computeCycleBounds');
test('monthly cycle covers the full calendar month', () => {
  const { start, end } = computeCycleBounds('monthly', new Date(2026, 7, 15)); // 15 Aug 2026
  assert.equal(start.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(end.toISOString().slice(0, 10), '2026-08-31');
});
test('weekly cycle starts on Monday and covers exactly 7 days', () => {
  // 15 Aug 2026 is a Saturday
  const { start, end } = computeCycleBounds('weekly', new Date(2026, 7, 15));
  assert.equal(start.toISOString().slice(0, 10), '2026-08-10'); // the preceding Monday
  assert.equal(end.toISOString().slice(0, 10), '2026-08-16'); // the following Sunday
});
test('28day cycle ends today and covers exactly 28 days', () => {
  const { start, end } = computeCycleBounds('28day', new Date(2026, 7, 15));
  assert.equal(end.toISOString().slice(0, 10), '2026-08-15');
  assert.equal(start.toISOString().slice(0, 10), '2026-07-19');
});
test('falls back to monthly for an unrecognised cycle type', () => {
  const { start } = computeCycleBounds('nonsense', new Date(2026, 7, 15));
  assert.equal(start.toISOString().slice(0, 10), '2026-08-01');
});

console.log('computeCycleSpend');
test('sums only items released within the current monthly cycle', () => {
  const items = [
    { price: 5, release_date: '2026-08-05' },
    { price: 10, release_date: '2026-09-01' },
  ];
  assert.equal(computeCycleSpend(items, 'monthly', new Date(2026, 7, 15)), 5);
});
test('includes shipping in the budget cycle total, matching the webui', () => {
  const items = [{ price: 5, shipping: 2.5, release_date: '2026-08-05' }];
  assert.equal(computeCycleSpend(items, 'monthly', new Date(2026, 7, 15)), 7.5);
});
test('sums only items released within the current weekly cycle', () => {
  const items = [
    { price: 5, release_date: '2026-08-11' }, // within the Mon 10 - Sun 16 week
    { price: 10, release_date: '2026-08-01' }, // outside it
  ];
  assert.equal(computeCycleSpend(items, 'weekly', new Date(2026, 7, 15)), 5);
});

console.log('buildCsvExport');
test('produces a correct header and row', () => {
  const csv = buildCsvExport([{ name: 'Batman #12', price: 3.5, release_date: '2026-08-01', shop: 'eBay', status: 'preorder', order_number: '123', shipping: 2.5 }]);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'Name,Price,Release Date,Shop,Status,Order Number,Shipping');
  assert.equal(lines[1], 'Batman #12,3.50,2026-08-01,eBay,preorder,123,2.5');
});
test('escapes a name containing a comma correctly', () => {
  const csv = buildCsvExport([{ name: 'Batman, Vol 1', price: 3.5, release_date: null, shop: null, status: 'preorder' }]);
  assert.ok(csv.includes('"Batman, Vol 1"'));
});
test('handles an empty list, producing just the header', () => {
  const csv = buildCsvExport([]);
  assert.equal(csv, 'Name,Price,Release Date,Shop,Status,Order Number,Shipping');
});

console.log('buildJsonBackup / parseJsonBackup');
test('round-trips real item data correctly', () => {
  const items = [{ id: 1, name: 'Batman #12', price: 3.5, release_date: '2026-08-01', shop: 'eBay', status: 'preorder' }];
  const json = buildJsonBackup(items);
  const { valid, items: parsed } = parseJsonBackup(json);
  assert.equal(valid, true);
  assert.equal(parsed[0].name, 'Batman #12');
});
test('rejects genuinely invalid JSON rather than crashing', () => {
  const result = parseJsonBackup('not valid json{{{');
  assert.equal(result.valid, false);
  assert.ok(result.error.includes('valid JSON'));
});
test('rejects valid JSON that is not a recognised backup shape', () => {
  const result = parseJsonBackup('{"foo": "bar"}');
  assert.equal(result.valid, false);
});
test('rejects a backup containing an invalid item', () => {
  const result = parseJsonBackup(JSON.stringify({ version: 1, items: [{ name: 'A' }] })); // missing price
  assert.equal(result.valid, false);
});

console.log('findTomorrowReleases');
test('finds items releasing exactly tomorrow', () => {
  const items = [
    { name: 'A', release_date: '2026-08-16', status: 'preorder' },
    { name: 'B', release_date: '2026-08-17', status: 'preorder' },
  ];
  const result = findTomorrowReleases(items, new Date(2026, 7, 16)); // today = 16 Aug
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'B');
});
test('excludes cancelled items even if dated tomorrow', () => {
  const items = [{ name: 'A', release_date: '2026-08-17', status: 'cancelled' }];
  const result = findTomorrowReleases(items, new Date(2026, 7, 16));
  assert.equal(result.length, 0);
});

console.log('buildTomorrowNotification');
test('builds a quiet message when nothing releases tomorrow', () => {
  const result = buildTomorrowNotification([], '£');
  assert.equal(result.body, 'Nothing releasing tomorrow.');
});
test('builds a real title and per-shop body when items exist', () => {
  const items = [
    { name: 'A', price: 5, shop: 'Forbidden Planet' },
    { name: 'B', price: 3, shop: 'eBay' },
  ];
  const result = buildTomorrowNotification(items, '£');
  assert.equal(result.title, 'Tomorrow: 2 items, £8.00');
  assert.ok(result.body.includes('Forbidden Planet: £5.00'));
  assert.ok(result.body.includes('eBay: £3.00'));
});

console.log('filterByShop');
test('filters down to a single shop', () => {
  const items = [{ name: 'A', shop: 'Forbidden Planet' }, { name: 'B', shop: 'eBay' }];
  assert.equal(filterByShop(items, 'eBay').length, 1);
});
test('returns everything when shop is empty', () => {
  const items = [{ name: 'A', shop: 'Forbidden Planet' }, { name: 'B', shop: 'eBay' }];
  assert.equal(filterByShop(items, '').length, 2);
});

console.log('computeYearStats');
test('only counts charged items toward spent, but all non-cancelled toward total', () => {
  const items = [
    { price: 5, release_date: '2026-03-01', status: 'preorder', charge_status: 'charged' },
    { price: 3, release_date: '2026-04-01', status: 'preorder', charge_status: 'not_charged' },
    { price: 100, release_date: '2026-01-01', status: 'cancelled', charge_status: 'not_charged' },
  ];
  const result = computeYearStats(items, 2026);
  assert.equal(result.year.spent, 5);
  assert.equal(result.year.total, 8);
  assert.equal(result.year.count, 2);
});
test('all-time figures include every year, not just the requested one', () => {
  const items = [
    { price: 5, release_date: '2025-01-01', status: 'preorder', charge_status: 'charged' },
    { price: 3, release_date: '2026-01-01', status: 'preorder', charge_status: 'charged' },
  ];
  const result = computeYearStats(items, 2026);
  assert.equal(result.year.total, 3);
  assert.equal(result.allTime.total, 8);
});

console.log('buildMonthlySpendTrend');
test('produces the requested number of months, oldest first', () => {
  const trend = buildMonthlySpendTrend([], 6, new Date(2026, 7, 15));
  assert.equal(trend.length, 6);
  assert.equal(trend[trend.length - 1].label, 'Aug');
});
test('correctly totals a real item into its own month', () => {
  const items = [{ price: 5, release_date: '2026-08-01' }];
  const trend = buildMonthlySpendTrend(items, 3, new Date(2026, 7, 15));
  assert.equal(trend[trend.length - 1].total, 5);
  assert.equal(trend[0].total, 0);
});
test('excludes an item with no release_date even if it has a placed_date - deliberately different from Dashboard\'s own charts, matching the webui\'s month_stats exactly (`dated_items = [i for i in all_items if i["release_date"]]`, no placed_date fallback for this specific chart)', () => {
  const items = [{ price: 5, release_date: null, placed_date: '2026-07-10', status: 'preorder' }];
  const trend = buildMonthlySpendTrend(items, 3, new Date(2026, 7, 15));
  const totalAcrossAllMonths = trend.reduce((sum, m) => sum + m.total, 0);
  assert.equal(totalAcrossAllMonths, 0, 'a placed_date-only item should not appear in any month of this chart');
});
test('release_date wins over placed_date when both are present', () => {
  const items = [{ price: 5, release_date: '2026-08-01', placed_date: '2026-06-01' }];
  const trend = buildMonthlySpendTrend(items, 3, new Date(2026, 7, 15));
  assert.equal(trend[trend.length - 1].total, 5);
  assert.equal(trend[0].total, 0);
});

console.log('computeYearStats placed_date fallback');
test('an item with no release_date still counts toward the year via placed_date', () => {
  const items = [{ price: 5, release_date: null, placed_date: '2026-03-04', status: 'dispatched', charge_status: 'charged' }];
  const stats = computeYearStats(items, 2026);
  assert.equal(stats.year.total, 5);
  assert.equal(stats.year.spent, 5);
  assert.equal(stats.allTime.total, 5);
});

console.log('buildIcsExport');
test('produces a valid VCALENDAR wrapper', () => {
  const ics = buildIcsExport([{ name: 'Batman #12', price: 3.5, release_date: '2026-08-01', status: 'preorder' }]);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'));
  assert.ok(ics.endsWith('END:VCALENDAR'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20260801'));
});
test('excludes cancelled items', () => {
  const ics = buildIcsExport([{ name: 'Batman #12', price: 3.5, release_date: '2026-08-01', status: 'cancelled' }]);
  assert.ok(!ics.includes('BEGIN:VEVENT'));
});
test('groups same-day items into one event, not several', () => {
  const items = [
    { name: 'A', price: 3, release_date: '2026-08-01', status: 'preorder' },
    { name: 'B', price: 4, release_date: '2026-08-01', status: 'preorder' },
  ];
  const ics = buildIcsExport(items);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(ics.includes('2 items releasing'));
});
test('escapes commas in item names per the iCalendar spec', () => {
  const ics = buildIcsExport([{ name: 'Batman, Vol 1', price: 3.5, release_date: '2026-08-01', status: 'preorder' }]);
  assert.ok(ics.includes('Batman\\, Vol 1'));
});

console.log('computeSearchTotals');
test('splits spent vs remaining correctly, excluding cancelled', () => {
  const items = [
    { price: 5, status: 'preorder', charge_status: 'charged' },
    { price: 3, status: 'preorder', charge_status: 'not_charged' },
    { price: 100, status: 'cancelled', charge_status: 'not_charged' },
  ];
  const totals = computeSearchTotals(items);
  assert.equal(totals.spent, 5);
  assert.equal(totals.remaining, 3);
  assert.equal(totals.cancelledCount, 1);
  assert.equal(totals.cancelledTotal, 100);
});

console.log('computeEffectiveBudget');
test('adds unused budget from the previous month when rollover is on', () => {
  const items = [{ price: 60, release_date: '2026-07-01' }]; // spent 60 of 100 last month
  const effective = computeEffectiveBudget(100, 'monthly', true, items, new Date(2026, 7, 15));
  assert.equal(effective, 140); // 100 + (100 - 60) unused
});
test('returns the plain budget when rollover is off', () => {
  const items = [{ price: 60, release_date: '2026-07-01' }];
  const effective = computeEffectiveBudget(100, 'monthly', false, items, new Date(2026, 7, 15));
  assert.equal(effective, 100);
});
test('never rolls over a negative amount if last month overspent', () => {
  const items = [{ price: 150, release_date: '2026-07-01' }]; // overspent
  const effective = computeEffectiveBudget(100, 'monthly', true, items, new Date(2026, 7, 15));
  assert.equal(effective, 100);
});
test('does not apply rollover to non-monthly cycles', () => {
  const items = [{ price: 60, release_date: '2026-07-01' }];
  const effective = computeEffectiveBudget(100, 'weekly', true, items, new Date(2026, 7, 15));
  assert.equal(effective, 100);
});

console.log('findNextWeekReleases');
test('finds items within the next 7 days inclusive', () => {
  const items = [
    { name: 'A', release_date: '2026-08-16', status: 'preorder' },
    { name: 'B', release_date: '2026-08-22', status: 'preorder' },
    { name: 'C', release_date: '2026-08-23', status: 'preorder' },
  ];
  const result = findNextWeekReleases(items, new Date(2026, 7, 16));
  assert.equal(result.length, 2);
});
test('excludes cancelled items', () => {
  const items = [{ name: 'A', release_date: '2026-08-17', status: 'cancelled' }];
  const result = findNextWeekReleases(items, new Date(2026, 7, 16));
  assert.equal(result.length, 0);
});

console.log('buildWeeklyNotification');
test('builds a quiet message when nothing releases this week', () => {
  const result = buildWeeklyNotification([], '£');
  assert.equal(result.body, 'Nothing releasing this week.');
});
test('builds a real title with the weekly total', () => {
  const items = [{ name: 'A', price: 5, shop: 'eBay' }];
  const result = buildWeeklyNotification(items, '£');
  assert.equal(result.title, 'This week: 1 item, £5.00');
});

console.log('findDuplicateGroups');
test('flags same name + release date with more than one distinct order number', () => {
  const items = [
    { name: 'Batman #1', release_date: '2026-08-01', order_number: '111', status: 'preorder' },
    { name: 'Batman #1', release_date: '2026-08-01', order_number: '222', status: 'preorder' },
    { name: 'Batman #2', release_date: '2026-08-01', order_number: '111', status: 'preorder' },
  ];
  const groups = findDuplicateGroups(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, 'Batman #1');
  assert.equal(groups[0].entries.length, 2);
});
test('does not flag two items sharing the same order number (same order, not a duplicate)', () => {
  const items = [
    { name: 'Batman #1', release_date: '2026-08-01', order_number: '111', status: 'preorder' },
    { name: 'Batman #1', release_date: '2026-08-01', order_number: '111', status: 'preorder' },
  ];
  assert.equal(findDuplicateGroups(items).length, 0);
});
test('does not flag two items with no order number at all - cannot tell them apart this way', () => {
  const items = [
    { name: 'Batman #1', release_date: '2026-08-01', order_number: null, status: 'preorder' },
    { name: 'Batman #1', release_date: '2026-08-01', order_number: null, status: 'preorder' },
  ];
  assert.equal(findDuplicateGroups(items).length, 0);
});
test('a cancelled item does not count toward a duplicate flag', () => {
  const items = [
    { name: 'Batman #1', release_date: '2026-08-01', order_number: '111', status: 'preorder' },
    { name: 'Batman #1', release_date: '2026-08-01', order_number: '222', status: 'cancelled' },
  ];
  assert.equal(findDuplicateGroups(items).length, 0);
});
test('a dismissed name+date pair stays hidden', () => {
  const items = [
    { name: 'Batman #1', release_date: '2026-08-01', order_number: '111', status: 'preorder' },
    { name: 'Batman #1', release_date: '2026-08-01', order_number: '222', status: 'preorder' },
  ];
  const dismissed = new Set(['Batman #1|||2026-08-01']);
  assert.equal(findDuplicateGroups(items, dismissed).length, 0);
});

console.log('findGhostItems');
test('flags Forbidden Planet items with no order number', () => {
  const items = [
    { name: 'A', shop: 'Forbidden Planet', order_number: null, status: 'preorder', release_date: '2026-08-01' },
    { name: 'B', shop: 'Forbidden Planet', order_number: '123', status: 'preorder', release_date: '2026-08-02' },
    { name: 'C', shop: 'eBay - seller', order_number: null, status: 'preorder', release_date: '2026-08-03' },
  ];
  const result = findGhostItems(items);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'A');
});
test('ignores a cancelled Forbidden Planet item with no order number', () => {
  const items = [
    { name: 'A', shop: 'Forbidden Planet', order_number: null, status: 'cancelled', release_date: '2026-08-01' },
  ];
  assert.equal(findGhostItems(items).length, 0);
});

console.log('findRecentlyCancelled');
test('returns cancelled items newest-id-first, capped at the limit', () => {
  const items = [
    { id: 1, name: 'A', status: 'cancelled' },
    { id: 2, name: 'B', status: 'preorder' },
    { id: 3, name: 'C', status: 'cancelled' },
  ];
  const result = findRecentlyCancelled(items);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 3);
  assert.equal(result[1].id, 1);
});
test('caps at the given limit', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Item ${i}`, status: 'cancelled' }));
  assert.equal(findRecentlyCancelled(items, 15).length, 15);
});
test('drops a cancellation older than 30 days once something newer has cancelled since', () => {
  const referenceDate = new Date('2026-07-30T00:00:00.000Z');
  const items = [
    { id: 1, name: 'Old cancel', status: 'cancelled', updated_at: '2026-06-01T00:00:00.000Z' }, // 59 days ago
    { id: 2, name: 'Recent cancel', status: 'cancelled', updated_at: '2026-07-20T00:00:00.000Z' }, // 10 days ago
  ];
  const result = findRecentlyCancelled(items, 15, referenceDate);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 2);
});
test('keeps an item with no updated_at at all rather than dropping it silently', () => {
  const items = [{ id: 1, name: 'No timestamp', status: 'cancelled' }];
  assert.equal(findRecentlyCancelled(items, 15, new Date('2026-07-30T00:00:00.000Z')).length, 1);
});

console.log('findAwaitingCharge');
test('finds unpaid items whose release date has passed, sorted oldest first', () => {
  const items = [
    { id: 1, name: 'A', release_date: '2026-07-10', status: 'preorder', charge_status: 'not_charged' },
    { id: 2, name: 'B', release_date: '2026-07-05', status: 'preorder', charge_status: 'not_charged' },
    { id: 3, name: 'C', release_date: '2026-07-20', status: 'preorder', charge_status: 'not_charged' }, // future
  ];
  const result = findAwaitingCharge(items, new Date(2026, 6, 15));
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 2);
  assert.equal(result[0].days_late, 10);
  assert.equal(result[1].id, 1);
  assert.equal(result[1].days_late, 5);
});
test('excludes cancelled and already-charged items', () => {
  const items = [
    { id: 1, name: 'A', release_date: '2026-07-01', status: 'cancelled', charge_status: 'not_charged' },
    { id: 2, name: 'B', release_date: '2026-07-01', status: 'preorder', charge_status: 'charged' },
  ];
  const result = findAwaitingCharge(items, new Date(2026, 6, 15));
  assert.equal(result.length, 0);
});
test('excludes items releasing today or with no release date', () => {
  const items = [
    { id: 1, name: 'A', release_date: '2026-07-15', status: 'preorder', charge_status: 'not_charged' },
    { id: 2, name: 'B', release_date: null, status: 'preorder', charge_status: 'not_charged' },
  ];
  const result = findAwaitingCharge(items, new Date(2026, 6, 15));
  assert.equal(result.length, 0);
});

console.log('buildMonthlySpendTrendRange');
test('spans the requested months back and forward from today', () => {
  const items = [{ price: 10, release_date: '2026-07-01', status: 'preorder' }];
  const result = buildMonthlySpendTrendRange(items, 3, 5, new Date(2026, 6, 15));
  assert.equal(result.length, 9);
  assert.equal(result[3].total, 10); // 3 back -> index 3 is the current month
});
test('unlike buildMonthlySpendTrend, this one correctly keeps the placed_date fallback - it backs Dashboard\'s own charts, which the webui deliberately does fall back for (fetch_items_between\'s COALESCE)', () => {
  const items = [{ price: 5, release_date: null, placed_date: '2026-07-10', status: 'preorder' }];
  const result = buildMonthlySpendTrendRange(items, 3, 5, new Date(2026, 6, 15));
  const total = result.reduce((sum, m) => sum + m.total, 0);
  assert.equal(total, 5, 'a placed_date-only item should still count somewhere in this Dashboard-facing chart');
});

console.log('buildWeeklySpendTrend');
test('groups an item into the correct Monday-start week', () => {
  const items = [{ price: 5, release_date: '2026-07-15', status: 'preorder' }]; // a Wednesday
  const result = buildWeeklySpendTrend(items, 4, 8, new Date(2026, 6, 15));
  const total = result.reduce((sum, w) => sum + w.total, 0);
  assert.equal(total, 5);
  assert.equal(result.length, 13);
});

console.log('groupSpendByShopWithSellers');
test('groups per-seller eBay sources under one eBay row', () => {
  const items = [
    { name: 'A', price: 10, shop: 'eBay - sad_lemon_comics', status: 'preorder' },
    { name: 'B', price: 5, shop: 'eBay - bearsgames', status: 'preorder' },
    { name: 'C', price: 20, shop: 'Forbidden Planet', status: 'preorder' },
  ];
  const result = groupSpendByShopWithSellers(items);
  assert.equal(result.length, 2);
  const ebay = result.find(s => s.shop === 'eBay');
  assert.ok(ebay);
  assert.equal(ebay.total, 15);
  assert.equal(ebay.count, 2);
  assert.equal(ebay.subShops.length, 2);
  assert.equal(ebay.subShops[0].shop, 'eBay - sad_lemon_comics'); // higher spend first
});
test('does not create sub_shops for a shop with only one non-eBay source', () => {
  const items = [{ name: 'A', price: 10, shop: 'Forbidden Planet', status: 'preorder' }];
  const result = groupSpendByShopWithSellers(items);
  assert.equal(result.length, 1);
  assert.equal(result[0].subShops.length, 0);
});
test('includes real shipping in the shop total, not just comic price - the bug Callum found where the app undercounted vs the webui by exactly the missing shipping total', () => {
  const items = [
    { name: 'A', price: 10, shop: 'Forbidden Planet', status: 'preorder', shipping: 2.50 },
    { name: 'B', price: 5, shop: 'Forbidden Planet', status: 'preorder', shipping: 2.50 },
  ];
  const result = groupSpendByShopWithSellers(items);
  assert.equal(result[0].total, 20); // 10 + 5 + 2.50 + 2.50, not just 15
});
test('treats a missing shipping figure as 0 rather than NaN', () => {
  const items = [{ name: 'A', price: 10, shop: 'Forbidden Planet', status: 'preorder' }];
  const result = groupSpendByShopWithSellers(items);
  assert.equal(result[0].total, 10);
});
test('excludes cancelled items from totals', () => {
  const items = [{ name: 'A', price: 10, shop: 'eBay - x', status: 'cancelled' }];
  const result = groupSpendByShopWithSellers(items);
  assert.equal(result.length, 0);
});
test('a plain "eBay" source with no seller suffix still groups with per-seller ones', () => {
  const items = [
    { name: 'A', price: 10, shop: 'eBay', status: 'preorder' },
    { name: 'B', price: 5, shop: 'eBay - bearsgames', status: 'preorder' },
  ];
  const result = groupSpendByShopWithSellers(items);
  assert.equal(result.length, 1);
  assert.equal(result[0].shop, 'eBay');
  assert.equal(result[0].total, 15);
  assert.equal(result[0].subShops.length, 1);
  assert.equal(result[0].subShops[0].shop, 'eBay - bearsgames');
});

console.log('assignShopColor');
test('always gives Forbidden Planet the primary accent colour', () => {
  assert.equal(assignShopColor('Forbidden Planet'), '#2fd8ff');
});
test('gives the same shop name the same colour every time', () => {
  assert.equal(assignShopColor('eBay - bearsgames'), assignShopColor('eBay - bearsgames'));
});

console.log('trend totals now include shipping');
test('buildMonthlySpendTrend total is comics plus shipping, not comics alone', () => {
  const items = [{ price: 10, shipping: 3, release_date: '2026-07-01', status: 'preorder' }];
  const result = buildMonthlySpendTrend(items, 1, new Date(2026, 6, 15));
  assert.equal(result[0].comics, 10);
  assert.equal(result[0].shipping, 3);
  assert.equal(result[0].total, 13);
  assert.equal(result[0].count, 1);
});

console.log('matchesStatusFilter');
test('"all" matches everything including cancelled', () => {
  assert.equal(matchesStatusFilter({ status: 'cancelled', charge_status: 'not_charged' }, 'all'), true);
  assert.equal(matchesStatusFilter({ status: 'preorder', charge_status: 'charged' }, 'all'), true);
});
test('"paid" excludes cancelled items even if charged', () => {
  assert.equal(matchesStatusFilter({ status: 'cancelled', charge_status: 'charged' }, 'paid'), false);
  assert.equal(matchesStatusFilter({ status: 'preorder', charge_status: 'charged' }, 'paid'), true);
});
test('"unpaid" excludes cancelled items even if not charged', () => {
  assert.equal(matchesStatusFilter({ status: 'cancelled', charge_status: 'not_charged' }, 'unpaid'), false);
  assert.equal(matchesStatusFilter({ status: 'preorder', charge_status: 'not_charged' }, 'unpaid'), true);
});
test('"cancelled" only matches cancelled items regardless of charge_status', () => {
  assert.equal(matchesStatusFilter({ status: 'cancelled', charge_status: 'charged' }, 'cancelled'), true);
  assert.equal(matchesStatusFilter({ status: 'preorder', charge_status: 'not_charged' }, 'cancelled'), false);
});

console.log('filterByShop matches grouped eBay sellers');
test('selecting "eBay" catches every per-seller eBay source, not just an exact match', () => {
  const items = [
    { name: 'A', shop: 'eBay - sad_lemon_comics' },
    { name: 'B', shop: 'eBay - bearsgames' },
    { name: 'C', shop: 'Forbidden Planet' },
  ];
  const result = filterByShop(items, 'eBay');
  assert.equal(result.length, 2);
});

console.log('looksLikeForbiddenPlanet');
test('detects a real order-history export shape', () => {
  const text = 'Placed29 Jun 2026\nOrder#[54621806](https://forbiddenplanet.com/orders/54621806/)\nTotal£3.30\n[Comic](url)\nPre-Order\n£3.30';
  assert.equal(looksLikeForbiddenPlanet(text), true);
});
test('does not misdetect a plain pasted list', () => {
  assert.equal(looksLikeForbiddenPlanet('Kylo Ren #1 - 2026-07-20 - £3.99'), false);
});

console.log('parseForbiddenPlanetOrders (real pasted samples)');
test('real order-history list export: 12 items, one order, correct names/prices/dates', () => {
  const text = [
    'Placed29 Jun 2026',
    'Order#[54621806](https://forbiddenplanet.com/orders/54621806/)',
    'Total£55.99',
    'Delivery ToCallum Draper /NG7 5FZ',
    'Billing', 'Debit MasterCard', 'Ends: 4929', 'Exp: 10/2027',
    '',
    '* [Star Wars: The High Republic Adventures: Pathfinders #6 (Cover A Jake Bartok)](https://forbiddenplanet.com/orders/)',
    'Pre-Order (Will ship once we receive stock)',
    '   * Release date: 21 Oct 2026',
    '   * Shipping in approximately 2 months, 3 weeks',
    '   * Not charged',
    '£3.30',
    '* [Star Wars: The Book Of Boba Fett #2 (Rod Reis Variant)](https://forbiddenplanet.com/orders/)',
    'Pre-Order (Will ship once we receive stock)',
    '   * Release date: 23 Sep 2026',
    '   * Shipping in approximately 1 month, 4 weeks',
    '   * Not charged',
    '£3.75',
  ].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Star Wars: The High Republic Adventures: Pathfinders #6 (Cover A Jake Bartok)');
  assert.equal(items[0].price, 3.30);
  assert.equal(items[0].release_date, '2026-10-21');
  assert.equal(items[0].shop, 'Forbidden Planet');
  assert.equal(items[0].order_number, '54621806');
  assert.equal(items[0].status, 'preorder');
  assert.equal(items[0].charge_status, 'not_charged');
  assert.equal(items[1].name, 'Star Wars: The Book Of Boba Fett #2 (Rod Reis Variant)');
  assert.equal(items[1].price, 3.75);
  assert.equal(items[1].order_number, '54621806');
});
test('real dispatched order (list view): status dispatched, charge charged, no release date given', () => {
  const text = [
    'Placed2 Jul 2026',
    'Order#[54626030](https://forbiddenplanet.com/orders/54626030/)',
    'Total£5.85',
    'Delivery ToCallum Draper /NG7 5FZ',
    '* [Star Wars: Rogue One: Jyn Erso #1 (Ramon Rosanas Variant)](https://forbiddenplanet.com/orders/)',
    'Dispatched',
    '   * [Dispatched 2 weeks, 5 days by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3763639/)',
    '   * Fully charged',
    '£3.30',
  ].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Star Wars: Rogue One: Jyn Erso #1 (Ramon Rosanas Variant)');
  assert.equal(items[0].status, 'dispatched');
  assert.equal(items[0].charge_status, 'charged');
  assert.equal(items[0].release_date, null);
  assert.equal(items[0].order_number, '54626030');
});
test('real order-detail page: "Order #" with a space, and "[Cancel item]" links are not mistaken for items', () => {
  const text = [
    'Order #54621806',
    'Confirmed on: 29 Jun 2026, 2:32 p.m.',
    'Order Summary',
    '   * Items£40.95',
    '   * Total£55.99',
    'Item List',
    '   * [Star Wars: The Fall Of Kylo Ren #2 (Chris Sprouse Rogue One 10th Anniversary Variant)](https://forbiddenplanet.com/504135/)',
    'Pre-Order (Will ship once we receive stock)',
    '      * Release date: 16 Sep 2026',
    '      * Shipping in approximately 1 month, 3 weeks',
    '£3.30',
    '[Cancel item](https://forbiddenplanet.com/orders/54621806/cancel/504135/7608643/)',
    '   * [Star Wars: The Fall Of Kylo Ren #2](https://forbiddenplanet.com/503936/)',
    'Pre-Order (Will ship once we receive stock)',
    '      * Release date: 16 Sep 2026',
    '£3.30',
    '[Cancel item](https://forbiddenplanet.com/orders/54621806/cancel/503936/7608650/)',
  ].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].order_number, '54621806');
  assert.equal(items[0].name, 'Star Wars: The Fall Of Kylo Ren #2 (Chris Sprouse Rogue One 10th Anniversary Variant)');
  assert.equal(items[1].name, 'Star Wars: The Fall Of Kylo Ren #2');
});
test('real order-detail dispatched page: no explicit charge line still defaults dispatched to charged', () => {
  const text = [
    'Order #54626030',
    'Confirmed on: 2 Jul 2026, 8:21 p.m.',
    'Item List',
    '   * [Star Wars: Rogue One: Jyn Erso #1 (Ramon Rosanas Variant)](https://forbiddenplanet.com/491540/)',
    'Dispatched',
    '      * [Dispatched 2 weeks, 5 days by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3763639/)',
    '£3.30',
  ].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'dispatched');
  assert.equal(items[0].charge_status, 'charged');
  assert.equal(items[0].placed_date, '2026-07-02');
});
test('real order-detail page with no release date: "Confirmed on" is captured as placed_date, so dispatched items with no release date still count toward spend history', () => {
  const text = [
    'Order #54466680',
    'Confirmed on: 4 Mar 2026, 1:27 p.m.',
    'Item List',
    '* [Star Wars: Galaxy\'s Edge: Echoes Of The Empire #2](https://forbiddenplanet.com/488014/)',
    'Dispatched',
    '   * [Dispatched 1 month, 3 weeks by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3716673/)',
    '£3.30',
  ].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].release_date, null);
  assert.equal(items[0].placed_date, '2026-03-04');
  assert.equal(items[0].charge_status, 'charged');
});
test('keeps an item even with no order number known yet, rather than discarding it', () => {
  const text = ['* [Orphan Comic](url)', 'Pre-Order', '£3.30'].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].order_number, null);
});
test('real paste missing the Order# line (item-only fragment) still parses, matching what actually happened', () => {
  const text = [
    '[Awaiting product image]',
    'Star Wars: Rogue One: Darth Vader #1 (Phil Noto Variant)',
    'Pre-Order (Will ship once we receive stock)',
    '',
    'Release date: 28 Oct 2026',
    'Shipping in approximately 1 month, 1 week',
    'Not charged',
    '£3.30',
  ].join('\n');
  assert.equal(looksLikeForbiddenPlanet(text), true);
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Star Wars: Rogue One: Darth Vader #1 (Phil Noto Variant)');
  assert.equal(items[0].order_number, null);
});
test('real order-history LIST page: a bulleted "Order#[...]" line still registers - previously lost every item under it', () => {
  // On the multi-order history list page, the order-number line itself
  // gets bulleted just like items do (unlike the single order-detail
  // page, where "Order #NNNNN" stands on its own line with no bullet).
  const text = [
    'Placed4 Jun 2026',
    '* Order#[54587110](https://forbiddenplanet.com/orders/54587110/)',
    'Total£46.29',
    'Delivery ToCallum Draper /NG7 5FZ',
    '   * [Star Wars: Galaxy\'s Edge: Echoes Of The Empire #5](https://forbiddenplanet.com/orders/?page=2)',
    'Pre-Order (Will ship once we receive stock)',
    '      * Release date: 19 Aug 2026',
    '      * Not charged',
    '£3.30',
  ].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].order_number, '54587110');
});
test('real paste-box text: "Order#" and the number sit on two entirely separate lines, not joined at all', () => {
  // Confirmed against the app's own paste box, not a reformatted/reader-mode
  // copy of the page - "Order#" stands completely alone, with the bare
  // number as its own line straight after, no brackets or link syntax
  // anywhere. Distinct from both the same-line and bulleted-same-line cases
  // above.
  const text = [
    'Placed',
    '4 Jun 2026',
    'Order#',
    '54587110',
    'Total',
    '£46.29',
    'Delivery To',
    'Callum Draper /NG7 5FZ',
    '[Star Wars: Galaxy\'s Edge: Echoes Of The Empire #5 (Product Image)]',
    'Star Wars: Galaxy\'s Edge: Echoes Of The Empire #5',
    'Pre-Order (Will ship once we receive stock)',
    'Release date: 19 Aug 2026',
    'Shipping in approximately 3 weeks',
    'Not charged',
    '£3.30',
    '[Star Wars: Rogue One: Chirrut & Baze #1 (Aka Variant) (Product Image)]',
    'Star Wars: Rogue One: Chirrut & Baze #1 (Aka Variant)',
    'Pre-Order (Will ship once we receive stock)',
    'Release date: 14 Oct 2026',
    'Shipping in approximately 2 weeks',
    'Not charged',
    '£3.30',
  ].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Star Wars: Galaxy\'s Edge: Echoes Of The Empire #5');
  assert.equal(items[0].order_number, '54587110');
  assert.equal(items[0].placed_date, '2026-06-04');
  assert.equal(items[1].name, 'Star Wars: Rogue One: Chirrut & Baze #1 (Aka Variant)');
  assert.equal(items[1].order_number, '54587110');
  assert.equal(items[1].placed_date, '2026-06-04');
});
test('an "[Awaiting product image]" placeholder is not itself the item name - the next line is', () => {
  const text = [
    'Order#111',
    '[Awaiting product image]',
    'Star Wars: Rogue One: Darth Vader #1 (Phil Noto Variant)',
    'Pre-Order (Will ship once we receive stock)',
    '',
    'Release date: 28 Oct 2026',
    'Shipping in approximately 1 month, 1 week',
    'Not charged',
    '£3.30',
  ].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Star Wars: Rogue One: Darth Vader #1 (Phil Noto Variant)');
  assert.equal(items[0].price, 3.30);
  assert.equal(items[0].release_date, '2026-10-28');
  assert.equal(items[0].charge_status, 'not_charged');
});
test('skips an item with no price found (malformed/page-break) rather than guessing', () => {
  const text = ['Order#111', '* [Comic With No Price](url)', 'Pre-Order', 'Release date: 12 Aug 2026'].join('\n');
  assert.equal(parseForbiddenPlanetOrders(text).length, 0);
});
test('real order-detail page: a single-item order\'s declared postage attaches directly as that item\'s shipping', () => {
  const text = [
    'Order #54626030', 'Confirmed on: 2 Jul 2026, 8:21 p.m.',
    'Order Summary', '* Items£3.30', '* Postage:£2.55', '* Total£5.85',
    'Item List',
    '* [Star Wars: Rogue One: Jyn Erso #1 (Ramon Rosanas Variant)](url)',
    'Dispatched', '   * [Dispatched 3 weeks by Royal Mail](url)', '£3.30',
  ].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].shipping, 2.55);
});
test('real order-detail page: a multi-item order shipped in two separate parcels still only shows one lump postage figure, split evenly across every item', () => {
  const text = [
    'Order #54548245', 'Confirmed on: 7 May 2026, 12:23 p.m.',
    'Order Summary', '* Items£13.20', '* Postage:£4.00', '* Total£17.20',
    'Item List',
    '* [Replacement: Star Wars: Shadow Of Maul #5](url)', 'Dispatched', '   * [Dispatched 1 week by Royal Mail](url)', '£0.00',
    '* [Star Wars: Shadow Of Maul #5](url)', 'Dispatched', '   * [Dispatched 2 weeks, 3 days by Royal Mail](url)', '£3.30',
    '* [Star Wars: Galaxy\'s Edge: Echoes Of The Empire #4 (Giuseppe Camuncoli Variant)](url)', 'Dispatched', '   * [Dispatched 1 week, 4 days by Royal Mail](url)', '£3.30',
    '* [Star Wars: Galaxy\'s Edge: Echoes Of The Empire #4](url)', 'Dispatched', '   * [Dispatched 1 week, 4 days by Royal Mail](url)', '£3.30',
    '* [Star Wars: Galaxy\'s Edge: Echoes Of The Empire #4 (Leinil Yu Han Solo Variant)](url)', 'Dispatched', '   * [Dispatched 1 week, 4 days by Royal Mail](url)', '£3.30',
  ].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 5);
  assert.ok(items.every(i => i.shipping === 0.8));
});
test('an order-history LIST page never has a postage line, so items stay with no shipping figure at all', () => {
  const text = ['Order#54573614', '* [Some Comic](url)', 'Pre-Order', 'Release date: 12 Aug 2026', 'Not charged', '£3.30'].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].shipping, undefined);
});
test('real order-detail page: an order that genuinely shipped in two separate parcels on different dates splits each parcel\'s own postage across only the items that physically travelled in it, using the dispatch links to tell which items shipped together - not diluted evenly across the whole order, and a cancelled item in the mix gets no shipping and does not count toward either parcel', () => {
  const text = [
    'Order #54208970', 'Confirmed on: 22 Aug 2025, 10:39 p.m.',
    'Order Summary', '* Items£65.39', '* PostageEstimated 2 shipments',
    'One package with 11 items already shipped!5.99',
    'One package with 6 items already shipped!5.99',
    '£11.98', '* Total£77.37',
    'Item List',
    '* [Item A1](url)', 'Dispatched', '   * [Dispatched 11 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3372397/)', '£1.49',
    '* [Item A2](url)', 'Dispatched', '   * [Dispatched 11 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3372397/)', '£1.49',
    '* [Item A3](url)', 'Dispatched', '   * [Dispatched 11 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3372397/)', '£1.79',
    '* [Item A4](url)', 'Dispatched', '   * [Dispatched 11 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3372397/)', '£1.49',
    '* [Cancelled Item](url)', 'Cancelled', '   * ', '£1.49',
    '* [Item A5](url)', 'Dispatched', '   * [Dispatched 11 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3372397/)', '£2.65',
    '* [Item A6](url)', 'Dispatched', '   * [Dispatched 11 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3372397/)', '£2.65',
    '* [Item A7](url)', 'Dispatched', '   * [Dispatched 11 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3372397/)', '£2.65',
    '* [Item A8](url)', 'Dispatched', '   * [Dispatched 11 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3372397/)', '£2.65',
    '* [Item A9](url)', 'Dispatched', '   * [Dispatched 11 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3372397/)', '£9.99',
    '* [Item A10](url)', 'Dispatched', '   * [Dispatched 11 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3372397/)', '£2.65',
    '* [Item A11](url)', 'Dispatched', '   * [Dispatched 11 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3372397/)', '£2.65',
    '* [Item B1](url)', 'Dispatched', '   * [Dispatched 10 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3392010/)', '£2.65',
    '* [Item B2](url)', 'Dispatched', '   * [Dispatched 10 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3392010/)', '£2.65',
    '* [Item B3](url)', 'Dispatched', '   * [Dispatched 10 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3392010/)', '£2.65',
    '* [Item B4](url)', 'Dispatched', '   * [Dispatched 10 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3392010/)', '£19.99',
    '* [Item B5](url)', 'Dispatched', '   * [Dispatched 10 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3392010/)', '£2.65',
    '* [Item B6](url)', 'Dispatched', '   * [Dispatched 10 months by Royal Mail](https://forbiddenplanet.com/orders/dispatch/3392010/)', '£2.65',
  ].join('\n');
  const items = parseForbiddenPlanetOrders(text);
  assert.equal(items.length, 18);
  const cancelled = items.find(i => i.name === 'Cancelled Item');
  assert.equal(cancelled.shipping, undefined);
  const groupA = items.filter(i => i.name.startsWith('Item A'));
  const groupB = items.filter(i => i.name.startsWith('Item B'));
  assert.equal(groupA.length, 11);
  assert.equal(groupB.length, 6);
  assert.ok(groupA.every(i => i.shipping === 0.54));
  assert.ok(groupB.every(i => i.shipping === 1));
});

console.log('looksLikeEbay');
test('detects a real eBay order page', () => {
  const text = ['Order info', 'Order number', '25-14854-15851', 'Item number: 365660456970'].join('\n');
  assert.equal(looksLikeEbay(text), true);
});
test('does not misdetect a Forbidden Planet paste', () => {
  const text = 'Order #54573614\nConfirmed on: 22 May 2026';
  assert.equal(looksLikeEbay(text), false);
});

console.log('parseEbayOrders (real pasted samples)');
test('real single-item delivered order: correct name, price, dates, seller, tracking', () => {
  const text = [
    'Order info', 'Time placed', '10 Jul 2026 at 3:58 PM', 'Order number', '25-14854-15851',
    'Total', '£27.73 (1 item)', 'Sold by', '[abelganz](https://www.ebay.co.uk/usr/abelganz)',
    'Delivery info', 'Delivered on Mon, 13 Jul 2026',
    'Paid', '10 Jul-Paid on 10 July',
    'Delivered', '13 Jul-Delivered on 13 July',
    'Tracking details', 'Number', 'VU284465267GB', 'Track package',
    'Item details', '',
    '* [Star Wars: The Clone Wars #3 2008 NM 3rd appearance Ahsoka Tano in comic books](https://www.ebay.co.uk/itm/365660456970)',
    '£27.44Unit price £27.44', 'Item number: 365660456970', 'incl. £1.45 for', 'Buyer Protection',
    '[Buy again](https://order.ebay.co.uk/ord/target?listingId=365660456970)', 'More actions',
  ].join('\n');
  const items = parseEbayOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Star Wars: The Clone Wars #3 2008 NM 3rd appearance Ahsoka Tano in comic books');
  assert.equal(items[0].price, 27.44);
  assert.equal(items[0].release_date, '2026-07-13');
  assert.equal(items[0].placed_date, '2026-07-10');
  assert.equal(items[0].shop, 'eBay - abelganz');
  assert.equal(items[0].order_number, '25-14854-15851');
  assert.equal(items[0].status, 'dispatched');
  assert.equal(items[0].charge_status, 'charged');
  assert.equal(items[0].tracking_number, 'VU284465267GB');
});
test('real multi-item order: every item shares the same order metadata, "Buy again" links never mistaken for items', () => {
  const text = [
    'Order info', 'Time placed', '20 May 2026 at 2:33 PM', 'Order number', '05-14670-88317',
    'Total', '£36.45 (8 items)', 'Sold by', '[sad_lemon_comics](https://www.ebay.co.uk/usr/sad_lemon_comics)',
    'Delivery info', 'Delivered on Fri, 29 May 2026',
    'Paid', '20 May-Paid on 20 May',
    'Delivered', '29 May-Delivered on 29 May',
    'Tracking details', 'Number', 'IV162746197GB', 'Track package',
    'Item details', '',
    '* [STAR WARS HIDDEN EMPIRE #1 (OF 5) (16/11/2022)](https://www.ebay.co.uk/itm/265935943724)',
    '£3.95Unit price £3.95', 'Item number: 265935943724', 'Return window closed on 28 Jun 2026.',
    'incl.', 'Buyer Protection', '[Buy again](https://order.ebay.co.uk/ord/target?listingId=265935943724)', 'More actions',
    '* [STAR WARS MANDALORIAN SEASON 2 #5 (11/10/2023)](https://www.ebay.co.uk/itm/266404822364)',
    '£3.95Unit price £3.95', 'Item number: 266404822364',
    '* [STAR WARS VISIONS TAKASHI OKAZAKI #1 PEACH MOMOKO VARIANT (20/03/2024)](https://www.ebay.co.uk/itm/266678205711)',
    '£4.90Unit price £4.90', 'Item number: 266678205711',
  ].join('\n');
  const items = parseEbayOrders(text);
  assert.equal(items.length, 3);
  assert.ok(items.every(i => i.order_number === '05-14670-88317'));
  assert.ok(items.every(i => i.shop === 'eBay - sad_lemon_comics'));
  assert.ok(!items.some(i => i.name.toLowerCase().includes('buy again')));
  assert.equal(items[2].name, 'STAR WARS VISIONS TAKASHI OKAZAKI #1 PEACH MOMOKO VARIANT (20/03/2024)');
});
test('real untracked, not-yet-delivered order: falls back to placed_date, no tracking number, still marked paid', () => {
  const text = [
    'Order info', 'Time placed', '3 Feb 2026 at 8:26 PM', 'Order number', '16-14181-35332',
    'Total', '£5.65 (1 item)', 'Sold by', '[ace_auctions_uk](https://www.ebay.co.uk/usr/ace_auctions_uk)',
    'Delivery info', '', 'Paid', '3 Feb-Paid on 3 February',
    'Dispatched (Untracked)', '4 Feb-Dispatched on 4 February',
    'Tracking details', 'Postal service', 'Royal Mail 2nd Class Large Letter', 'Courier', 'Royal Mail',
    'Item details',
    '   * [STAR WARS JEDI KNIGHTS (2025) #5 TAO Variant - New Bagged (S)](https://www.ebay.co.uk/itm/317065913953)',
    '£5.45Unit price £5.45', 'Item number: 317065913953',
  ].join('\n');
  const items = parseEbayOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].release_date, '2026-02-03');
  assert.equal(items[0].status, 'preorder');
  assert.equal(items[0].charge_status, 'charged');
  assert.equal(items[0].tracking_number, null);
});
test('a bare "Delivered" upcoming-step label does not count as actually delivered', () => {
  const text = [
    'Order info', 'Time placed', '3 Feb 2026 at 8:26 PM', 'Order number', '16-14181-35330',
    'Total', '£5.40 (1 item)', 'Sold by', '[a-place-in-space](https://www.ebay.co.uk/usr/a-place-in-space)',
    'Delivery info', '', 'Paid', '3 Feb-Paid on 3 February',
    'Delivered', '-Upcoming step, Delivered',
    'Tracking details', 'Number', '3201594730006FB8C3830',
    'Item details',
    '   * [STAR WARS: JEDI KNIGHTS #1G - DAN JURGENS CLASSIC HOMAGE VARIANT (WK10)](https://www.ebay.co.uk/itm/388032823045)',
    '£5.40Unit price £5.40', 'Item number: 388032823045',
  ].join('\n');
  const items = parseEbayOrders(text);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'preorder');
  assert.equal(items[0].release_date, '2026-02-03');
});
test('real paste with three separate orders concatenated: splits correctly, no cross-contamination between sellers/dates', () => {
  const text = [
    '* Order info', 'Time placed', '3 Feb 2026 at 8:26 PM', 'Order number', '16-14181-35330',
    'Total', '£5.40 (1 item)', 'Sold by', '[a-place-in-space](https://www.ebay.co.uk/usr/a-place-in-space)',
    'Item details',
    '   * [First Seller Item](https://www.ebay.co.uk/itm/1)',
    '£5.40Unit price £5.40', 'Item number: 1',
    '* Order info', 'Time placed', '3 Feb 2026 at 8:26 PM', 'Order number', '16-14181-35331',
    'Total', '£12.81 (1 item)', 'Sold by', '[books--etc](https://www.ebay.co.uk/usr/books--etc)',
    'Delivered on Sat, 7 Feb 2026',
    'Item details',
    '   * [Second Seller Item](https://www.ebay.co.uk/itm/2)',
    '£12.81Unit price £12.81', 'Item number: 2',
  ].join('\n');
  const items = parseEbayOrders(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].shop, 'eBay - a-place-in-space');
  assert.equal(items[0].order_number, '16-14181-35330');
  assert.equal(items[1].shop, 'eBay - books--etc');
  assert.equal(items[1].order_number, '16-14181-35331');
  assert.equal(items[1].release_date, '2026-02-07');
});
test('a non-GBP order is skipped entirely rather than guessed at with the wrong currency', () => {
  const text = [
    'Order info', 'Time placed', '6 Feb 2026 at 8:05 PM', 'Order number', '14-14197-46739',
    'Total', 'US $70.77 (1 item)', 'Sold by', '[replica2618](https://www.ebay.co.uk/usr/replica2618)',
    'Item details',
    '   * [STAR WARS: LEGACY OF VADER #8 JOHN GIANG NYCC 2025 EXCLUSIVE SECRET DROP LTD 500](https://www.ebay.co.uk/itm/257168534228)',
    'US $49.99Unit price US $49.99', 'Item number: 257168534228',
  ].join('\n');
  assert.equal(parseEbayOrders(text).length, 0);
});
test('the real raw paste-box text has no markdown links at all - tab-separated headers, and each item name appears twice as bare text (thumbnail + title) rather than a bracketed link', () => {
  const text = [
    '', 'Order info', 'Time placed\t30 Apr 2026 at 12:19 PM', 'Order number\t20-14558-40098',
    'Total\t£22.39 (2 items)', 'Sold by\tretro_gamer1986',
    'Delivery info', 'Delivered on Fri, 8 May 2026',
    'Paid', '30 Apr-Paid on 30 April',
    'Delivered', '8 May-Delivered on 8 May',
    'Tracking details', 'Number\tH05QTA0228700527', 'Track package',
    'Item details',
    'Star Wars The Old Republic #1 2010 Dark Horse Threat of Peace Comic Book NM',
    'Star Wars The Old Republic #1 2010 Dark Horse Threat of Peace Comic Book NM',
    '£9.60Unit price £9.60', 'Item number: 267628574336', 'incl. £0.61 for', 'Buyer Protection',
    'Buy again', 'More actions',
    'Star Wars The Old Republic #1 | The Lost Suns Part 1  (Of 5) Dark Horse Comics',
    'Star Wars The Old Republic #1 | The Lost Suns Part 1 (Of 5) Dark Horse Comics',
    '£9.60Unit price £9.60', 'Item number: 267628580541', 'incl. £0.61 for', 'Buyer Protection',
    'Buy again', 'More actions',
    'Other actions', 'View invoiceContact seller',
    'Delivery address', 'Kerry Draper',
  ].join('\n');
  const items = parseEbayOrders(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Star Wars The Old Republic #1 2010 Dark Horse Threat of Peace Comic Book NM');
  assert.equal(items[0].price, 9.60);
  assert.equal(items[0].shop, 'eBay - retro_gamer1986');
  assert.equal(items[0].order_number, '20-14558-40098');
  assert.equal(items[0].tracking_number, 'H05QTA0228700527');
  assert.equal(items[0].release_date, '2026-05-08');
  assert.equal(items[1].name, 'Star Wars The Old Republic #1 | The Lost Suns Part 1 (Of 5) Dark Horse Comics');
  assert.equal(items[1].price, 9.60);
});
test('real single-order paste: the exact postage line from eBay\'s own payment breakdown splits evenly across the order\'s items, without pulling in VAT', () => {
  const text = [
    'Order info', 'Time placed\t30 Apr 2026 at 12:19 PM', 'Order number\t20-14558-40098',
    'Total\t£22.39 (2 items)', 'Sold by\tretro_gamer1986',
    'Delivery info', 'Delivered on Fri, 8 May 2026',
    'Item details',
    'Star Wars The Old Republic #1', 'Star Wars The Old Republic #1',
    '£9.60Unit price £9.60', 'Item number: 267628574336',
    'Star Wars The Old Republic #1 Part 2', 'Star Wars The Old Republic #1 Part 2',
    '£9.60Unit price £9.60', 'Item number: 267628580541',
    'Delivery address', 'Kerry Draper',
    '£22.39', '30 Apr at 12:19 PM', '2 items', '£19.20',
    'Standard tracked delivery', '£2.45', 'VAT *', '£0.74', 'Order total', '£22.39',
  ].join('\n');
  const items = parseEbayOrders(text);
  assert.equal(items.length, 2);
  assert.ok(items.every(i => i.shipping === 1.23 || i.shipping === 1.22));
});
test('a paste with several separate orders never gets a postage figure attached - the trailing summary is a combined total across every order, not per-order, so there is no safe order to attribute it to', () => {
  const text = [
    '* Order info', 'Time placed\t3 Feb 2026 at 8:26 PM', 'Order number\t16-14181-35330',
    'Total\t£5.40 (1 item)', 'Sold by\ta-place-in-space',
    'Item details', 'First item', 'First item', '£5.40Unit price £5.40', 'Item number: 1',
    '* Order info', 'Time placed\t3 Feb 2026 at 8:26 PM', 'Order number\t16-14181-35331',
    'Total\t£12.81 (1 item)', 'Sold by\tbooks--etc',
    'Item details', 'Second item', 'Second item', '£12.81Unit price £12.81', 'Item number: 2',
    'Delivery address', 'Kerry Draper',
    '£18.21', '3 Feb at 8:26 PM', '2 items', '£18.01', 'Postage', '£0.20', 'Order total', '£18.21',
  ].join('\n');
  const items = parseEbayOrders(text);
  assert.equal(items.length, 2);
  assert.ok(items.every(i => i.shipping === undefined));
});

console.log('parseGenericOrder');
test('basic Shopify-style order: order number, total, shipping, and both items extracted; subtotal/shipping/total lines never mistaken for item prices', () => {
  const text = [
    'Order Number: #12345', '', 'Line Items', 'Amazing Comic #1 £4.99', 'Another Comic £3.50', '',
    'Subtotal: £8.49', 'Shipping: £2.50', 'Total: £10.99',
  ].join('\n');
  const result = parseGenericOrder(text);
  assert.equal(result.order_number, '12345');
  assert.equal(result.declared_total, 10.99);
  assert.equal(result.shipping, 2.50);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].name, 'Amazing Comic #1');
  assert.equal(result.items[0].price, 4.99);
  assert.equal(result.items[1].name, 'Another Comic');
  assert.equal(result.items[1].price, 3.50);
});
test('an exact release date wrapped in parens is fully removed from the name and parsed as a real date', () => {
  const text = [
    'Order Number: 98765', '', 'Items Ordered', 'Cool Comic (Release Date: 15th September 2026) £4.50', '', 'Total: £4.50',
  ].join('\n');
  const result = parseGenericOrder(text);
  assert.equal(result.order_number, '98765');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, 'Cool Comic');
  assert.equal(result.items[0].release_date, '2026-09-15');
});
test('an informal note in parens ("expected September") is recognised and stripped from the name, without inventing a release date it does not actually give', () => {
  const text = [
    'Order Ref: ABC-99', '', 'Order Details', 'Neat Comic (expected September) £5.00', '', 'Total: £5.00',
  ].join('\n');
  const result = parseGenericOrder(text);
  assert.equal(result.order_number, 'ABC-99');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, 'Neat Comic');
  assert.equal(result.items[0].release_date, null);
  assert.equal(result.items[0].note, 'expected September');
});
test('recognises $ and other currency signs, not just £', () => {
  const text = ['Order ID: 555', '', 'Widget Thing $9.99', 'Total $9.99'].join('\n');
  const result = parseGenericOrder(text);
  assert.equal(result.order_number, '555');
  assert.equal(result.declared_total, 9.99);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].price, 9.99);
});
test('returns no items and no order number for text with no prices at all, rather than guessing', () => {
  const result = parseGenericOrder('Just some ordinary text with no prices in it.');
  assert.equal(result.items.length, 0);
  assert.equal(result.order_number, null);
  assert.equal(result.declared_total, null);
});

console.log('findUpcomingReleases');
test('returns the next N upcoming releases, soonest first, excluding past and cancelled', () => {
  const ref = new Date('2026-07-30T00:00:00Z');
  const items = [
    { id: 1, name: 'Past', status: 'preorder', release_date: '2026-07-25' },
    { id: 2, name: 'Today', status: 'preorder', release_date: '2026-07-30' },
    { id: 3, name: 'Soon', status: 'preorder', release_date: '2026-08-02' },
    { id: 4, name: 'Later', status: 'preorder', release_date: '2026-08-05' },
    { id: 5, name: 'CancelledSoon', status: 'cancelled', release_date: '2026-08-01' },
  ];
  const result = findUpcomingReleases(items, ref, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Today');
  assert.equal(result[0].daysUntilLabel, 'Today');
  assert.equal(result[1].name, 'Soon');
  assert.equal(result[1].daysUntilLabel, '3 days');
});

console.log('computeAvgVsPriciestIssuePct');
test('computes average issue as a percentage of the priciest one', () => {
  const items = [
    { status: 'preorder', price: 10 },
    { status: 'preorder', price: 20 },
  ];
  assert.equal(computeAvgVsPriciestIssuePct(items), 75);
});
test('returns 0 with no items', () => {
  assert.equal(computeAvgVsPriciestIssuePct([]), 0);
});

console.log('computeAllTimeComicsVsShippingSplit');
test('splits comics vs shipping totals and percentages correctly', () => {
  const items = [
    { status: 'preorder', price: 80, shipping: 20 },
  ];
  const result = computeAllTimeComicsVsShippingSplit(items);
  assert.equal(result.comicsTotal, 80);
  assert.equal(result.shippingTotal, 20);
  assert.equal(result.comicsPct, 80);
  assert.equal(result.shippingPct, 20);
});
test('excludes cancelled items from the split', () => {
  const items = [
    { status: 'preorder', price: 10, shipping: 0 },
    { status: 'cancelled', price: 999, shipping: 999 },
  ];
  const result = computeAllTimeComicsVsShippingSplit(items);
  assert.equal(result.comicsTotal, 10);
});

console.log('computeWeekdayReleaseChart');
test('returns real per-weekday counts with the busiest day at 100%', () => {
  const items = [
    { status: 'preorder', release_date: '2026-07-08' }, // Wednesday
    { status: 'preorder', release_date: '2026-07-15' }, // Wednesday
    { status: 'preorder', release_date: '2026-07-13' }, // Monday
  ];
  const chart = computeWeekdayReleaseChart(items);
  assert.equal(chart.length, 7);
  const wed = chart.find(d => d.label === 'Wed');
  const mon = chart.find(d => d.label === 'Mon');
  assert.equal(wed.count, 2);
  assert.equal(wed.barPct, 100);
  assert.equal(wed.isBusiest, true);
  assert.equal(mon.count, 1);
  assert.equal(mon.barPct, 50);
  assert.equal(mon.isBusiest, false);
});
test('a day with no releases has 0% and is not marked busiest', () => {
  const chart = computeWeekdayReleaseChart([{ status: 'preorder', release_date: '2026-07-08' }]);
  const sun = chart.find(d => d.label === 'Sun');
  assert.equal(sun.count, 0);
  assert.equal(sun.barPct, 0);
});

console.log('computePriceCreep');
test('flags a series whose price has genuinely risen, sorted by biggest increase', () => {
  const items = [
    { name: 'Star Wars: Jedi Knights #1', status: 'preorder', price: 3.99, release_date: '2026-01-05' },
    { name: 'Star Wars: Jedi Knights #2', status: 'preorder', price: 3.99, release_date: '2026-03-05' },
    { name: 'Star Wars: Jedi Knights #3', status: 'preorder', price: 4.60, release_date: '2026-06-05' },
  ];
  const result = computePriceCreep(items);
  assert.equal(result.length, 1);
  assert.equal(result[0].series, 'Star Wars: Jedi Knights');
  assert.equal(result[0].firstPrice, 3.99);
  assert.equal(result[0].latestPrice, 4.60);
  assert.equal(result[0].issueCount, 3);
});
test('does not flag a series with a flat price', () => {
  const items = [
    { name: 'Dune: Edge Of A Crysknife #1', status: 'preorder', price: 3.71, release_date: '2026-01-05' },
    { name: 'Dune: Edge Of A Crysknife #2', status: 'preorder', price: 3.71, release_date: '2026-03-05' },
  ];
  assert.equal(computePriceCreep(items).length, 0);
});
test('a one-shot with no repeating series just has nothing to compare, not an error', () => {
  const items = [{ name: 'Star Wars: Shadow Of Maul #1', status: 'preorder', price: 5.99, release_date: '2026-01-05' }];
  assert.equal(computePriceCreep(items).length, 0);
});

console.log('computeOrderShippingTotals');
test('sums per-item shares back into a real order total, regardless of how many items', () => {
  const items = [
    { order_number: 'ORD1', shipping: 2.00 },
    { order_number: 'ORD1', shipping: 2.00 },
    { order_number: 'ORD1', shipping: 2.00 },
  ];
  const totals = computeOrderShippingTotals(items);
  assert.equal(totals.get('ORD1'), 6.00);
});
test('handles a multi-parcel order where shares differ per shipment', () => {
  const items = [
    { order_number: 'ORD2', shipping: 5.99 }, // parcel 1, 1 item
    { order_number: 'ORD2', shipping: 3.00 }, // parcel 2, split across 2
    { order_number: 'ORD2', shipping: 3.00 },
  ];
  const totals = computeOrderShippingTotals(items);
  assert.equal(totals.get('ORD2'), 11.99);
});
test('ignores items with no order number or no shipping figure', () => {
  const items = [
    { order_number: null, shipping: 5.00 },
    { order_number: 'ORD3', shipping: null },
    { order_number: 'ORD3', shipping: 2.50 },
  ];
  const totals = computeOrderShippingTotals(items);
  assert.equal(totals.size, 1);
  assert.equal(totals.get('ORD3'), 2.50);
});

console.log('computeShippingEstimate');
test('averages real samples once there are at least 3, matching the webui\'s exact tier', () => {
  const result = computeShippingEstimate([3.99, 4.50, 5.00]);
  assert.equal(result.tier, 'exact');
  assert.equal(result.rate, 4.50);
  assert.equal(result.samples, 3);
});
test('falls back to the default rate with fewer than 3 real samples', () => {
  const result = computeShippingEstimate([3.99, 4.50]);
  assert.equal(result.tier, 'default');
  assert.equal(result.rate, 4.00);
  assert.equal(result.samples, 2);
});
test('falls back to the default rate with zero real samples', () => {
  const result = computeShippingEstimate([]);
  assert.equal(result.tier, 'default');
  assert.equal(result.rate, 4.00);
});
test('a custom default rate is respected', () => {
  const result = computeShippingEstimate([], [], 5.50);
  assert.equal(result.rate, 5.50);
});
test('uses the calibrated tier when there are 3+ calibrated samples but fewer than 3 exact ones', () => {
  const result = computeShippingEstimate([], [3.00, 4.00, 5.00]);
  assert.equal(result.tier, 'calibrated');
  assert.equal(result.rate, 4.00);
});
test('exact samples still win over calibrated ones when both exist', () => {
  const result = computeShippingEstimate([6.00, 6.00, 6.00], [1.00, 1.00, 1.00]);
  assert.equal(result.tier, 'exact');
  assert.equal(result.rate, 6.00);
});

console.log('extractFpDeclaredTotals (real pasted samples)');
test('extracts the declared Total from the same real order-history sample used above (inline "Total£X.XX" format)', () => {
  const text = [
    'Placed29 Jun 2026',
    'Order#[54621806](https://forbiddenplanet.com/orders/54621806/)',
    'Total£55.99',
    'Delivery ToCallum Draper /NG7 5FZ',
    'Billing', 'Debit MasterCard', 'Ends: 4929', 'Exp: 10/2027',
    '',
    '* [Star Wars: The High Republic Adventures: Pathfinders #6 (Cover A Jake Bartok)](https://forbiddenplanet.com/orders/)',
    'Pre-Order (Will ship once we receive stock)',
    '   * Release date: 21 Oct 2026',
    '   * Not charged',
    '£3.30',
  ].join('\n');
  const totals = extractFpDeclaredTotals(text);
  assert.equal(totals.get('54621806'), 55.99);
});
test('also handles "Total" alone on its own line with the price on the next line', () => {
  const text = [
    'Order#[12345](https://forbiddenplanet.com/orders/12345/)',
    'Total',
    '£19.99',
  ].join('\n');
  const totals = extractFpDeclaredTotals(text);
  assert.equal(totals.get('12345'), 19.99);
});
test('multiple orders in one paste each get their own declared total', () => {
  const text = [
    'Order#[111](url)',
    'Total£10.00',
    'Order#[222](url)',
    'Total£20.00',
  ].join('\n');
  const totals = extractFpDeclaredTotals(text);
  assert.equal(totals.get('111'), 10.00);
  assert.equal(totals.get('222'), 20.00);
});
test('a Total appearing before any order number is ignored rather than misattributed', () => {
  const text = ['Total£99.99', 'Order#[333](url)'].join('\n');
  const totals = extractFpDeclaredTotals(text);
  assert.equal(totals.size, 0);
});
test('returns an empty map for text with no Total lines at all', () => {
  const totals = extractFpDeclaredTotals('Order#[444](url)\nSome other text');
  assert.equal(totals.size, 0);
});

console.log('computeCalibratedShippingSamples');
test('backs out an implied shipping figure from a declared total minus item prices', () => {
  const orders = [{ order_number: 'ORD1', declared_total: 25.00 }];
  const items = [
    { order_number: 'ORD1', shop: 'Forbidden Planet', price: 10.00, release_date: '2026-07-08' },
    { order_number: 'ORD1', shop: 'Forbidden Planet', price: 10.00, release_date: '2026-07-08' },
  ];
  // declared 25.00 - items 20.00 = 5.00 implied shipping, 1 distinct date
  const samples = computeCalibratedShippingSamples(orders, items);
  assert.deepEqual(samples, [5.00]);
});
test('splits the implied total across distinct release dates (likely separate parcels)', () => {
  const orders = [{ order_number: 'ORD2', declared_total: 30.00 }];
  const items = [
    { order_number: 'ORD2', shop: 'Forbidden Planet', price: 10.00, release_date: '2026-07-08' },
    { order_number: 'ORD2', shop: 'Forbidden Planet', price: 10.00, release_date: '2026-08-15' },
  ];
  // declared 30 - items 20 = 10 implied, split across 2 distinct dates = 5.00 each
  const samples = computeCalibratedShippingSamples(orders, items);
  assert.deepEqual(samples, [5.00]);
});
test('only considers Forbidden Planet items, matching the webui restriction', () => {
  const orders = [{ order_number: 'ORD3', declared_total: 20.00 }];
  const items = [{ order_number: 'ORD3', shop: 'eBay', price: 10.00, release_date: '2026-07-08' }];
  assert.equal(computeCalibratedShippingSamples(orders, items).length, 0);
});
test('excludes an implausibly high implied shipping figure (a bad declared total)', () => {
  const orders = [{ order_number: 'ORD4', declared_total: 100.00 }];
  const items = [{ order_number: 'ORD4', shop: 'Forbidden Planet', price: 5.00, release_date: '2026-07-08' }];
  // implied = 95.00, way over the 15.00 plausibility cap
  assert.equal(computeCalibratedShippingSamples(orders, items).length, 0);
});
test('excludes an order where the declared total is less than or equal to the items (no real shipping implied)', () => {
  const orders = [{ order_number: 'ORD5', declared_total: 10.00 }];
  const items = [{ order_number: 'ORD5', shop: 'Forbidden Planet', price: 10.00, release_date: '2026-07-08' }];
  assert.equal(computeCalibratedShippingSamples(orders, items).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
