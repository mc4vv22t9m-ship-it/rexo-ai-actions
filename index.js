import express from "express";

const app = express();

// middleware za JSON
app.use(express.json());

// health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// REXO ACTION ENDPOINT
app.post("/rexo", async (req, res) => {
  return res.json({
    ok: true,
    received: req.body,
  });
});

// Railway port
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});