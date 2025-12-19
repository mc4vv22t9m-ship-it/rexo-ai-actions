import express from "express";

const app = express();

/** -------------------------
 * Config
 * ------------------------- */
const FPL_BASE = process.env.FPL_BASE || "https://fantasy.premierleague.com/api";
const PORT = Number(process.env.PORT || 3000);

const BUILD_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  process.env.COMMIT_SHA ||
  "unknown";

const BUILD_TIME_UTC =
  process.env.BUILD_TIME_UTC ||
  process.env.RAILWAY_DEPLOYMENT_CREATED_AT ||
  new Date().toISOString();

const JSON_LIMIT = process.env.JSON_LIMIT || "256kb";

// Cache strategy:
// - TTL = fresh
// - stale fallback if upstream fails (prevents cascading failures in GPT Actions)
const TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000);
const STALE_MAX_MS = Number(process.env.CACHE_STALE_MAX_MS || 10 * 60_000); // 10 minutes

const CACHE = {
  bootstrap: { ts: 0, data: null },
  fixtures: { ts: 0, data: null }
};

const MODE = Object.freeze({
  meta: "meta",
  player_check: "player_check",
  fixtures: "fixtures",
  top_players: "top_players",
  market_scan: "market_scan",
  fh_draft: "fh_draft",
  snapshot: "snapshot"
});

// Must match OpenAPI metrics enum
const TOP_METRICS = new Set([
  "form",
  "points_per_game",
  "selected_by_percent",
  "minutes",
  "transfers_in_event",
  "transfers_out_event"
]);

const POS_NAME = new Map([
  [1, "GK"],
  [2, "DEF"],
  [3, "MID"],
  [4, "FWD"]
]);

/** -------------------------
 * Middleware
 * ------------------------- */
app.set("trust proxy", 1);
app.use(express.json({ limit: JSON_LIMIT }));

// Basic security headers (no extra deps)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Request id
app.use((req, res, next) => {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  req._rid = rid;
  res.setHeader("X-Request-Id", rid);
  next();
});

/** -------------------------
 * Helpers
 * ------------------------- */
const toNum = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const isInt = (n) => Number.isInteger(n);

