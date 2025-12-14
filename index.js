import express from "express";

const app = express();
app.use(express.json({ limit: "256kb" }));

const FPL_BASE = "https://fantasy.premierleague.com/api";

const BUILD_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  process.env.COMMIT_SHA ||
  "unknown";

const BUILD_TIME_UTC = process.env.BUILD_TIME_UTC || "unknown";

const CACHE = {
  bootstrap: { ts: 0, data: null },
  fixtures: { ts: 0, data: null }
};

const TTL_MS = 60 * 1000;

const POS_NAME = new Map([
  [1, "GK"],
  [2, "DEF"],
  [3, "MID"],
  [4, "FWD"]
]);

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

function normalize(str) {
  return (str || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
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

function buildMeta(bootstrap) {
  const currentEvent =
    bootstrap.events.find((e) => e.is_current) ||
    bootstrap.events.find((e) => e.is_next) ||
    null;

  return {
    competition: "Fantasy Premier League",
    active_season: bootstrap?.game_settings?.season || "unknown",
    current_gw: currentEvent ? currentEvent.id : null,
    next_deadline_utc: currentEvent ? currentEvent.deadline_time : null,
    data_timestamp_utc: new Date().toISOString(),
    source: "official_fpl_api",
    build_sha: BUILD_SHA,
    build_time_utc: BUILD_TIME_UTC
  };
}

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
        team: shortById.get(e.team) || e.team
      }))
    };
  }

  return {
    ok: true,
    player: {
      id: chosen.id,
      name: chosen.web_name,
      team: shortById.get(chosen.team) || chosen.team,
      team_full: nameById.get(chosen.team) || chosen.team,
      element_type: chosen.element_type,
      position: POS_NAME.get(chosen.element_type) || chosen.element_type,
      cost: chosen.now_cost,
      status: chosen.status,
      form: chosen.form,
      selected_by_percent: chosen.selected_by_percent,
      minutes: chosen.minutes,
      chance_of_playing_next_round: chosen.chance_of_playing_next_round
    }
  };
}

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

function buildFHDraft({ elements, teams, gwFixtures, budget = 1000, teamLimit = 3 }) {
  const teamById = new Map(teams.map((t) => [t.id, t]));

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

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    build_sha: BUILD_SHA,
    build_time_utc: BUILD_TIME_UTC
  });
});

app.post("/rexo", async (req, res) => {
  try {
    const mode = String(req.body?.mode || "meta");
    const gw = req.body?.gw ? Number(req.body.gw) : null;

    const bootstrap = await getBootstrap();
    const meta = buildMeta(bootstrap);

    const teams = bootstrap.teams || [];
    const { shortById: teamShortById, nameById: teamNameById } = buildTeamMaps(teams);

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
          position: POS_NAME.get(e.element_type) || String(e.element_type),
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

    if (mode === "player_check") {
      if (
        Array.isArray(req.body?.q) ||
        Array.isArray(req.body?.names) ||
        Array.isArray(req.body?.ids)
      ) {
        return res.status(400).json({ ok: false, error: "BATCH_PLAYER_CHECK_FORBIDDEN" });
      }

      const q = req.body?.q;
      const limit = clamp(Number(req.body?.limit || 5), 1, 10);

      const elements = bootstrap.elements || [];
      const resolved = resolvePlayerStrict({ q, elements, teams });

      if (!resolved.ok) {
        return res.status(400).json({
          ok: false,
          error: resolved.error,
          ...(resolved.candidates ? { candidates: resolved.candidates } : {})
        });
      }

      const validated_players = [resolved.player];

      return res.json({
        ok: true,
        meta,
        validated_players,
        result: { mode: "player_check", hits: validated_players.slice(0, limit) }
      });
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
          error: "Missing_GW_Context",
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

      const idSet = new Set(draft.picks);
      const pickedDetails = (bootstrap.elements || [])
        .filter((e) => idSet.has(e.id))
        .map((e) => ({
          id: e.id,
          name: e.web_name,
          team: teamShortById.get(e.team) || e.team,
          team_full: teamNameById.get(e.team) || e.team,
          element_type: e.element_type,
          position: POS_NAME.get(e.element_type) || String(e.element_type),
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
          "FH draft is heuristic (form/ppg/minutes + opponent strength). xG/xA requires an external stats feed."
        ]
      });
    }

    return res.status(400).json({
      ok: false,
      error: "Unknown_mode",
      details: `mode="${mode}" not supported`
    });
  } catch (err) {
    console.error("REXO ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Action_failed",
      details: err?.name === "AbortError" ? "Upstream timeout" : err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`REXO Actions running on :${PORT}`));