// ============================================================
//  RobloxAI Proxy Server
//  Bridges Roblox Studio <-> Claude API + Roblox public APIs
//  Requirements: Node.js 18+
//  Install: npm install express cors node-fetch dotenv
//  Run:     node server.js
// ============================================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// ── Helpers ──────────────────────────────────────────────────

async function fetchJson(url, options = {}) {
  const { default: fetch } = await import("node-fetch");
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// Ask Claude to resolve a query into real Roblox game IDs + metadata
async function askClaude(query) {
  const { default: fetch } = await import("node-fetch");

  const prompt = `You are an expert on Roblox games. A player searched: "${query}"

Return EXACTLY 6 real, popular Roblox games that best match this request.
For each game provide:
- placeId    : the numeric Roblox Place ID (the number in the URL: roblox.com/games/PLACEID)
- name       : exact game name as it appears on Roblox
- genre      : one of: Adventure, Horror, Tycoon, Obby, RPG, Simulator, Battle, Roleplay, Fighting, Platformer
- description: 2 engaging sentences about the game
- tags       : array of exactly 3 short tags e.g. ["Multiplayer","Story","Free"]
- creatorName: name of the creator/group

Only include games you are highly confident exist on Roblox with accurate Place IDs.
Respond ONLY with a raw JSON array — no markdown, no backticks, no explanation.

Example format:
[{"placeId":1818,"name":"Classic Crossroads","genre":"Adventure","description":"...","tags":["Free","Classic","PvP"],"creatorName":"Roblox"}]`;

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

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.map((b) => b.text || "").join("") || "";
  const clean = text.replace(/```json|```/gi, "").trim();
  return JSON.parse(clean);
}

// Fetch live stats for a Roblox universe from public APIs
async function getRobloxGameData(placeId) {
  try {
    // 1. Resolve place → universe
    const universeRes = await fetchJson(
      `https://apis.roblox.com/universes/v1/places/${placeId}/universe`
    );
    const universeId = universeRes.universeId;
    if (!universeId) return null;

    // 2. Game details (visiting, likes etc.)
    const [detailsRes, votesRes, thumbnailRes] = await Promise.allSettled([
      fetchJson(
        `https://games.roblox.com/v1/games?universeIds=${universeId}`
      ),
      fetchJson(
        `https://games.roblox.com/v1/games/votes?universeIds=${universeId}`
      ),
      fetchJson(
        `https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`
      ),
    ]);

    const gameData =
      detailsRes.status === "fulfilled"
        ? detailsRes.value?.data?.[0]
        : null;
    const voteData =
      votesRes.status === "fulfilled"
        ? votesRes.value?.data?.[0]
        : null;
    const thumbData =
      thumbnailRes.status === "fulfilled"
        ? thumbnailRes.value?.data?.[0]
        : null;

    // 3. Creator info
    let creatorAvatar = null;
    let creatorId = gameData?.creator?.id;
    let creatorType = gameData?.creator?.type; // "User" or "Group"

    if (creatorId && creatorType === "User") {
      try {
        const avatarRes = await fetchJson(
          `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${creatorId}&size=150x150&format=Png&isCircular=true`
        );
        creatorAvatar = avatarRes?.data?.[0]?.imageUrl || null;
      } catch (_) {}
    } else if (creatorId && creatorType === "Group") {
      try {
        const groupIconRes = await fetchJson(
          `https://thumbnails.roblox.com/v1/groups/icons?groupIds=${creatorId}&size=150x150&format=Png&isCircular=true`
        );
        creatorAvatar = groupIconRes?.data?.[0]?.imageUrl || null;
      } catch (_) {}
    }

    // Format numbers
    const visits = gameData?.visits || 0;
    const playing = gameData?.playing || 0;
    const upVotes = voteData?.upVotes || 0;
    const downVotes = voteData?.downVotes || 0;
    const totalVotes = upVotes + downVotes;
    const rating =
      totalVotes > 0 ? Math.round((upVotes / totalVotes) * 100) : null;

    function fmt(n) {
      if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(n);
    }

    return {
      universeId,
      placeId,
      thumbnailUrl: thumbData?.imageUrl || null,
      playing: fmt(playing),
      visits: fmt(visits),
      rating,
      creatorId,
      creatorType,
      creatorName: gameData?.creator?.name || null,
      creatorAvatar,
      maxPlayers: gameData?.maxPlayers || null,
      created: gameData?.created
        ? new Date(gameData.created).getFullYear()
        : null,
      updated: gameData?.updated || null,
    };
  } catch (err) {
    console.warn(`getRobloxGameData failed for placeId ${placeId}:`, err.message);
    return null;
  }
}

// ── Routes ───────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "RobloxAI Proxy" });
});

// Main search endpoint — called by Roblox game
app.post("/search", async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return res.status(400).json({ error: "Missing query" });
  }
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not set on server" });
  }

  console.log(`[search] "${query}"`);

  try {
    // 1. Ask Claude for game recommendations
    const claudeGames = await askClaude(query.trim());

    // 2. Enrich each game with live Roblox data (parallel)
    const enriched = await Promise.all(
      claudeGames.map(async (g) => {
        const live = await getRobloxGameData(g.placeId);
        return {
          // Claude data
          placeId: g.placeId,
          name: g.name,
          genre: g.genre,
          description: g.description,
          tags: g.tags || [],
          creatorName: live?.creatorName || g.creatorName || "Unknown",
          // Live Roblox data
          thumbnailUrl: live?.thumbnailUrl || null,
          playing: live?.playing || "—",
          visits: live?.visits || "—",
          rating: live?.rating || null,
          maxPlayers: live?.maxPlayers || null,
          created: live?.created || null,
          creatorAvatar: live?.creatorAvatar || null,
          creatorType: live?.creatorType || "User",
          universeId: live?.universeId || null,
        };
      })
    );

    return res.json({ games: enriched });
  } catch (err) {
    console.error("[search] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  RobloxAI proxy running on http://localhost:${PORT}`);
  console.log(`    POST /search  { query: "..." }`);
});
