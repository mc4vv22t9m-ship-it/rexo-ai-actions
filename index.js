import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const FPL_BASE = "https://fantasy.premierleague.com/api";

// Small helper: fetch JSON with timeout
async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: controller.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url} :: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// HEALTH CHECK
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// MAIN REXO ACTION
app.post("/rexo", async (req, res) => {
  try {
    // If you ever want full payload, send { "full": true } in body
    const wantFull = Boolean(req.body && req.body.full);

    // 1) Fetch core FPL data with timeouts
    const [bootstrap, fixtures, eventStatus] = await Promise.all([
      fetchJson(`${FPL_BASE}/bootstrap-static/`, 8000),
      fetchJson(`${FPL_BASE}/fixtures/`, 8000),
      fetchJson(`${FPL_BASE}/event-status/`, 8000)
    ]);

    // 2) Detect active GW (current -> next)
    const currentEvent =
      bootstrap?.events?.find(e => e.is_current) ||
      bootstrap?.events?.find(e => e.is_next) ||
      null;

    // 3) Build SLIM response by default (prevents huge payload + connector failures)
    const meta = {
      competition: "Fantasy Premier League",
      active_season: bootstrap?.game_settings?.season ?? "unknown",
      current_gw: currentEvent ? currentEvent.id : null,
      next_deadline_utc: currentEvent ? currentEvent.deadline_time : null,
      data_timestamp_utc: new Date().toISOString(),
      source: "official_fpl_api"
    };

    const slim = {
      events: bootstrap?.events ?? [],
      teams: bootstrap?.teams ?? [],
      element_types: bootstrap?.element_types ?? [],
      // IMPORTANT: elements is huge — keep only key fields
      elements: (bootstrap?.elements ?? []).map(p => ({
        id: p.id,
        web_name: p.web_name,
        team: p.team,
        element_type: p.element_type,
        now_cost: p.now_cost,
        status: p.status,
        chance_of_playing_next_round: p.chance_of_playing_next_round,
        chance_of_playing_this_round: p.chance_of_playing_this_round,
        news: p.news,
        selected_by_percent: p.selected_by_percent,
        form: p.form,
        points_per_game: p.points_per_game,
        minutes: p.minutes,
        goals_scored: p.goals_scored,
        assists: p.assists,
        clean_sheets: p.clean_sheets,
        expected_goals: p.expected_goals,
        expected_assists: p.expected_assists,
        expected_goal_involvements: p.expected_goal_involvements,
        expected_goals_conceded: p.expected_goals_conceded
      })),
      // Fixtures can also be large; keep as-is for now, or slice if needed
      fixtures: fixtures ?? [],
      event_status: eventStatus ?? {}
    };

    return res.json({
      ok: true,
      meta,
      fpl: wantFull ? { ...slim, raw_bootstrap: bootstrap } : slim,
      input: req.body || {},
      warnings: wantFull ? ["full=true increases payload size"] : []
    });

  } catch (error) {
    console.error("REXO ACTION ERROR:", error);
    // Return a JSON error (so GPT connector can show it)
    return res.status(502).json({
      ok: false,
      error: "Failed to fetch live FPL data within time limits",
      details: String(error?.message || error),
      hint: "One of the official FPL endpoints timed out or returned non-200."
    });
  }
});

// PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`REXO Actions running on port ${PORT}`);
});