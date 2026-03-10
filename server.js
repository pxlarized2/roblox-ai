// ============================================================
//  RobloxAI Proxy Server v3
//  npm install express cors node-fetch dotenv
// ============================================================
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

async function fetchJson(url, options = {}) {
  const { default: fetch } = await import("node-fetch");
  const res = await fetch(url, {
    ...options,
    headers: { "Accept": "application/json", ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ── Search Roblox directly ────────────────────────────────────
async function searchRoblox(query) {
  try {
    // Roblox Games search API
    const encoded = encodeURIComponent(query);
    const data = await fetchJson(
      `https://games.roblox.com/v1/games/list?model.keyword=${encoded}&model.startRows=0&model.maxRows=18&model.hasVerifiedCreator=false`
    );
    return (data.games || []).map(g => ({
      placeId: g.placeId,
      universeId: g.universeId,
      name: g.name,
      playerCount: g.playerCount,
      totalUpVotes: g.totalUpVotes,
      totalDownVotes: g.totalDownVotes,
    }));
  } catch (err) {
    console.warn("Roblox search failed:", err.message);
    return [];
  }
}

// ── Get universe ID from place ID ─────────────────────────────
async function getUniverseId(placeId) {
  try {
    const data = await fetchJson(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    return data.universeId || null;
  } catch { return null; }
}

// ── Get bulk game details ─────────────────────────────────────
async function getGamesDetails(universeIds) {
  try {
    const ids = universeIds.join(",");
    const data = await fetchJson(`https://games.roblox.com/v1/games?universeIds=${ids}`);
    return data.data || [];
  } catch { return []; }
}

async function getGamesVotes(universeIds) {
  try {
    const ids = universeIds.join(",");
    const data = await fetchJson(`https://games.roblox.com/v1/games/votes?universeIds=${ids}`);
    return data.data || [];
  } catch { return []; }
}

// ── Ask Claude to pick + describe best matches ─────────────────
async function askClaude(query, robloxResults) {
  const { default: fetch } = await import("node-fetch");

  let contextBlock = "";
  if (robloxResults.length > 0) {
    contextBlock = `\nHere are real games currently returned by Roblox's search for "${query}":\n` +
      robloxResults.map((g, i) =>
        `${i+1}. "${g.name}" (placeId: ${g.placeId}, universeId: ${g.universeId}, players online: ${g.playerCount || 0})`
      ).join("\n") +
      `\n\nPrioritize these real results. You may also add well-known games not in this list if highly relevant.`;
  }

  const prompt = `You are an expert Roblox game recommender.
A player searched: "${query}"
${contextBlock}

Return EXACTLY 6 Roblox games best matching this search.
For each game provide:
- placeId     : numeric Roblox Place ID
- universeId  : numeric universe ID (use from context above if available, else estimate)  
- name        : exact game name
- genre       : one word: Adventure, Horror, Tycoon, Obby, RPG, Simulator, Battle, Roleplay, Fighting, Platformer, Sports, Puzzle
- description : 2 punchy sentences about what makes this game fun and unique
- whyMatch    : 1 sentence explaining why this matches the search query specifically
- tags        : array of 3 short tags
- creatorName : creator or group name
- creatorId   : numeric creator/group ID
- creatorType : "User" or "Group"

Mix popular AND niche/hidden-gem games when relevant. Don't only pick the most famous games.
Respond ONLY with a raw JSON array. No markdown, no backticks.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1800,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.map(b => b.text || "").join("") || "";
  return JSON.parse(text.replace(/```json|```/gi, "").trim());
}

// ── Ask Claude about a specific game (chat) ───────────────────
async function askClaudeAboutGame(gameInfo, userMessage, history) {
  const { default: fetch } = await import("node-fetch");

  const systemPrompt = `You are an enthusiastic Roblox expert talking about the game "${gameInfo.name}" by ${gameInfo.creatorName}.
Game info: Genre: ${gameInfo.genre}. Description: ${gameInfo.description}.
Answer questions about this game in a helpful, conversational way. Keep answers under 3 sentences. Be specific and knowledgeable.`;

  const messages = [
    ...(history || []),
    { role: "user", content: userMessage }
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: systemPrompt,
      messages,
    }),
  });

  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text || "I'm not sure about that!";
}

function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

// ── Routes ────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", service: "RobloxAI v3" }));

app.post("/search", async (req, res) => {
  const { query } = req.body;
  if (!query?.trim()) return res.status(400).json({ error: "Missing query" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "No API key" });

  console.log(`[search] "${query}"`);

  try {
    // 1. Real Roblox search in parallel with Claude
    const [robloxResults, _] = await Promise.allSettled([
      searchRoblox(query),
      Promise.resolve()
    ]);
    const roblox = robloxResults.status === "fulfilled" ? robloxResults.value : [];
    console.log(`  Roblox returned ${roblox.length} results`);

    // 2. Claude picks + describes best 6
    const claudeGames = await askClaude(query.trim(), roblox);

    // 3. Enrich with live Roblox data
    const universeIds = claudeGames
      .map(g => g.universeId)
      .filter(Boolean);

    const [details, votes] = await Promise.all([
      universeIds.length ? getGamesDetails(universeIds) : Promise.resolve([]),
      universeIds.length ? getGamesVotes(universeIds) : Promise.resolve([]),
    ]);

    const detailMap = {};
    const voteMap = {};
    details.forEach(d => { detailMap[d.id] = d; });
    votes.forEach(v => { voteMap[v.id] = v; });

    const enriched = claudeGames.map(g => {
      const uid = g.universeId;
      const d = uid ? detailMap[uid] : null;
      const v = uid ? voteMap[uid] : null;
      const up = v?.upVotes || 0;
      const down = v?.downVotes || 0;
      const total = up + down;

      return {
        placeId:     g.placeId,
        universeId:  uid || null,
        name:        g.name,
        genre:       g.genre,
        description: g.description,
        whyMatch:    g.whyMatch || "",
        tags:        g.tags || [],
        creatorName: d?.creator?.name || g.creatorName || "Unknown",
        creatorId:   d?.creator?.id || g.creatorId || null,
        creatorType: d?.creator?.type || g.creatorType || "User",
        playing:     d?.playing != null ? fmt(d.playing) : null,
        visits:      d?.visits  != null ? fmt(d.visits)  : null,
        rating:      total > 0 ? Math.round((up / total) * 100) : null,
        maxPlayers:  d?.maxPlayers || null,
      };
    });

    return res.json({ games: enriched });
  } catch (err) {
    console.error("[search] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Chat about a specific game
app.post("/chat", async (req, res) => {
  const { gameInfo, message, history } = req.body;
  if (!gameInfo || !message) return res.status(400).json({ error: "Missing fields" });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "No API key" });

  try {
    const reply = await askClaudeAboutGame(gameInfo, message, history || []);
    return res.json({ reply });
  } catch (err) {
    console.error("[chat] error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`RobloxAI proxy v3 on :${PORT}`));
