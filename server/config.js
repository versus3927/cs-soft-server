'use strict';

// Единая точка, откуда сервер берёт все настройки.
//
// Источники (по приоритету, первый победил):
//   1. переменные окружения  — PORT=8080 ROUND_TIME=30 npm start
//   2. файл .env в корне     — локально, в git не попадает
//   3. значения по умолчанию — встроены ниже, менять ничего не обязательно
//
// Все переменные опциональны: без них сервер запускается и работает.

const FALLBACK = {
  PORT: 3000,
  HOST: '0.0.0.0',
  ROUND_TIME: 60,
  INTERMISSION: 8,
  MAX_PLAYERS: 16,
  DOUBLE_SOFT_CHANCE: 0.15,
  PLAYER_NAME: '',
  ALLOWED_ORIGIN: '*',
  ROUNDS_TOKEN: '',
  DATABASE_URL: '',
  GAME_ID: 'cs-soft',
};

// Встроенный разбор .env: строки KEY=VALUE, # — комментарий.
function loadDotEnv(file) {
  const fs = require('fs');
  const path = require('path');
  const full = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch {
    return [];
  }
  const loaded = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!key) continue;
    if (process.env[key] === undefined) {
      process.env[key] = val;
      loaded.push(key);
    }
  }
  return loaded;
}

const dotenvLoaded = loadDotEnv(process.env.ENV_FILE || '.env');

function str(key) {
  const v = process.env[key];
  return v === undefined || v === '' ? FALLBACK[key] : String(v);
}

function num(key, min, max) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return FALLBACK[key];
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[config] ${key}="${raw}" — не число, беру ${FALLBACK[key]}`);
    return FALLBACK[key];
  }
  const clamped = Math.min(Math.max(n, min), max);
  if (clamped !== n) console.warn(`[config] ${key}=${n} вне диапазона ${min}..${max}, беру ${clamped}`);
  return clamped;
}

const CONFIG = {
  PORT: Math.round(num('PORT', 1, 65535)),
  HOST: str('HOST'),
  ROUND_TIME: num('ROUND_TIME', 10, 3600),
  INTERMISSION: num('INTERMISSION', 2, 300),
  MAX_PLAYERS: Math.round(num('MAX_PLAYERS', 2, 64)),
  DOUBLE_SOFT_CHANCE: num('DOUBLE_SOFT_CHANCE', 0, 1),
  PLAYER_NAME: str('PLAYER_NAME').slice(0, 16),
  ALLOWED_ORIGIN: str('ALLOWED_ORIGIN'),
  ROUNDS_TOKEN: process.env.ROUNDS_TOKEN || '',
  DATABASE_URL: process.env.DATABASE_URL || '',
  GAME_ID: process.env.GAME_ID || 'cs-soft',
  dotenvLoaded,
};

module.exports = { CONFIG, FALLBACK, loadDotEnv };
