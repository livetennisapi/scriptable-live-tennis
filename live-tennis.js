// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-green; icon-glyph: circle;
//
// live-tennis.js — Live tennis scores widget for Scriptable (iOS)
// https://github.com/livetennisapi/scriptable-live-tennis
//
// Data: Live Tennis API (https://livetennisapi.com) — free key, no card:
// https://livetennisapi.com/subscribe/free
//
// Setup:
//   1. Get a free API key (link above).
//   2. Add this script to Scriptable.
//   3. Add a Scriptable widget to your home screen, long-press it,
//      "Edit Widget", pick this script, and put your API key in the
//      "Parameter" field — either "lt_yourkey" or "lt_yourkey,atp"
//      to filter one tour (atp | wta | challenger | itf | juniors).
//   Alternatively, paste the key into API_KEY below.

// ======================= CONFIGURATION =======================

// >>> PUT YOUR API KEY HERE if you don't want to use the widget
// >>> parameter. The widget parameter, when set, wins over this.
const API_KEY = "";

// Optional tour filter used when no ",tour" suffix is given in the
// widget parameter: "" (all) | "atp" | "wta" | "challenger" | "itf" | "juniors"
const TOUR = "";

// Minutes between widget refreshes. 15 min ≈ 96 refreshes/day, which
// fits the free tier's 100 requests/day (see README for the math).
// Values below 15 are raised to 15 to keep that promise.
const REFRESH_MINUTES = 15;

// How long a fetched fixtures list stays fresh. The fixtures fallback
// only fires when nothing is live, and reusing it for hours keeps the
// worst-case daily call count inside the free tier.
const FIXTURES_CACHE_MINUTES = 360;

// How many matches to show per widget size.
const MATCH_LIMIT = { small: 1, medium: 2, large: 5 };

// ====================== END CONFIGURATION ====================

const BASE_URL = "https://api.livetennisapi.com/api/public/v1";
const VALID_TOURS = ["atp", "wta", "challenger", "itf", "juniors"];

const COLORS = {
  bg: Color.dynamic(new Color("#ffffff"), new Color("#1c1c1e")),
  text: Color.dynamic(new Color("#111111"), new Color("#f2f2f7")),
  secondary: Color.dynamic(new Color("#6e6e73"), new Color("#98989d")),
  live: new Color("#e8443a"),
  accent: Color.dynamic(new Color("#0a7a3d"), new Color("#37c871")),
  bp: new Color("#e8a23a"),
};

// ---------- parameter handling ----------

function readConfig() {
  let key = API_KEY;
  let tour = TOUR;
  const param = args.widgetParameter;
  if (param && param.trim()) {
    const parts = param.split(",").map((p) => p.trim());
    if (parts[0]) key = parts[0];
    if (parts[1]) tour = parts[1].toLowerCase();
  }
  if (tour && !VALID_TOURS.includes(tour)) tour = "";
  return { key, tour };
}

// ---------- caching (FileManager) ----------

const fm = FileManager.local();
const cacheDir = fm.joinPath(fm.cacheDirectory(), "live-tennis-widget");
if (!fm.fileExists(cacheDir)) fm.createDirectory(cacheDir, true);

function cachePath(name) {
  return fm.joinPath(cacheDir, `${name}.json`);
}

function cacheWrite(name, data) {
  try {
    fm.writeString(cachePath(name), JSON.stringify({ t: Date.now(), data }));
  } catch (e) {
    // A failed cache write only costs us the fallback; ignore.
  }
}

function cacheRead(name) {
  const path = cachePath(name);
  if (!fm.fileExists(path)) return null;
  try {
    return JSON.parse(fm.readString(path));
  } catch (e) {
    return null;
  }
}

function cacheAgeMinutes(entry) {
  return Math.round((Date.now() - entry.t) / 60000);
}

// ---------- API ----------

async function apiGet(key, path) {
  const req = new Request(BASE_URL + path);
  req.headers = { Authorization: `Bearer ${key}` };
  req.timeoutInterval = 15;
  const body = await req.loadString();
  const status = req.response ? req.response.statusCode : 0;
  let json = null;
  try {
    json = JSON.parse(body);
  } catch (e) {
    // handled below
  }
  if (status === 401) throw new Error("Invalid API key (401)");
  if (status === 429) throw new Error("Rate limited (429) — free tier is 100 calls/day");
  if (status < 200 || status >= 300 || !json) throw new Error(`API error (HTTP ${status})`);
  return json;
}

async function fetchLive(key, tour, limit) {
  let path = `/matches?status=live&limit=${limit}`;
  if (tour) path += `&tour=${tour}`;
  const json = await apiGet(key, path);
  return json.data || [];
}

async function fetchFixtures(key, tour, limit) {
  let path = `/fixtures?limit=${limit}`;
  if (tour) path += `&tour=${tour}`;
  const json = await apiGet(key, path);
  return json.data || [];
}

