![Ka-Ching!](readme-banner.png)

# Ka-Ching! App

The Android companion to [Ka-Ching!](https://github.com/callum87-Lab/Ka-Ching)
— a genuinely separate project from the self-hosted web app, built with
Capacitor so it runs as a real local-first app on your phone: its own local
SQLite database, its own order parsers, and no requirement to ever touch a
server at all. If you *do* run the web app too, the two sync — properly,
two-way, with real conflict resolution when both sides have changed the same
item — but syncing is optional, not a requirement to use the app.

Same philosophy as the web app: this doesn't track what you own or store
cover art. It answers what's due, what it'll cost, and what your forecast
looks like this month and next.

## Gallery

Click any screenshot to view it full-size.

<table>
<tr>
<th>Dashboard</th>
<th>Spend overview</th>
</tr>
<tr>
<td><a href="screenshots/dashboard.jpg"><img src="screenshots/dashboard.jpg" width="400"></a></td>
<td><a href="screenshots/spend-overview.jpg"><img src="screenshots/spend-overview.jpg" width="400"></a></td>
</tr>
<tr>
<th>Calendar</th>
<th>Insights</th>
</tr>
<tr>
<td><a href="screenshots/calendar.jpg"><img src="screenshots/calendar.jpg" width="400"></a></td>
<td><a href="screenshots/insights.jpg"><img src="screenshots/insights.jpg" width="400"></a></td>
</tr>
<tr>
<th>Sync with the web app</th>
</tr>
<tr>
<td><a href="screenshots/sync.jpg"><img src="screenshots/sync.jpg" width="400"></a></td>
</tr>
</table>

## What it actually does

- **Local-first, works entirely offline** — a real local SQLite database on
  the device, not a cache of something remote. Everything below works with
  no server connection at all.
- **Two-way sync with the web app** (optional) — push/pull with proper
  conflict detection when the same item's been changed on both sides since
  the last sync, a dedicated screen to resolve conflicts by hand, a
  first-time reconciliation pass when connecting an existing local dataset
  to an existing server dataset for the first time, and a *Force full
  resync* for when the two need to fully re-align from scratch.
- **Order parsers** — dedicated parsers for Forbidden Planet and eBay order
  pages (matching the web app's own), plus a generic parser for anything
  else: paste in text, get an editable review screen before anything's
  saved, same as the web app.
- **Shipping, properly modelled** — a real total per order/shipment rather
  than a flat guess, with the same tiered estimate the web app uses when
  exact postage isn't available (an average of your own real shipping costs
  for that shop, falling back to a flat default only when there's not
  enough real data yet).
- **Insights** — the same ring/card layout as the web app's own Insights
  page: pre-order vs released split, spend overview with a real trend badge
  (this month vs a genuine baseline, not hardcoded), per-issue stats,
  busiest release day, price-creep tracking (a series whose price keeps
  climbing issue to issue), top 3 most expensive, 12-month spend trend,
  spend by shop.
- **Dashboard** — still-due total, budget progress, next-month forecast,
  This Week / This Month browsable by shipment, a spend trend chart with
  Week / Month / 6M tabs.
- **Calendar** — a real month grid, tap a day to see what's on it.
- **Search** — text search, price range, status filter, tracking-number
  search, sort, CSV export.
- **Edit history** — field-level changes (old value → new value, when) are
  logged for anything edited by hand.
- **Backups** — CSV export for opening elsewhere, a separate JSON backup
  built for restoring back into the app.

## Building it

This is an Android app built with [Capacitor](https://capacitorjs.com/), not
a published store listing (yet — see below). To build it yourself:

```bash
git clone https://github.com/callum87-Lab/Ka-Ching-App
cd Ka-Ching-App
npm install
npm run sync
```

Then open the `android/` folder in Android Studio and either run it
straight to a connected device/emulator, or
**Build → Build Bundle(s)/APK(s) → Build APK(s)** for a standalone `.apk`.

### Updating an existing install

```bash
git pull
npm install
npm run sync
```

Then rebuild in Android Studio as above. If you're testing on a real
device with USB debugging on, Android Studio can install it directly; if
Android's own download scanning blocks a plain `.apk` transfer over
something like Nextcloud, that's a filename-based check on Google's end,
not anything wrong with the file — installing over USB via `adb install`
or Android Studio's own Run button both skip it entirely.

## Syncing with the web app

Point the app at your self-hosted Ka-Ching! server from Settings → Sync,
using the sync key generated there in the web app's own Settings page. The
two apps then push and pull changes, with the newer edit winning
automatically wherever that's unambiguous, and a real conflict screen for
anything that isn't.

## Privacy

Same commitment as the web app: no accounts, no analytics, no telemetry, no
external calls beyond whatever your own server address you point it at (and
even that's optional). Android's system-level Autofill Framework is
explicitly disabled in the manifest, since it would otherwise phone Google
on its own for suggestions on this app's own form fields — confirmed with
DNS-level monitoring that nothing leaves the device unless you've configured
sync yourself.

## Status

Feature-complete and in daily real-device use, not a prototype. Known gaps,
each intentionally deferred rather than half-built:

- Settings don't sync across devices yet (each install has its own budget,
  currency, sync target)
- Sync is manual ("Sync now" / "Force full resync"), not on a timer yet
- No Whatnot parser (no pasteable order-history source exists for it, only
  screenshots)
- Not yet on F-Droid or the Play Store — build it yourself for now, a
  GitHub Release with a downloadable `.apk` is the near-term plan

## AI involvement

Like the [web app](https://github.com/callum87-Lab/Ka-Ching), this was built
through heavy, iterative collaboration with an LLM (Claude). A lot of the
actual code came out of that process rather than being hand-typed line by
line — but every feature, every parser, and every decision about what this
should and shouldn't do was directed and made by a real person, not
generated and shipped unchecked.

In practice that meant: real bugs (including a long reconciliation effort to
get this app's spend figures to genuinely match the web app's, down to the
penny) were found and fixed through real-device testing and by re-deriving
numbers against actual data, not assumed away. Scope decisions — what this
app does and deliberately doesn't do, the licence, what got rejected outright
— were all real calls made by a person, not defaults left unquestioned.

Happy to go into more detail on the actual process if anyone's curious -
open an issue.

## Licence

All rights reserved, for now. This code is public on GitHub so you can read
it, learn from it, and see exactly what it does with your data - but there's
no open-source licence attached at the moment, so reusing, modifying, or
redistributing it isn't permitted without asking first. This is a deliberate
choice while it's actively maintained, not an oversight.

If time to maintain it actively becomes harder to find down the line, the
plan is to open it up properly under AGPL-3.0 - a licence that still allows
forks and contributions, but requires anyone who modifies and runs their own
version (including as a hosted service) to keep it open source too, rather
than it quietly becoming someone else's closed, rebranded product.
