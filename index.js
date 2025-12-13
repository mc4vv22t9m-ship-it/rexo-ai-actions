import express from "express";

const app = express();
app.use(express.json({ limit: "256kb" }));

const FPL_BASE = "https://fantasy.premierleague.com/api";

// ---------- tiny in-memory cache (prevents 502/timeouts) ----------
const CACHE = {
  bootstrap: { ts: 0, data: null },
  fixtures: { ts: 0, data: null }
};
const TTL_MS = 60 * 1000; // 60s

/** ---------- helpers ---------- **/
function withTimeout(ms = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

async function fplFetchJson(url, ms = 8000) {
  const t = withTimeout(ms);
  try {
    // Node 18+ has global fetch. If you’re on older Node, you must install node-fetch.
    const res = await fetch(url, {
      signal: t.signal,
      headers: { "User-Agent": "rexo-actions/1.0" }
    });
    if (!res.ok) throw new Error(`FPL ${res.status} for ${url}`);
    return await res.json();
  } finally {
    t.cancel();
  }
}

async function getBootstrap() {
  const now = Date.now();
  if (CACHE.bootstrap.data && now - CACHE.bootstrap.ts < TTL_MS) return CACHE.bootstrap.data;
  const data = await fplFetchJson(`${FPL_BASE}/bootstrap-static/`, 9000);
  CACHE.bootstrap = { ts: now, data };
  return data;
}

async function getFixtures() {
  const now = Date.now();
  if (CACHE.fixtures.data && now - CACHE.fixtures.ts < TTL_MS) return CACHE.fixtures.data;
  const data = await fplFetchJson(`${FPL_BASE}/fixtures/`, 9000);
  CACHE.fixtures = { ts: now, data };
  return data;
}

const toNum = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function buildMeta(bootstrap) {
  const currentEvent =
    bootstrap.events.find((e) => e.is_current) ||
    bootstrap.events.find((e) => e.is_next) ||
    null;

  // FPL API often doesn’t expose season string reliably.
  return {
    competition: "Fantasy Premier League",
    active_season: bootstrap?.game_settings?.season || "unknown",
    current_gw: currentEvent ? currentEvent.id : null,
    next_deadline_utc: currentEvent ? currentEvent.deadline_time : null,
    data_timestamp_utc: new Date().toISOString(),
    source: "official_fpl_api"
  };
}

function posMap() {
  return new Map([
    [1, "GK"],
    [2, "DEF"],
    [3, "MID"],
    [4, "FWD"]
  ]);
}

/** Simple GW opponent strength adjustment (lightweight). */
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

    // map strength 1..5 -> 1.12..0.88
    const map = (s) => 1.12 - (clamp(toNum(s), 1, 5) - 1) * (0.24 / 4);

    let m = 1.0;
    if (element.element_type === 1 || element.element_type === 2) {
      m = map(oppAtt);
    } else {
      m = map(oppDef);
    }
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

/** Greedy 15-man FH draft under constraints */
function buildFHDraft({ elements, teams, gwFixtures, budget = 1000, teamLimit = 3 }) {
  const teamById = new Map(teams.map((t) => [t.id, t]));

  const enriched = elements
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
      .sort(
        (a, b) =>
          b.__score / b.now_cost - a.__score / a.now_cost || b.__score - a.__score
      );

  const pools = {
    1: sortValue(byPos[1]),
    2: sortValue(byPos[2]),
    3: sortValue(byPos[3]),
    4: sortValue(byPos[4])
  };

  const needed = { 1: 2, 2: 5, 3: 5, 4: 3 };
  const picks = [];
  const teamCount = new Map();
  let spent = 0;

  function canAdd(p) {
    const tc = teamCount.get(p.team) || 0;
    if (tc >= teamLimit) return false;
    if (spent + p.now_cost > budget) return false;
    return true;
  }
  function add(p) {
    picks.push(p);
    spent += p.now_cost;
    teamCount.set(p.team, (teamCount.get(p.team) || 0) + 1);
  }

  for (const pos of [1, 2, 3, 4]) {
    let i = 0;
    while (picks.filter((x) => x.element_type === pos).length < needed[pos]) {
      const cand = pools[pos][i++];
      if (!cand) break;
      if (canAdd(cand)) add(cand);
      if (i > pools[pos].length) break;
    }
  }

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

/** ---------- routes ---------- **/
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/rexo", async (req, res) => {
  try {
    const mode = String(req.body?.mode || "meta");
    const gw = req.body?.gw ? Number(req.body.gw) : null;

    const bootstrap = await getBootstrap();
    const meta = buildMeta(bootstrap);

    // common lookups
    const teams = bootstrap.teams || [];
    const teamShortById = new Map(teams.map((t) => [t.id, t.short_name]));
    const teamNameById = new Map(teams.map((t) => [t.id, t.name]));
    const POS = posMap();

    if (mode === "meta") {
      return res.json({ ok: true, meta });
    }

    if (mode === "top_players") {
      const metric = String(req.body?.metric || "form");
      const limit = clamp(Number(req.body?.limit || 10), 1, 30);

      const elements = bootstrap.elements || [];
      const sorted = elements
        .filter((e) => e.status === "a")
        .sort((a, b) => toNum(b[metric]) - toNum(a[metric]))
        .slice(0, limit)
        .map((e) => ({
          id: e.id,
          name: e.web_name,
          team: teamShortById.get(e.team) || e.team,
          team_full: teamNameById.get(e.team) || e.team,
          element_type: e.element_type,
          position: POS.get(e.element_type) || String(e.element_type),
          cost: e.now_cost,
          form: e.form,
          selected_by_percent: e.selected_by_percent,
          points_per_game: e.points_per_game,
          minutes: e.minutes,
          status: e.status,
          chance_of_playing_next_round: e.chance_of_playing_next_round
        }));

      return res.json({ ok: true, meta, result: { metric, limit, players: sorted } });
    }

    // ✅ NEW: player_check (prevents position hallucinations)
    if (mode === "player_check") {
      const q = req.body?.q;
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      const names = Array.isArray(req.body?.names) ? req.body.names.map(String) : [];
      const limit = clamp(Number(req.body?.limit || 25), 1, 50);

      const elements = bootstrap.elements || [];

      const norm = (s) => String(s || "").trim().toLowerCase();
      const qn = norm(q);

      let hits = elements;

      if (ids.length) {
        const idSet = new Set(ids);
        hits = hits.filter((e) => idSet.has(e.id));
      } else if (names.length) {
        const set = new Set(names.map(norm));
        hits = hits.filter((e) => set.has(norm(e.web_name)));
      } else if (q) {
        hits = hits.filter((e) => norm(e.web_name).includes(qn));
      } else {
        hits = [];
      }

      hits = hits.slice(0, limit).map((e) => ({
        id: e.id,
        name: e.web_name,
        team: teamShortById.get(e.team) || e.team,
        team_full: teamNameById.get(e.team) || e.team,
        element_type: e.element_type,
        position: POS.get(e.element_type) || String(e.element_type),
        cost: e.now_cost,
        status: e.status,
        form: e.form,
        selected_by_percent: e.selected_by_percent,
        minutes: e.minutes,
        chance_of_playing_next_round: e.chance_of_playing_next_round
      }));

      return res.json({ ok: true, meta, result: { mode: "player_check", hits } });
    }

    if (mode === "fixtures") {
      const fixtures = await getFixtures();
      const out = gw ? fixtures.filter((f) => f.event === gw) : fixtures;
      return res.json({
        ok: true,
        meta,
        result: {
          gw: gw || null,
          fixtures: out.map((f) => ({
            id: f.id,
            event: f.event,
            team_h: f.team_h,
            team_a: f.team_a,
            kickoff_time: f.kickoff_time
          }))
        }
      });
    }

    if (mode === "fh_draft") {
      const fixtures = await getFixtures();
      const budget = req.body?.budget ? Number(req.body.budget) : 1000;
      const teamLimit = req.body?.team_limit ? Number(req.body.team_limit) : 3;

      const gwUse = gw || meta.current_gw || null;
      if (!gwUse) {
        return res.status(400).json({
          ok: false,
          error: "Missing GW context",
          details: "Provide { gw: <number> } or ensure current_gw is available."
        });
      }

      const gwFixtures = fixtures.filter((f) => f.event === gwUse);

      const draft = buildFHDraft({
        elements: bootstrap.elements || [],
        teams: bootstrap.teams || [],
        gwFixtures,
        budget,
        teamLimit
      });

      // Slim picked details for ONLY selected players
      const idSet = new Set(draft.picks);
      const pickedDetails = (bootstrap.elements || [])
        .filter((e) => idSet.has(e.id))
        .map((e) => ({
          id: e.id,
          name: e.web_name,
          team: teamShortById.get(e.team) || e.team,
          team_full: teamNameById.get(e.team) || e.team,
          element_type: e.element_type,
          position: POS.get(e.element_type) || String(e.element_type),
          cost: e.now_cost,
          form: e.form,
          ppg: e.points_per_game,
          minutes: e.minutes,
          status: e.status,
          chance_of_playing_next_round: e.chance_of_playing_next_round
        }))
        .sort((a, b) => toNum(b.ppg) - toNum(a.ppg));

      return res.json({
        ok: true,
        meta,
        result: {
          mode: "fh_draft",
          gw: gwUse,
          draft,
          picked: pickedDetails
        },
        warnings: [
          "FH draft is heuristic (form/ppg/minutes + opponent strength). xG/xA needs external stats feeds."
        ]
      });
    }

    return res.status(400).json({
      ok: false,
      error: "Unknown mode",
      details: `mode="${mode}" not supported`
    });
  } catch (err) {
    console.error("REXO ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Action failed",
      details: err?.name === "AbortError" ? "Upstream timeout" : err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`REXO Actions running on :${PORT}`));