// ---------- score derivation (fields per the OpenAPI Score schema) ----------

// score.sets:   [sets_p1, sets_p2]
// score.games:  [games_p1[], games_p2[]] — per-set lists
// score.points: [p1, p2] tennis strings ("0","15","30","40","AD"), entries may be null
// score.server: 1 | 2 | null
function scoreView(score) {
  if (!score) return null;
  const sets = Array.isArray(score.sets) ? score.sets : [null, null];
  const games = Array.isArray(score.games) ? score.games : [[], []];
  const g1 = Array.isArray(games[0]) ? games[0] : [];
  const g2 = Array.isArray(games[1]) ? games[1] : [];
  const points = Array.isArray(score.points) ? score.points : [null, null];
  return {
    sets: [sets[0], sets[1]],
    curGames: [g1.length ? g1[g1.length - 1] : null, g2.length ? g2[g2.length - 1] : null],
    points: [points[0], points[1]],
    server: score.server === 1 || score.server === 2 ? score.server : null,
    tiebreak: !!score.is_tiebreak,
  };
}

// Break point, derived — never asserted when we can't know:
// the RECEIVER holds AD, or the receiver is at 40 while the server is
// below 40 ("0"/"15"/"30"). Never in a tiebreak, never when the server
// or either point value is unknown.
function isBreakPoint(view) {
  if (!view || view.tiebreak || view.server === null) return false;
  const receiver = view.server === 1 ? 2 : 1;
  const rp = view.points[receiver - 1];
  const sp = view.points[view.server - 1];
  if (rp === null || rp === undefined) return false;
  if (rp === "AD") return true;
  return rp === "40" && (sp === "0" || sp === "15" || sp === "30");
}

function fmtPoint(p) {
  return p === null || p === undefined ? "–" : String(p);
}

function fmtNum(n) {
  return n === null || n === undefined ? "–" : String(n);
}

function playerLabel(player) {
  if (!player || !player.name) return "Unknown";
  let label = player.name;
  if (player.ranking !== null && player.ranking !== undefined) {
    label += ` (#${player.ranking})`;
  }
  return label;
}

// ---------- widget rendering ----------

function makeWidget() {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.refreshAfterDate = new Date(Date.now() + Math.max(REFRESH_MINUTES, 15) * 60 * 1000);
  return w;
}

function family() {
  return config.widgetFamily || "medium";
}

function addHeader(w, label, dotColor) {
  const row = w.addStack();
  row.centerAlignContent();
  if (dotColor) {
    const dot = row.addText("●");
    dot.font = Font.boldSystemFont(9);
    dot.textColor = dotColor;
    row.addSpacer(4);
  }
  const t = row.addText(label);
  t.font = Font.boldSystemFont(11);
  t.textColor = COLORS.secondary;
  row.addSpacer();
}

function addPlayerRow(w, match, idx, view, compact) {
  const p = idx === 1 ? match.players && match.players.p1 : match.players && match.players.p2;
  const row = w.addStack();
  row.centerAlignContent();

  const name = row.addText(playerLabel(p));
  name.font = compact ? Font.mediumSystemFont(11) : Font.mediumSystemFont(12);
  name.textColor = COLORS.text;
  name.lineLimit = 1;

  if (view && view.server === idx) {
    row.addSpacer(3);
    const serve = row.addText("●");
    serve.font = Font.boldSystemFont(8);
    serve.textColor = COLORS.accent;
  }
  row.addSpacer();

  if (view) {
    const receiver = view.server === 1 ? 2 : 1;
    if (isBreakPoint(view) && idx === receiver) {
      const bp = row.addText("BP ");
      bp.font = Font.boldSystemFont(9);
      bp.textColor = COLORS.bp;
    }
    const nums = `${fmtNum(view.sets[idx - 1])}  ${fmtNum(view.curGames[idx - 1])}  ${
      view.tiebreak ? "TB " : ""
    }${fmtPoint(view.points[idx - 1])}`;
    const s = row.addText(nums);
    s.font = new Font("Menlo-Bold", compact ? 11 : 12);
    s.textColor = COLORS.text;
  }
}

function addMatchBlock(w, match, compact) {
  const view = scoreView(match.score);
  const label = [match.tournament, match.round].filter(Boolean).join(" · ");
  addHeader(w, label || "Live match", COLORS.live);
  w.addSpacer(2);
  addPlayerRow(w, match, 1, view, compact);
  w.addSpacer(1);
  addPlayerRow(w, match, 2, view, compact);
}

function renderLive(matches, stale) {
  const w = makeWidget();
  w.setPadding(12, 12, 12, 12);
  const compact = family() === "small";
  const limit = MATCH_LIMIT[family()] || 2;
  const shown = matches.slice(0, limit);

  shown.forEach((m, i) => {
    if (i > 0) w.addSpacer(8);
    addMatchBlock(w, m, compact);
  });
  w.addSpacer();
  addFooter(w, stale);
  return w;
}