function normalize(str) {
  return (str || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function withTimeout(ms = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

async function fplFetchJson(url, ms = 9000, retries = 1) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const t = withTimeout(ms);
    try {
      const res = await fetch(url, {
        signal: t.signal,
        headers: { "User-Agent": "rexo-actions/1.4.1" }
      });

      if (!res.ok) {
        // Retry only on 5xx
        if (res.status >= 500 && attempt < retries) {
          lastErr = new Error(`FPL ${res.status} for ${url}`);
          continue;
        }
        throw new Error(`FPL ${res.status} for ${url}`);
      }

      return await res.json();
    } catch (e) {
      lastErr = e;
      const retriable =
        e?.name === "AbortError" ||
        (typeof e?.message === "string" && e.message.toLowerCase().includes("fetch"));

      if (attempt < retries && retriable) continue;
      throw lastErr;
    } finally {
      t.cancel();
    }
  }

  throw lastErr || new Error("Unknown fetch failure");
}

function buildTeamMaps(teams) {
  const byId = new Map();
  const shortById = new Map();
  const nameById = new Map();

  for (const t of teams || []) {
    byId.set(t.id, t);
    shortById.set(t.id, t.short_name || t.name || String(t.id));
    nameById.set(t.id, t.name || t.short_name || String(t.id));
  }
  return { byId, shortById, nameById };
}

/**
 * META:
 * - current_gw from event.is_current
 * - next_gw from event.is_next
 * - next_deadline_utc from event.is_next (fallback to current if next missing)
 */
function buildMeta(bootstrap) {
  const events = Array.isArray(bootstrap?.events) ? bootstrap.events : [];

  const current = events.find((e) => e.is_current) || null;
  const next = events.find((e) => e.is_next) || null;

  return {
    competition: "Fantasy Premier League",
    active_season:
      bootstrap?.game_settings?.season ||
      bootstrap?.game_settings?.season_name ||
      "unknown",
    current_gw: current ? current.id : null,
    next_gw: next ? next.id : null,
    next_deadline_utc: next ? next.deadline_time : current ? current.deadline_time : null,
    data_timestamp_utc: new Date().toISOString(),
    source: "official_fpl_api",
    build_sha: BUILD_SHA,
    build_time_utc: BUILD_TIME_UTC
  };
}

/**
 * Cache getters with stale fallback
 */
async function getBootstrap() {
  const now = Date.now();
  const fresh = CACHE.bootstrap.data && now - CACHE.bootstrap.ts < TTL_MS;
  if (fresh) return { data: CACHE.bootstrap.data, stale: false };

  try {
    const data = await fplFetchJson(`${FPL_BASE}/bootstrap-static/`, 9000, 1);
    CACHE.bootstrap = { ts: now, data };
    return { data, stale: false };
  } catch (e) {
    const hasStale = CACHE.bootstrap.data && now - CACHE.bootstrap.ts < STALE_MAX_MS;
    if (hasStale) return { data: CACHE.bootstrap.data, stale: true, warning: "bootstrap_stale" };
    throw e;
  }
}

async function getFixtures() {
  const now = Date.now();
  const fresh = CACHE.fixtures.data && now - CACHE.fixtures.ts < TTL_MS;
  if (fresh) return { data: CACHE.fixtures.data, stale: false };

  try {
    const data = await fplFetchJson(`${FPL_BASE}/fixtures/`, 9000, 1);
    CACHE.fixtures = { ts: now, data };
    return { data, stale: false };
  } catch (e) {
    const hasStale = CACHE.fixtures.data && now - CACHE.fixtures.ts < STALE_MAX_MS;
    if (hasStale) return { data: CACHE.fixtures.data, stale: true, warning: "fixtures_stale" };
    throw e;
  }
}

function ok(res, payload) {
  return res.status(200).json({ ok: true, ...payload });
}

function badRequest(res, error, details, extra = {}) {
  return res.status(400).json({ ok: false, error, ...(details ? { details } : {}), ...extra });
}

function serverError(res, err) {
  const details =
    err?.name === "AbortError"
      ? "Upstream timeout"
      : typeof err?.message === "string"
      ? err.message
      : "Unknown error";

  return res.status(500).json({ ok: false, error: "Action_failed", details });
}

function validateMode(v) {
  const m = String(v || MODE.meta);
  return Object.values(MODE).includes(m) ? m : null;
}

function parseGW(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!isInt(n) || n < 1 || n > 60) return null;
  return n;
}

function parseLimit(v, def = 10, min = 1, max = 30) {
  const n = v === null || v === undefined || v === "" ? def : Number(v);
  if (!Number.isFinite(n)) return def;
  return clamp(Math.floor(n), min, max);
}

function parseBudget(v, def = 1000) {
  const n = v === null || v === undefined || v === "" ? def : Number(v);
  if (!Number.isFinite(n)) return def;
  return clamp(Math.floor(n), 0, 2000);
}

function parseTeamLimit(v, def = 3) {
  const n = v === null || v === undefined || v === "" ? def : Number(v);
  if (!Number.isFinite(n)) return def;
  return clamp(Math.floor(n), 1, 3);
}

function parseStringArray(v, max = 15) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, max);
}

function mapPlayerSummary(e, teamShortById, teamNameById) {
  return {
    id: e.id,
    name: e.web_name,
    team: teamShortById.get(e.team) || String(e.team),
    team_full: teamNameById.get(e.team) || String(e.team),
    element_type: e.element_type,
    position: POS_NAME.get(e.element_type) || String(e.element_type),
    cost: e.now_cost,
    status: e.status,
    form: e.form,
    selected_by_percent: e.selected_by_percent,
    points_per_game: e.points_per_game,
    minutes: e.minutes,
    chance_of_playing_next_round: e.chance_of_playing_next_round,
    transfers_in_event: e.transfers_in_event ?? null,
    transfers_out_event: e.transfers_out_event ?? null
  };
}

/** -------------------------
 * Player resolving
 * ------------------------- */
