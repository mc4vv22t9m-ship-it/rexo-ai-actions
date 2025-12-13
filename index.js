import express from "express";

/* global fetch */

const app = express();
app.use(express.json({ limit: "1mb" }));

const FPL_BASE = "https://fantasy.premierleague.com/api";

// ---------- HELPERS ----------
const fetchJson = async (url, timeoutMs = 8000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "rexo-ai-actions/1.0"
      }
    });

    if (!res.ok) {
      throw new Error(`Fetch failed ${res.status} for ${url}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
};

// ---------- HEALTH CHECK ----------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ---------- MAIN REXO ACTION ----------
app.post("/rexo", async (req, res) => {
  try {
    // 1️⃣ Fetch OFFICIAL FPL DATA (parallel, safe)
    const [bootstrap, fixtures, eventStatus] = await Promise.all([
      fetchJson(`${FPL_BASE}/bootstrap-static/`),
      fetchJson(`${FPL_BASE}/fixtures/`),
      fetchJson(`${FPL_BASE}/event-status/`)
    ]);

    // 2️⃣ Detect active GW (authoritative)
    const currentEvent =
      bootstrap.events.find(e => e.is_current) ||
      bootstrap.events.find(e => e.is_next) ||
      null;

    // 3️⃣ Build SLIM + AUTHORITATIVE response
    res.json({
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
        fixtures,
        event_status: eventStatus
      },

      input: req.body || {},
      warnings: []
    });
  } catch (error) {
    console.error("REXO ACTION ERROR:", error.message);

    res.status(502).json({
      ok: false,
      error: "Failed to fetch live FPL data",
      details: error.message
    });
  }
});

// ---------- SERVER ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`REXO Actions running on port ${PORT}`);
});