function fmtFixtureTime(fx) {
  // start_time is null until the order of play assigns one — a real
  // state, not a gap; fall back to the date, then to "TBD".
  if (fx.start_time) {
    const d = new Date(fx.start_time);
    const df = new DateFormatter();
    df.dateFormat = "EEE HH:mm";
    return df.string(d);
  }
  if (fx.event_date) return fx.event_date;
  return "TBD";
}

function renderFixtures(fixtures, stale) {
  const w = makeWidget();
  w.setPadding(12, 12, 12, 12);
  addHeader(w, "No live matches — next up", null);
  w.addSpacer(4);

  const limit = family() === "small" ? 2 : family() === "large" ? 6 : 3;
  fixtures.slice(0, limit).forEach((fx) => {
    const row = w.addStack();
    row.centerAlignContent();
    const time = row.addText(fmtFixtureTime(fx));
    time.font = new Font("Menlo", 10);
    time.textColor = COLORS.accent;
    row.addSpacer(6);
    const names = `${fx.player1_name || "TBD"} v ${fx.player2_name || "TBD"}`;
    const t = row.addText(names);
    t.font = Font.mediumSystemFont(11);
    t.textColor = COLORS.text;
    t.lineLimit = 1;
    row.addSpacer();
    if (family() !== "small" && fx.tournament) {
      const tour = row.addText(fx.tournament);
      tour.font = Font.systemFont(9);
      tour.textColor = COLORS.secondary;
      tour.lineLimit = 1;
    }
    w.addSpacer(3);
  });
  w.addSpacer();
  addFooter(w, stale);
  return w;
}

function addFooter(w, stale) {
  const df = new DateFormatter();
  df.dateFormat = "HH:mm";
  const label = stale
    ? `offline — cached ${stale} min ago`
    : `updated ${df.string(new Date())}`;
  const t = w.addText(label);
  t.font = Font.systemFont(8);
  t.textColor = stale ? COLORS.bp : COLORS.secondary;
}

function renderMessage(title, lines) {
  const w = makeWidget();
  w.setPadding(14, 14, 14, 14);
  const t = w.addText(title);
  t.font = Font.boldSystemFont(13);
  t.textColor = COLORS.text;
  w.addSpacer(6);
  for (const line of lines) {
    const l = w.addText(line);
    l.font = Font.systemFont(10);
    l.textColor = COLORS.secondary;
    w.addSpacer(2);
  }
  w.addSpacer();
  return w;
}

// ---------- main ----------

async function main() {
  const { key, tour } = readConfig();

  if (!key) {
    return renderMessage("Live Tennis — no API key", [
      "1. Get a free key (no card):",
      "livetennisapi.com/subscribe/free",
      "2. Long-press widget → Edit Widget",
      "3. Put the key in Parameter",
    ]);
  }

  const liveCacheName = `live-${tour || "all"}`;
  const fixturesCacheName = `fixtures-${tour || "all"}`;

  let live = null;
  let fetchError = null;
  try {
    live = await fetchLive(key, tour, MATCH_LIMIT.large);
    cacheWrite(liveCacheName, live);
  } catch (e) {
    fetchError = e;
  }

  if (live && live.length > 0) return renderLive(live, null);

  if (live && live.length === 0) {
    // Nothing live: fall back to fixtures, served from cache for
    // FIXTURES_CACHE_MINUTES so quiet days stay inside the free tier.
    const cached = cacheRead(fixturesCacheName);
    if (cached && cacheAgeMinutes(cached) < FIXTURES_CACHE_MINUTES) {
      return renderFixtures(cached.data, null);
    }
    try {
      const fixtures = await fetchFixtures(key, tour, 10);
      cacheWrite(fixturesCacheName, fixtures);
      return renderFixtures(fixtures, null);
    } catch (e) {
      if (cached) return renderFixtures(cached.data, cacheAgeMinutes(cached));
      fetchError = e;
    }
  }

  // The live fetch (or the fixtures fallback) failed: show cached data
  // marked stale, or an in-widget error state.
  const cachedLive = cacheRead(liveCacheName);
  if (cachedLive && cachedLive.data && cachedLive.data.length > 0) {
    return renderLive(cachedLive.data, cacheAgeMinutes(cachedLive));
  }
  const cachedFixtures = cacheRead(fixturesCacheName);
  if (cachedFixtures && cachedFixtures.data && cachedFixtures.data.length > 0) {
    return renderFixtures(cachedFixtures.data, cacheAgeMinutes(cachedFixtures));
  }
  return renderMessage("Live Tennis — error", [
    String(fetchError && fetchError.message ? fetchError.message : fetchError || "Unknown error"),
    "Will retry on the next refresh.",
  ]);
}

const widget = await main();
Script.setWidget(widget);
if (!config.runsInWidget) {
  if (family() === "small") await widget.presentSmall();
  else if (family() === "large") await widget.presentLarge();
  else await widget.presentMedium();
}
Script.complete();
