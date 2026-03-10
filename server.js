// ============================================================
//  RobloxAI Proxy Server
//  npm install express cors node-fetch dotenv
//  node server.js
// ============================================================
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

async function fetchJson(url) {
  const { default: fetch } = await import("node-fetch");
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function askClaude(query) {
  const { default: fetch } = await import("node-fetch");
  const prompt = `You are an expert on Roblox games. A player searched: "${query}"

Return EXACTLY 6 real, popular Roblox games that best match this request.
For each game provide:
- placeId    : the numeric Roblox Place ID (the number in the URL: roblox.com/games/PLACEID)
- name       : exact game name as it appears on Roblox
- genre      : one word genre: Adventure, Horror, Tycoon, Obby, RPG, Simulator, Battle, Roleplay, Fighting, Platformer
- description: 2 engaging sentences about what makes this game fun
- tags       : array of exactly 3 short tags
- creatorName: name of the creator or group

Only include games you are highly confident exist on Roblox with accurate Place IDs.
Respond ONLY with a raw JSON array — no markdown, no backticks, no explanation.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.map(b => b.text || "").join("") || "";
  return JSON.parse(text.replace(/```json|```/gi, "").trim());
}

async function getRobloxData(placeId) {
  try {
    // Resolve place -> universe
    const uniRes = await fetchJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    const universeId = uniRes.universeId;
    if (!universeId) return null;

    const [detailsRes, votesRes] = await Promise.allSettled([
      fetchJson(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
      fetchJson(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`),
    ]);

    const game = detailsRes.status === "fulfilled" ? detailsRes.value?.data?.[0] : null;
    const votes = votesRes.status === "fulfilled" ? votesRes.value?.data?.[0] : null;

    const up = votes?.upVotes || 0;
    const down = votes?.downVotes || 0;
    const total = up + down;
    const rating = total > 0 ? Math.round((up / total) * 100) : null;

    function fmt(n) {
      if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(n);
    }

    // Get creator avatar asset id for rbxthumb
    let creatorAvatarId = null;
    const creatorId = game?.creator?.id;
    const creatorType = game?.creator?.type;

    return {
      universeId,       // ← KEY: Roblox client uses this for rbxthumb:// URIs
      placeId,
      playing: game?.playing != null ? fmt(game.playing) : null,
      visits: game?.visits != null ? fmt(game.visits) : null,
      rating,
      creatorName: game?.creator?.name || null,
      creatorId: creatorId || null,
      creatorType: creatorType || null,
      maxPlayers: game?.maxPlayers || null,
    };
  } catch (err) {
    console.warn(`getRobloxData failed for ${placeId}:`, err.message);
    return null;
  }
}

app.get("/", (req, res) => res.json({ status: "ok", service: "RobloxAI" }));

app.post("/search", async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: "Missing query" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "No API key" });

  console.log(`[search] "${query}"`);

  try {
    const claudeGames = await askClaude(query.trim());

    const enriched = await Promise.all(claudeGames.map(async (g) => {
      const live = await getRobloxData(g.placeId);
      return {
        placeId:      g.placeId,
        universeId:   live?.universeId  || null,   // for rbxthumb://
        name:         g.name,
        genre:        g.genre,
        description:  g.description,
        tags:         g.tags || [],
        creatorName:  live?.creatorName || g.creatorName || "Unknown",
        creatorId:    live?.creatorId   || null,
        creatorType:  live?.creatorType || "User",
        playing:      live?.playing     || null,
        visits:       live?.visits      || null,
        rating:       live?.rating      || null,
        maxPlayers:   live?.maxPlayers  || null,
      };
    }));

    return res.json({ games: enriched });
  } catch (err) {
    console.error("[search] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`RobloxAI proxy on :${PORT}`));