function resolvePlayerStrict({ q, elements, teams }) {
  const nq = normalize(q);
  if (!nq) return { ok: false, error: "EMPTY_QUERY" };

  const { shortById, nameById } = buildTeamMaps(teams);
  const list = Array.isArray(elements) ? elements : [];
  const isShort = nq.length < 4;

  const webMatches = list
    .filter((e) => e && e.web_name)
    .filter((e) => {
      const w = normalize(e.web_name);
      if (isShort) return w === nq;
      return w === nq || w.includes(nq);
    })
    .slice(0, 10);

  const fullMatches = webMatches.length
    ? webMatches
    : list
        .filter((e) => e && (e.first_name || e.second_name || e.web_name))
        .filter((e) => {
          const full = normalize(`${e.first_name || ""} ${e.second_name || ""}`.trim());
          const web = normalize(e.web_name || "");
          if (isShort) return full === nq || web === nq;
          return full === nq || full.includes(nq) || web.includes(nq);
        })
        .slice(0, 10);

  if (!fullMatches.length) return { ok: false, error: "NOT_FOUND" };

  const exactWeb = fullMatches.find((e) => normalize(e.web_name) === nq);
  const exactFull = fullMatches.find(
    (e) => normalize(`${e.first_name || ""} ${e.second_name || ""}`.trim()) === nq
  );

  const chosen = exactWeb || exactFull || fullMatches[0];

  if (!exactWeb && !exactFull && fullMatches.length > 1) {
    return {
      ok: false,
      error: "AMBIGUOUS",
      candidates: fullMatches.slice(0, 5).map((e) => ({
        id: e.id,
        name: e.web_name,
        team: shortById.get(e.team) || String(e.team)
      }))
    };
  }

  return {
    ok: true,
    player: mapPlayerSummary(chosen, shortById, nameById)
  };
}

/** -------------------------
 * FH Draft scoring
 * ------------------------- */
function fixtureAdjForElement(element, teamById, gwFixtures) {
  const teamId = element.team;
  const relevant = gwFixtures.filter((f) => f.team_h === teamId || f.team_a === teamId);
  if (relevant.length === 0) return 1.0;

  let multSum = 0;

  for (const fx of relevant) {
    const isHome = fx.team_h === teamId;
    const oppId = isHome ? fx.team_a : fx.team_h;
    const opp = teamById.get(oppId);
    if (!opp) continue;

    const oppDef = isHome ? opp.strength_defence_away : opp.strength_defence_home;
    const oppAtt = isHome ? opp.strength_attack_away : opp.strength_attack_home;

    const map = (s) => 1.12 - (clamp(toNum(s), 1, 5) - 1) * (0.24 / 4);

    let m = 1.0;
    if (element.element_type === 1 || element.element_type === 2) m = map(oppAtt);
    else m = map(oppDef);

    multSum += m;
  }

  return multSum / relevant.length;
}

function scoreElement(element, adjMult) {
  const form = toNum(element.form);
  const ppg = toNum(element.points_per_game);
  const mins = toNum(element.minutes);
  const minutesReliability = clamp(mins / 900, 0, 1);
  const base = form * 2.2 + ppg * 1.6 + minutesReliability * 2.0;
  return base * adjMult;
}

