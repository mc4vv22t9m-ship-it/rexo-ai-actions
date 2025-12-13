import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const FPL_BASE = "https://fantasy.premierleague.com/api";

// HEALTH CHECK
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// MAIN REXO ACTION
app.post("/rexo", async (req, res) => {
  try {
    // 1️⃣ Fetch core FPL data (official sources)
    const [bootstrapRes, fixturesRes, eventStatusRes] = await Promise.all([
      fetch(`${FPL_BASE}/bootstrap-static/`),
      fetch(`${FPL_BASE}/fixtures/`),
      fetch(`${FPL_BASE}/event-status/`)
    ]);

    const bootstrap = await bootstrapRes.json();
    const fixtures = await fixturesRes.json();
    const eventStatus = await eventStatusRes.json();

    // 2️⃣ Detect active / next Gameweek
    const currentEvent =
      bootstrap.events.find(e => e.is_current) ||
      bootstrap.events.find(e => e.is_next);

    // 3️⃣ Authoritative response (single source of truth)
    return res.json({
      ok: true,

      meta: {
        competition: "Fantasy Premier League",
        active_season: bootstrap.game_settings?.season || "unknown",
        current_gw: currentEvent?.id || null,
        next_deadline_utc: currentEvent?.deadline_time || null,
        data_timestamp_utc: new Date().toISOString(),
        source: "official_fpl_api"
      },

      fpl: {
        events: bootstrap.events,
        teams: bootstrap.teams,
        elements: bootstrap.elements,
        element_types: bootstrap.element_types,
        fixtures: fixtures,
        event_status: eventStatus
      },

      input: req.body || {},
      warnings: []
    });

  } catch (error) {
    console.error("REXO ACTION ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: "FPL_DATA_FETCH_FAILED",
      details: error.message
    });
  }
});

// PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`REXO Actions running on port ${PORT}`);
});