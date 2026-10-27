'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const STEAM_KEY = (process.env.STEAM_API_KEY || '').trim();
const DEFAULT_STEAM_ID = (process.env.STEAM_ID || '').trim();

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

/* ---------- маленький in-memory кэш, чтобы не долбить Steam ---------- */
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return v;
}

async function steamGet(pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `https://api.steampowered.com/${pathAndQuery}${sep}key=${STEAM_KEY}&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const err = new Error(`Steam API answered ${res.status}`);
    err.code = res.status === 403 ? 'bad_key' : 'steam_error';
    throw err;
  }
  return res.json();
}

/* Принимает 17-значный SteamID64, ссылку на профиль или vanity-имя */
async function resolveSteamId(input) {
  const raw = String(input || DEFAULT_STEAM_ID || '').trim();
  if (!raw) return null;
  if (/^\d{17}$/.test(raw)) return raw;
  const byId = raw.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (byId) return byId[1];
  const vanity = raw
    .replace(/^https?:\/\/steamcommunity\.com\/id\//, '')
    .replace(/\/+$/, '');
  if (!/^[\w-]{2,64}$/.test(vanity)) return null;
  const data = await cached('vanity:' + vanity, 3600e3, () =>
    steamGet(`ISteamUser/ResolveVanityURL/v1/?vanityurl=${encodeURIComponent(vanity)}`)
  );
  return data.response && data.response.success === 1 ? data.response.steamid : null;
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error('[steam]', e.message);
    res.status(502).json({ error: e.code || 'steam_error' });
  });

/* ---------- API ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/steam/config', (req, res) =>
  res.json({ configured: Boolean(STEAM_KEY), hasDefaultId: Boolean(DEFAULT_STEAM_ID) })
);

// Что сейчас запущено у пользователя (для Shadow Tracker и учёта часов)
app.get(
  '/api/steam/now',
  wrap(async (req, res) => {
    if (!STEAM_KEY) return res.status(503).json({ error: 'not_configured' });
    const id = await resolveSteamId(req.query.steamid);
    if (!id) return res.status(400).json({ error: 'no_steam_id' });

    const data = await cached('now:' + id, 20e3, () =>
      steamGet(`ISteamUser/GetPlayerSummaries/v2/?steamids=${id}`)
    );
    const p = data.response && data.response.players && data.response.players[0];
    if (!p) return res.status(404).json({ error: 'player_not_found' });

    res.json({
      steamId: id,
      persona: p.personaname,
      avatar: p.avatarfull,
      visible: p.communityvisibilitystate === 3,
      gameId: p.gameid || null,
      game: p.gameextrainfo || null,
      ts: Date.now(),
    });
  })
);

// Игры за последние 2 недели + общее время (для сверки и статистики)
app.get(
  '/api/steam/recent',
  wrap(async (req, res) => {
    if (!STEAM_KEY) return res.status(503).json({ error: 'not_configured' });
    const id = await resolveSteamId(req.query.steamid);
    if (!id) return res.status(400).json({ error: 'no_steam_id' });

    const data = await cached('recent:' + id, 60e3, () =>
      steamGet(`IPlayerService/GetRecentlyPlayedGames/v1/?steamid=${id}&count=0`)
    );
    const games = ((data.response && data.response.games) || []).map((g) => ({
      appid: g.appid,
      name: g.name,
      playtime_2weeks: g.playtime_2weeks || 0,
      playtime_forever: g.playtime_forever || 0,
    }));
    res.json({ steamId: id, games });
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.listen(PORT, () => {
  console.log(`LifeLine запущен на порту ${PORT}`);
  console.log(STEAM_KEY ? 'Steam API: ключ найден' : 'Steam API: ключа нет — работает демо-режим');
});