function buildFHDraft({ elements, teams, gwFixtures, budget = 1000, teamLimit = 3 }) {
  const teamById = new Map((teams || []).map((t) => [t.id, t]));

  const enriched = (elements || [])
    .filter((e) => e.status === "a")
    .map((e) => {
      const adj = fixtureAdjForElement(e, teamById, gwFixtures);
      const score = scoreElement(e, adj);
      return { ...e, __adj: adj, __score: score };
    });

  const byPos = {
    1: enriched.filter((e) => e.element_type === 1),
    2: enriched.filter((e) => e.element_type === 2),
    3: enriched.filter((e) => e.element_type === 3),
    4: enriched.filter((e) => e.element_type === 4)
  };

  const sortValue = (arr) =>
    arr
      .slice()
      .sort((a, b) => b.__score / b.now_cost - a.__score / a.now_cost || b.__score - a.__score);

  const pools = {
    1: sortValue(byPos[1]),
    2: sortValue(byPos[2]),
    3: sortValue(byPos[3]),
    4: sortValue(byPos[4])
  };

  const needed = { 1: 2, 2: 5, 3: 5, 4: 3 }; // 15 players
  const picks = [];
  const teamCount = new Map();
  let spent = 0;

  const canAdd = (p) => {
    const tc = teamCount.get(p.team) || 0;
    if (tc >= teamLimit) return false;
    if (spent + p.now_cost > budget) return false;
    return true;
  };

  const add = (p) => {
    picks.push(p);
    spent += p.now_cost;
    teamCount.set(p.team, (teamCount.get(p.team) || 0) + 1);
  };

  // Fill by best value first
  for (const pos of [1, 2, 3, 4]) {
    let i = 0;
    while (picks.filter((x) => x.element_type === pos).length < needed[pos]) {
      const cand = pools[pos][i++];
      if (!cand) break;
      if (canAdd(cand)) add(cand);
      if (i > pools[pos].length) break;
    }
  }

  // Fallback: cheapest to complete
  const cheapestByPos = {
    1: byPos[1].slice().sort((a, b) => a.now_cost - b.now_cost),
    2: byPos[2].slice().sort((a, b) => a.now_cost - b.now_cost),
    3: byPos[3].slice().sort((a, b) => a.now_cost - b.now_cost),
    4: byPos[4].slice().sort((a, b) => a.now_cost - b.now_cost)
  };

  for (const pos of [1, 2, 3, 4]) {
    while (picks.filter((x) => x.element_type === pos).length < needed[pos]) {
      const cand = cheapestByPos[pos].find((p) => !picks.some((x) => x.id === p.id));
      if (!cand) break;
      if (canAdd(cand)) add(cand);
      else break;
    }
  }

  const gks = picks.filter((p) => p.element_type === 1).sort((a, b) => b.__score - a.__score);
  const defs = picks.filter((p) => p.element_type === 2).sort((a, b) => b.__score - a.__score);
  const mids = picks.filter((p) => p.element_type === 3).sort((a, b) => b.__score - a.__score);
  const fwds = picks.filter((p) => p.element_type === 4).sort((a, b) => b.__score - a.__score);

  const formations = [
    { d: 3, m: 5, f: 2 },
    { d: 3, m: 4, f: 3 },
    { d: 4, m: 4, f: 2 },
    { d: 4, m: 3, f: 3 },
    { d: 5, m: 4, f: 1 },
    { d: 5, m: 3, f: 2 }
  ];

  let bestXI = null;
  let bestScore = -1;

  for (const fm of formations) {
    if (defs.length < fm.d || mids.length < fm.m || fwds.length < fm.f || gks.length < 1) continue;
    const xi = [gks[0], ...defs.slice(0, fm.d), ...mids.slice(0, fm.m), ...fwds.slice(0, fm.f)];
    const s = xi.reduce((acc, p) => acc + p.__score, 0);
    if (s > bestScore) {
      bestScore = s;
      bestXI = { formation: `${fm.d}-${fm.m}-${fm.f}`, xi };
    }
  }

  const xiIds = new Set(bestXI?.xi.map((p) => p.id) || []);
  const bench = picks.filter((p) => !xiIds.has(p.id)).sort((a, b) => a.__score - b.__score);

  const sortedXI = (bestXI?.xi || []).slice().sort((a, b) => b.__score - a.__score);
  const captain = sortedXI[0] || null;
  const vice = sortedXI[1] || null;

  return {
    budget_total: budget,
    budget_spent: spent,
    budget_itb: budget - spent,
    formation: bestXI?.formation || null,
    captain_id: captain?.id || null,
    vice_captain_id: vice?.id || null,
    xi: bestXI?.xi?.map((p) => p.id) || [],
    bench: bench.map((p) => p.id),
    picks: picks.map((p) => p.id)
  };
}

function mapFixtures(fixtures, gw, teamNameById) {
  const out = gw ? fixtures.filter((f) => f.event === gw) : fixtures;

  const mapped = out.map((f) => ({
    id: f.id,
    event: f.event ?? null,
    team_h: f.team_h,
    team_a: f.team_a,
    team_h_name: teamNameById.get(f.team_h) || String(f.team_h),
    team_a_name: teamNameById.get(f.team_a) || String(f.team_a),
    kickoff_time: f.kickoff_time ?? null
  }));

  return {
    gw: gw || null,
    available: gw ? mapped.length > 0 : true,
    count: mapped.length,
    fixtures: mapped
  };
}

