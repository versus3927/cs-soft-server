'use strict';

// ─────────────────────────────────────────────────────────────
//  Хранилище истории раундов.
//
//  Работает в двух режимах:
//    • DATABASE_URL задан  → PostgreSQL (Railway Postgres / Supabase / свой)
//    • DATABASE_URL пуст   → память (как раньше), ничего не ломается
//
//  Главное правило: база — вспомогательная. Если она отвалилась,
//  игра продолжается, просто история не пишется.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.rows = [];
    this.seq = 0;
  }

  async init() {
    return this;
  }

  get available() {
    return false;
  }

  async saveRound(entry) {
    const row = { id: ++this.seq, entry, at: new Date().toISOString() };
    this.rows.push(row);
    if (this.rows.length > 200) this.rows.shift();
    return row.id;
  }

  async recentRounds(limit = 10) {
    return this.rows.slice(-limit).map((r) => r.entry).reverse();
  }

  async playerStats(name, limit = 20) {
    const counts = new Map();
    for (const r of this.rows) {
      for (const p of r.entry.players || []) {
        if (name && p.name.toLowerCase() !== String(name).toLowerCase()) continue;
        for (const s of p.softs || []) {
          counts.set(s.id, (counts.get(s.id) || 0) + 1);
        }
      }
    }
    return [...counts.entries()]
      .map(([soft_id, times]) => ({ soft_id, times }))
      .sort((a, b) => b.times - a.times)
      .slice(0, limit);
  }

  async leaderboard(limit = 10) {
    const counts = new Map();
    for (const r of this.rows) {
      for (const p of r.entry.players || []) {
        counts.set(p.name, (counts.get(p.name) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([player_name, rounds]) => ({ player_name, rounds }))
      .sort((a, b) => b.rounds - a.rounds)
      .slice(0, limit);
  }

  async close() {}
}

class PgStore {
  constructor(url, options = {}) {
    this.kind = 'postgres';
    this.url = url;
    this.game = options.game || 'cs-soft';
    this.pool = null;
    this.healthy = false;
    this.Pg = options.Pg || require('pg').Pool;
  }

  async init() {
    this.pool = new this.Pg({
      connectionString: this.url,
      // Railway и большинство managed-Postgres требуют SSL с публичного адреса
      ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(this.url)
        ? false
        : { rejectUnauthorized: false },
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.pool.on('error', () => {
      this.healthy = false;
    });

    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    await this.pool.query(sql);
    this.healthy = true;
    return this;
  }

  get available() {
    return this.healthy;
  }

  async saveRound(entry) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO rounds (game, round_no, started_at)
         VALUES ($1, $2, COALESCE($3::timestamptz, now()))
         ON CONFLICT (game, round_no) DO UPDATE SET started_at = EXCLUDED.started_at
         RETURNING id`,
        [this.game, entry.round, entry.at || null]
      );
      const roundId = ins.rows[0].id;

      // перезапись раунда (например, при reroll) — сначала чистим
      await client.query('DELETE FROM round_softs WHERE round_id = $1', [roundId]);

      for (const p of entry.players || []) {
        for (const s of p.softs || []) {
          await client.query(
            `INSERT INTO round_softs (round_id, player_id, player_name, soft_id, soft_name, rarity, mechanic)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [roundId, p.id, p.name, s.id, s.name, s.rarity, s.mechanic || null]
          );
          await client.query(
            `INSERT INTO player_soft_stats (player_name, soft_id, times_total, last_seen)
             VALUES ($1, $2, 1, now())
             ON CONFLICT (player_name, soft_id)
             DO UPDATE SET times_total = player_soft_stats.times_total + 1, last_seen = now()`,
            [p.name, s.id]
          );
        }
      }
      await client.query('COMMIT');
      this.healthy = true;
      return roundId;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      this.healthy = false;
      throw e;
    } finally {
      client.release();
    }
  }

  async recentRounds(limit = 10) {
    const { rows } = await this.pool.query(
      `SELECT r.round_no, r.started_at,
              COALESCE(json_agg(json_build_object(
                'player', rs.player_name, 'soft', rs.soft_id,
                'name', rs.soft_name, 'rarity', rs.rarity))
                FILTER (WHERE rs.id IS NOT NULL), '[]') AS drops
         FROM rounds r
         LEFT JOIN round_softs rs ON rs.round_id = r.id
        WHERE r.game = $1
        GROUP BY r.id, r.round_no, r.started_at
        ORDER BY r.round_no DESC
        LIMIT $2`,
      [this.game, limit]
    );
    this.healthy = true;
    return rows;
  }

  async playerStats(name, limit = 20) {
    const { rows } = await this.pool.query(
      `SELECT soft_id, times_total AS times, last_seen
         FROM player_soft_stats
        WHERE lower(player_name) = lower($1)
        ORDER BY times_total DESC
        LIMIT $2`,
      [name, limit]
    );
    return rows;
  }

  async leaderboard(limit = 10) {
    const { rows } = await this.pool.query(
      `SELECT player_name, COUNT(*)::int AS rounds
         FROM round_softs
        GROUP BY player_name
        ORDER BY rounds DESC
        LIMIT $1`,
      [limit]
    );
    return rows;
  }

  async close() {
    if (this.pool) await this.pool.end().catch(() => {});
  }
}

/**
 * @param {{url?: string, game?: string, logger?: object, Pg?: Function}} opts
 */
async function createStore(opts = {}) {
  const log = opts.logger || console;
  const url = opts.url !== undefined ? opts.url : process.env.DATABASE_URL || '';

  if (!url) {
    log.info && log.info('[db] DATABASE_URL не задан — история раундов хранится в памяти');
    return new MemoryStore().init();
  }

  const store = new PgStore(url, { game: opts.game, Pg: opts.Pg });
  try {
    await store.init();
    log.info && log.info('[db] PostgreSQL подключён, схема применена');
    return store;
  } catch (e) {
    log.warn && log.warn(`[db] не смог подключиться к PostgreSQL (${e.message}) — работаю на памяти`);
    return new MemoryStore().init();
  }
}

module.exports = { createStore, MemoryStore, PgStore };
