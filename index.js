import express from "express";
import dotenv from "dotenv";

dotenv.config();

const {
  PORT = 3000,
  APP_BASE_URL,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REFRESH_TOKEN,
} = process.env;

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !APP_BASE_URL) {
  console.error("Missing env vars. Check SPOTIFY_CLIENT_ID/SECRET and APP_BASE_URL.");
  process.exit(1);
}

const app = express();

const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
].join(" ");

function toBasicAuth(id, secret) {
  return Buffer.from(`${id}:${secret}`).toString("base64");
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${APP_BASE_URL}/callback`,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${toBasicAuth(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function getAccessTokenViaRefreshToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${toBasicAuth(SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Refresh token failed: ${res.status} ${await res.text()}`);
  }
  return res.json(); 
}

async function fetchCurrentlyPlaying(accessToken) {
  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 204) return null; 
  if (res.status === 200) return res.json();

  const txt = await res.text();
  throw new Error(`Spotify API error ${res.status}: ${txt}`);
}

function esc(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSVG({ title, album, imageUrl, progressMs, durationMs, isPlaying }) {
  const width = 500;
  const height = 120;
  const padding = 16;

  const pct = durationMs > 0 ? Math.max(0, Math.min(1, progressMs / durationMs)) : 0;
  const barWidth = width - 140; 
  const filled = Math.round(barWidth * pct);

  const statusText = isPlaying ? "Now Playing" : "Not Playing";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(statusText)}: ${esc(title)}">
  <style>
    .card { fill: #0d1117; stroke: #30363d; }
    .text { font: 600 14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif; fill: #c9d1d9; }
    .muted { fill: #8b949e; font-weight: 500; }
  </style>
  <rect class="card" x="0.5" y="0.5" rx="12" ry="12" width="${width-1}" height="${height-1}" stroke-width="1"/>
  
  <!-- Album Art -->
  <image href="${esc(imageUrl)}" x="${padding}" y="${padding}" width="88" height="88" clip-path="url(#round)"/>
  <defs>
    <clipPath id="round"><rect x="${padding}" y="${padding}" width="88" height="88" rx="8" ry="8"/></clipPath>
  </defs>

  <!-- Text -->
  <text class="text" x="${padding + 88 + 16}" y="${padding + 8}" font-size="12">${esc(statusText)}</text>
  <text class="text" x="${padding + 88 + 16}" y="${padding + 32}" font-size="18">${esc(title || "—")}</text>
  <text class="text muted" x="${padding + 88 + 16}" y="${padding + 56}" font-size="14">${esc(album || "—")}</text>

  <!-- Progress -->
  <rect x="${padding + 88 + 16}" y="${padding + 72}" width="${barWidth}" height="8" fill="#30363d" rx="4" ry="4"/>
  <rect x="${padding + 88 + 16}" y="${padding + 72}" width="${filled}" height="8" fill="#1db954" rx="4" ry="4"/>
  <text class="text muted" x="${padding + 88 + 16}" y="${padding + 96}" font-size="12">${msToClock(progressMs)} / ${msToClock(durationMs)}</text>
</svg>`;
}

function msToClock(ms = 0) {
  if (!ms || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

app.get("/login", (req, res) => {
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: `${APP_BASE_URL}/callback`,
    scope: SCOPES,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get("/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing ?code");

    const tokens = await exchangeCodeForTokens(code);
    const refresh = tokens.refresh_token;
    if (!refresh) {
      return res.status(500).send("No refresh_token returned. Ensure you requested correct scopes.");
    }

    res.send(`
      <h2>Copy your Refresh Token</h2>
      <pre style="white-space:pre-wrap;word-break:break-all;">${refresh}</pre>
      <p>Put this in your .env as <code>SPOTIFY_REFRESH_TOKEN</code> and restart the server.</p>
    `);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

async function getNowPlayingPayload() {
  if (!SPOTIFY_REFRESH_TOKEN) {
    return { error: "Missing SPOTIFY_REFRESH_TOKEN. Hit /login and set it in .env." };
  }

  const { access_token } = await getAccessTokenViaRefreshToken(SPOTIFY_REFRESH_TOKEN);
  const data = await fetchCurrentlyPlaying(access_token);

  if (!data || !data.item) {
    return { isPlaying: false };
  }

  const isPlaying = Boolean(data.is_playing);
  const item = data.item;
  const title = item.name || "";
  const album = item.album?.name || "";
  const imageUrl = item.album?.images?.[0]?.url || "";
  const durationMs = item.duration_ms ?? 0;
  const progressMs = data.progress_ms ?? 0;

  return { isPlaying, title, album, imageUrl, durationMs, progressMs };
}

app.get("/now-playing.json", async (req, res) => {
  try {
    const payload = await getNowPlayingPayload();
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/now-playing.svg", async (req, res) => {
  try {
    const payload = await getNowPlayingPayload();

    let svg;
    if (payload.error) {
      svg = renderSVG({
        title: "Setup required",
        album: payload.error,
        imageUrl: "https://upload.wikimedia.org/wikipedia/commons/8/84/Spotify_icon.svg",
        progressMs: 0,
        durationMs: 0,
        isPlaying: false,
      });
    } else if (!payload.isPlaying) {
      svg = renderSVG({
        title: "Nothing playing",
        album: "Spotify",
        imageUrl: "https://upload.wikimedia.org/wikipedia/commons/8/84/Spotify_icon.svg",
        progressMs: 0,
        durationMs: 0,
        isPlaying: false,
      });
    } else {
      svg = renderSVG(payload);
    }

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.send(svg);
  } catch (e) {

    const err = esc(String(e));
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="500" height="80" viewBox="0 0 500 80" xmlns="http://www.w3.org/2000/svg">
  <rect x="0.5" y="0.5" rx="12" ry="12" width="499" height="79" fill="#0d1117" stroke="#30363d"/>
  <text x="16" y="48" fill="#e5534b" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="14">Error: ${err}</text>
</svg>`;
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache");
    res.status(200).send(svg);
  }
});

app.get("/", (req, res) => {
  res.type("html").send(`
    <h1>Spotify Now Playing</h1>
    <ul>
      <li><a href="/login">/login</a> – authorize and get your refresh token</li>
      <li><a href="/now-playing.json">/now-playing.json</a> – raw data</li>
      <li><a href="/now-playing.svg">/now-playing.svg</a> – embeddable card</li>
    </ul>
    <p>Set <code>APP_BASE_URL</code> in .env to your deployed URL for production.</p>
  `);
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