function buildMarketScan(elements, teamShortById, teamNameById, limit = 15) {
  const rows = (elements || []).map((e) => {
    const tin = toNum(e.transfers_in_event);
    const tout = toNum(e.transfers_out_event);
    const net = tin - tout;
    return { e, net, direction: net >= 0 ? "in" : "out", abs: Math.abs(net) };
  });

  rows.sort((a, b) => b.abs - a.abs);

  return rows.slice(0, limit).map((r) => ({
    player: mapPlayerSummary(r.e, teamShortById, teamNameById),
    direction: r.direction,
    net_transfers_event: r.net
  }));
}

/** -------------------------
 * Routes
 * ------------------------- */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    build_sha: BUILD_SHA,
    build_time_utc: BUILD_TIME_UTC
  });
});

app.post("/rexo", async (req, res) => {
  try {
    const mode = validateMode(req.body?.mode);
    if (!mode) {
      return badRequest(
        res,
        "Invalid_mode",
        "mode must be one of: meta, player_check, fixtures, top_players, market_scan, fh_draft, snapshot"
      );
    }

    const gw = parseGW(req.body?.gw);

    // Always load bootstrap first
    const boot = await getBootstrap();
    const bootstrap = boot.data;
    const meta = buildMeta(bootstrap);

    const warnings = [];
    if (boot.stale) warnings.push(boot.warning);

    const teams = Array.isArray(bootstrap?.teams) ? bootstrap.teams : [];
    const elements = Array.isArray(bootstrap?.elements) ? bootstrap.elements : [];
    const { shortById: teamShortById, nameById: teamNameById } = buildTeamMaps(teams);

    if (mode === MODE.meta) {
      return ok(res, { mode, meta, ...(warnings.length ? { warnings } : {}) });
    }

    if (mode === MODE.market_scan) {
      const limit = parseLimit(req.body?.limit, 15, 1, 30);
      const market = buildMarketScan(elements, teamShortById, teamNameById, limit);

      return ok(res, {
        mode,
        meta,
        market,
        ...(warnings.length ? { warnings } : {})
      });
    }

    if (mode === MODE.snapshot) {
      const out = { mode, meta };

      // fixtures (optional) - only if gw provided
      const gwUse = parseGW(req.body?.gw);
      if (gwUse) {
        const fx = await getFixtures();
        const fixtures = Array.isArray(fx.data) ? fx.data : [];
        if (fx.stale) warnings.push(fx.warning);
        out.fixtures = mapFixtures(fixtures, gwUse, teamNameById);
      }

      // top_players (optional) - metrics[] + limit
      const metrics = parseStringArray(req.body?.metrics, 6);
      const limit = parseLimit(req.body?.limit, 10, 1, 30);

      if (metrics.length) {
        out.top_players = {};
        for (const m of metrics) {
          if (!TOP_METRICS.has(m)) continue;

          const sorted = elements
            .filter((e) => e && e.status === "a")
            .slice()
            .sort((a, b) => toNum(b[m]) - toNum(a[m]))
            .slice(0, limit)
            .map((e) => mapPlayerSummary(e, teamShortById, teamNameById));

          out.top_players[m] = { metric: m, limit, players: sorted };
        }
      }

      // player_check batch (optional) - names[]
      const names = parseStringArray(req.body?.names, 15);
      if (names.length) {
        const validated_players = [];
        const errors = [];

        for (const name of names) {
          const r = resolvePlayerStrict({ q: name, elements, teams });
          if (r.ok) validated_players.push(r.player);
          else errors.push({ q: name, error: r.error, candidates: r.candidates || [] });
        }

        out.player_check = { validated_players, errors };
      }

      return ok(res, {
        ...out,
        ...(warnings.length ? { warnings } : {})
      });
    }

    if (mode === MODE.top_players) {
      const metric = String(req.body?.metric || "form");
      if (!TOP_METRICS.has(metric)) {
        return badRequest(
          res,
          "Invalid_metric",
          `metric must be one of: ${Array.from(TOP_METRICS).join(", ")}`
        );
      }

      const limit = parseLimit(req.body?.limit, 10, 1, 30);

      const sorted = elements
        .filter((e) => e && e.status === "a")
        .slice()
        .sort((a, b) => toNum(b[metric]) - toNum(a[metric]))
        .slice(0, limit)
        .map((e) => mapPlayerSummary(e, teamShortById, teamNameById));

      return ok(res, {
        mode,
        meta,
        result: { metric, limit, players: sorted },
        ...(warnings.length ? { warnings } : {})
      });
    }

    if (mode === MODE.player_check) {
      if (
        Array.isArray(req.body?.q) ||
        Array.isArray(req.body?.names) ||
        Array.isArray(req.body?.ids)
      ) {
        return badRequest(res, "BATCH_PLAYER_CHECK_FORBIDDEN", "Use a single string q. Batch not supported.");
      }

      const q = typeof req.body?.q === "string" ? req.body.q : "";
      const limit = parseLimit(req.body?.limit, 5, 1, 10);

      const resolved = resolvePlayerStrict({ q, elements, teams });

      if (!resolved.ok) {
        if (resolved.error === "AMBIGUOUS") {
          return badRequest(res, "AMBIGUOUS", "Provide full name.", {
            candidates: resolved.candidates || []
          });
        }
        return badRequest(
          res,
          resolved.error,
          resolved.error === "NOT_FOUND" ? "No matching player." : "Invalid query."
        );
      }

      const validated_players = [resolved.player];

      return ok(res, {
        mode,
        meta,
        validated_players,
        result: { mode: "player_check", hits: validated_players.slice(0, limit) },
        ...(warnings.length ? { warnings } : {})
      });
    }

    if (mode === MODE.fixtures) {
      const fx = await getFixtures();
      const fixtures = Array.isArray(fx.data) ? fx.data : [];
      if (fx.stale) warnings.push(fx.warning);

      return ok(res, {
        mode,
        meta,
        result: mapFixtures(fixtures, gw, teamNameById),
        ...(warnings.length ? { warnings } : {})
      });
    }

    if (mode === MODE.fh_draft) {
      const fx = await getFixtures();
      const fixtures = Array.isArray(fx.data) ? fx.data : [];
      if (fx.stale) warnings.push(fx.warning);

      const budget = parseBudget(req.body?.budget, 1000);
      const teamLimit = parseTeamLimit(req.body?.team_limit, 3);

      const gwUse = gw || meta.current_gw || null;
      if (!gwUse) {
        return badRequest(
          res,
          "Missing_GW_Context",
          "Provide { gw: <number> } or ensure current_gw is available."
        );
      }

      const gwFixtures = fixtures.filter((f) => f.event === gwUse);

      const draft = buildFHDraft({
        elements,
        teams,
        gwFixtures,
        budget,
        teamLimit
      });

      const idSet = new Set(draft.picks);
      const pickedDetails = elements
        .filter((e) => idSet.has(e.id))
        .map((e) => mapPlayerSummary(e, teamShortById, teamNameById))
        .sort((a, b) => toNum(b.points_per_game) - toNum(a.points_per_game));

      return ok(res, {
        mode,
        meta,
        result: { mode: "fh_draft", gw: gwUse, draft, picked: pickedDetails },
        warnings: [
          ...(warnings.length ? warnings : []),
          "FH draft is heuristic (form/ppg/minutes + opponent strength from FPL team strengths)."
        ]
      });
    }

    return badRequest(res, "Unknown_mode", `mode="${mode}" not supported`);
  } catch (err) {
    console.error("REXO ERROR:", err);
    return serverError(res, err);
  }
});

/** -------------------------
 *  Server + graceful shutdown
 *  ------------------------- */
const server = app.listen(PORT, () => {
  console.log(`REXO Actions running on :${PORT} (sha=${BUILD_SHA})`);
});

function shutdown(signal) {
  console.log(`Shutdown: ${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => console.error("UnhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));