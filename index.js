import express from "express";

const app = express();
app.use(express.json({ limit: "256kb" }));

const FPL_BASE = "https://fantasy.premierleague.com/api";

/** ---------- helpers ---------- **/
function withTimeout(ms = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

async function fplFetchJson(url, ms = 8000) {
  const t = withTimeout(ms);
  try {
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

const toNum = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function pickFields(obj, fields) {
  if (!fields || !Array.isArray(fields) || fields.length === 0) return obj;
  const out = {};
  for (const k of fields) out[k] = obj[k];
  return out;
}

/** Simple GW opponent strength adjustment (very lightweight). */
function fixtureAdjForElement(element, teamById, gwFixtures, teams) {
  // Return multiplier ~ [0.85 .. 1.15]
  const teamId = element.team;
  const isHomeFixtures = gwFixtures.filter(
    (f) => f.team_h === teamId || f.team_a === teamId
  );
  if (isHomeFixtures.length === 0) return 1.0;

  // If double gameweek, average.
  let multSum = 0;
  for (const fx of isHomeFixtures) {
    const isHome = fx.team_h === teamId;
    const oppId = isHome ? fx.team_a : fx.team_h;
    const opp = teamById.get(oppId);

    // Use official strength numbers (coarse but stable).
    // If attacker-type, reward weak defence; if defender/gk reward weak attack.
    const oppDef = isHome ? opp.strength_defence_away : opp.strength_defence_home;
    const oppAtt = isHome ? opp.strength_attack_away : opp.strength_attack_home;

    // Normalize strength to multiplier (lower opp strength => higher mult).
    // In FPL strengths are ~1-5. We'll map 1->1.12, 5->0.88.
    const map = (s) => 1.12 - (clamp(toNum(s), 1, 5) - 1) * (0.24 / 4);

    let m = 1.0;
    if (element.element_type === 1 || element.element_type === 2) {
      // GK/DEF benefit from weaker opp attack
      m = map(oppAtt);
    } else {
      // MID/FWD benefit from weaker opp defence
      m = map(oppDef);
    }
    multSum += m;
  }
  return multSum / isHomeFixtures.length;
}

function scoreElement(element, adjMult) {
  // Keep it simple, consistent, and “cheap”.
  // All numbers are available in bootstrap-static.
  const form = toNum(element.form);
  const ppg = toNum(element.points_per_game);
  const mins = toNum(element.minutes);

  // Base: form + ppg + minutes reliability
  const minutesReliability = clamp(mins / 900, 0, 1); // ~last 10 matches worth of minutes
  const base = form * 2.2 + ppg * 1.6 + minutesReliability * 2.0;

  return base * adjMult;
}

function buildMeta(bootstrap) {
  const currentEvent =
    bootstrap.events.find((e) => e.is_current) || bootstrap.events.find((e) => e.is_next) || null;

  // FPL API does not reliably expose "season" string; keep safe.
  return {
    competition: "Fantasy Premier League",
    active_season: bootstrap?.game_settings?.season || "unknown",
    current_gw: currentEvent ? currentEvent.id : null,
    next_deadline_utc: currentEvent ? currentEvent.deadline_time : null,
    data_timestamp_utc: new Date().toISOString(),
    source: "official_fpl_api"
  };
}

/** Greedy 15-man FH draft under constraints */
function buildFHDraft({ elements, teams, gwFixtures, budget = 1000, teamLimit = 3 }) {
  const teamById = new Map(teams.map((t) => [t.id, t]));

  // Precompute scores
  const enriched = elements
    .filter((e) => e.status === "a") // available
    .map((e) => {
      const adj = fixtureAdjForElement(e, teamById, gwFixtures, teams);
      const score = scoreElement(e, adj);
      return { ...e, __adj: adj, __score: score };
    });

  // Pos buckets (1 GK, 2 DEF, 3 MID, 4 FWD)
  const byPos = {
    1: enriched.filter((e) => e.element_type === 1),
    2: enriched.filter((e) => e.element_type === 2),
    3: enriched.filter((e) => e.element_type === 3),
    4: enriched.filter((e) => e.element_type === 4)
  };

  // Sort by value (score per cost) with score tiebreak
  const sortValue = (arr) =>
    arr
      .slice()
      .sort((a, b) => (b.__score / b.now_cost) - (a.__score / a.now_cost) || b.__score - a.__score);

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

  // Fill required slots greedily
  for (const pos of [1, 2, 3, 4]) {
    let i = 0;
    while (picks.filter((x) => x.element_type === pos).length < needed[pos]) {
      const cand = pools[pos][i++];
      if (!cand) break;
      if (canAdd(cand)) add(cand);
      // avoid infinite loops; if budget too tight, relax by skipping expensive players
      if (i > pools[pos].length) break;
    }
  }

  // If still over budget issues prevented filling, fallback: take cheapest active to fill
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
      else {
        // If even cheapest can't fit, stop (should be rare).
        break;
      }
    }
  }

  // Choose best XI by trying common formations
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
    const xi = [
      gks[0],
      ...defs.slice(0, fm.d),
      ...mids.slice(0, fm.m),
      ...fwds.slice(0, fm.f)
    ];
    const s = xi.reduce((acc, p) => acc + p.__score, 0);
    if (s > bestScore) {
      bestScore = s;
      bestXI = { formation: `${fm.d}-${fm.m}-${fm.f}`, xi };
    }
  }

  // Bench = remaining picks not in XI, order by score ascending
  const xiIds = new Set(bestXI?.xi.map((p) => p.id) || []);
  const bench = picks
    .filter((p) => !xiIds.has(p.id))
    .sort((a, b) => a.__score - b.__score);

  // Captain / Vice = top two scores in XI
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
    const mode = (req.body?.mode || "meta").toString();
    const gw = req.body?.gw ? Number(req.body.gw) : null;

    // Always fetch bootstrap (needed for most modes)
    const bootstrap = await fplFetchJson(`${FPL_BASE}/bootstrap-static/`, 9000);
    const meta = buildMeta(bootstrap);

    if (mode === "meta") {
      return res.json({ ok: true, meta });
    }

    // Fixtures only if needed
    let fixtures = null;
    if (mode === "fh_draft" || mode === "fixtures") {
      fixtures = await fplFetchJson(`${FPL_BASE}/fixtures/`, 9000);
    }

    if (mode === "fixtures") {
      const out = gw ? fixtures.filter((f) => f.event === gw) : fixtures;
      // Keep response small
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

    if (mode === "top_players") {
      const metric = (req.body?.metric || "form").toString();
      const limit = clamp(Number(req.body?.limit || 10), 1, 30);
      const fields = req.body?.fields;

      const elements = bootstrap.elements || [];
      const teams = bootstrap.teams || [];
      const teamNameById = new Map(teams.map((t) => [t.id, t.name]));
      const posName = new Map([
        [1, "GK"],
        [2, "DEF"],
        [3, "MID"],
        [4, "FWD"]
      ]);

      const sorted = elements
        .filter((e) => e.status === "a")
        .sort((a, b) => toNum(b[metric]) - toNum(a[metric]))
        .slice(0, limit)
        .map((e) => {
          const base = {
            id: e.id,
            name: e.web_name,
            team: teamNameById.get(e.team) || e.team,
            position: posName.get(e.element_type) || e.element_type,
            now_cost: e.now_cost, // /10
            form: e.form,
            selected_by_percent: e.selected_by_percent,
            points_per_game: e.points_per_game
          };
          return pickFields(base, fields);
        });

      return res.json({ ok: true, meta, result: { metric, limit, players: sorted } });
    }

    if (mode === "fh_draft") {
      const budget = req.body?.budget ? Number(req.body.budget) : 1000; // 100.0 in FPL units
      const teamLimit = req.body?.team_limit ? Number(req.body.team_limit) : 3;

      const gwUse =
        gw ||
        meta.current_gw ||
        null;

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

      // Return small, plus a lookup table (names/costs) ONLY for picked ids
      const idSet = new Set(draft.picks);
      const teams = bootstrap.teams || [];
      const teamNameById = new Map(teams.map((t) => [t.id, t.short_name]));
      const posName = new Map([
        [1, "GK"],
        [2, "DEF"],
        [3, "MID"],
        [4, "FWD"]
      ]);

      const pickedDetails = (bootstrap.elements || [])
        .filter((e) => idSet.has(e.id))
        .map((e) => ({
          id: e.id,
          name: e.web_name,
          team: teamNameById.get(e.team) || e.team,
          pos: posName.get(e.element_type) || e.element_type,
          cost: e.now_cost,
          form: e.form,
          ppg: e.points_per_game
        }))
        .sort((a, b) => b.ppg - a.ppg);

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
          "FH draft is heuristic-based (form/ppg/minutes + opponent strength). For xG/xA you need external stats feeds."
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