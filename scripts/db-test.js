'use strict';

// Проверяет слой хранения: SQL-запросы PgStore (на фейковом пуле),
// фолбэк на память и режим «база упала — игра живёт».

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createStore, MemoryStore, PgStore } = require('../server/storage/db');

// ── фейковый pg-пул: запоминает запросы и отдаёт предсказуемые ответы ──
function makeFakePg({ failOn } = {}) {
  const queries = [];
  const state = { rounds: new Map(), drops: [], stats: new Map() };

  class FakePool {
    constructor(cfg) {
      this.cfg = cfg;
      this.connCfg = cfg;
    }
    on() {}
    async query(sql, params = []) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (failOn && sql.includes(failOn)) throw new Error('connection refused');

      if (sql.includes('CREATE TABLE')) return { rows: [] };

      if (sql.includes('INSERT INTO rounds')) {
        const roundNo = params[1];
        if (!state.rounds.has(roundNo)) state.rounds.set(roundNo, state.rounds.size + 1);
        return { rows: [{ id: state.rounds.get(roundNo) }] };
      }
      if (sql.includes('DELETE FROM round_softs')) {
        const rid = params[0];
        state.drops = state.drops.filter((d) => d.round_id !== rid);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO round_softs')) {
        const [round_id, player_id, player_name, soft_id, soft_name, rarity, mechanic] = params;
        state.drops.push({ round_id, player_id, player_name, soft_id, soft_name, rarity, mechanic });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO player_soft_stats')) {
        const [name, softId] = params;
        const key = name + '|' + softId;
        state.stats.set(key, (state.stats.get(key) || 0) + 1);
        return { rows: [] };
      }
      if (sql.includes('FROM round_softs') && sql.includes('GROUP BY player_name')) {
        const counts = {};
        for (const d of state.drops) counts[d.player_name] = (counts[d.player_name] || 0) + 1;
        const rows = Object.entries(counts)
          .map(([player_name, rounds]) => ({ player_name, rounds }))
          .sort((a, b) => b.rounds - a.rounds)
          .slice(0, params[0]);
        return { rows };
      }
      if (sql.includes('FROM player_soft_stats')) {
        const rows = [...state.stats.entries()]
          .filter(([k]) => k.toLowerCase().startsWith(String(params[0]).toLowerCase() + '|'))
          .map(([k, times]) => ({ soft_id: k.split('|')[1], times }))
          .sort((a, b) => b.times - a.times)
          .slice(0, params[1]);
        return { rows };
      }
      if (sql.includes('FROM rounds')) {
        const rows = [...state.rounds.keys()]
          .sort((a, b) => b - a)
          .slice(0, params[1])
          .map((n) => ({
            round_no: n,
            started_at: new Date().toISOString(),
            drops: state.drops
              .filter((d) => d.round_id === state.rounds.get(n))
              .map((d) => ({ player: d.player_name, soft: d.soft_id, name: d.soft_name, rarity: d.rarity })),
          }));
        return { rows };
      }
      return { rows: [] };
    }
    async connect() {
      return {
        query: (sql, params) => this.query(sql, params),
        release: () => {},
      };
    }
    async end() {}
  }
  return { Pg: FakePool, queries, state };
}

(async () => {
  // ── 1. без DATABASE_URL — память, ничего не падает ──
  const mem = await createStore({ url: '', logger: { info() {}, warn() {} } });
  assert.ok(mem instanceof MemoryStore, 'без URL должен быть MemoryStore');
  assert.strictEqual(mem.available, false);

  const entry = {
    round: 1,
    at: new Date().toISOString(),
    players: [
      { id: 1, name: 'Neo', softs: [{ id: 'aimbot', name: 'AIMBOT', rarity: 'epic', mechanic: 'aim' }] },
      { id: 2, name: 'Trinity', softs: [{ id: 'bhop', name: 'БАНИХОП', rarity: 'rare', mechanic: 'bhop' }] },
    ],
  };
  await mem.saveRound(entry);
  await mem.saveRound({ ...entry, round: 2 });
  const memRounds = await mem.recentRounds(5);
  assert.strictEqual(memRounds.length, 2, 'память: 2 раунда');
  assert.strictEqual(memRounds[0].round, 2, 'память: свежий раунд первым');
  const memLb = await mem.leaderboard(5);
  assert.strictEqual(memLb.length, 2, 'память: лидерборд по двум игрокам');
  assert.strictEqual(memLb[0].rounds, 2, 'память: у каждого по 2 раунда');
  const memStats = await mem.playerStats('neo');
  assert.deepStrictEqual(memStats[0], { soft_id: 'aimbot', times: 2 }, 'память: статистика игрока');

  // ── 2. PgStore на фейковом пуле ──
  const fake = makeFakePg();
  const pg = new PgStore('postgresql://u:p@db:5432/cs', { Pg: fake.Pg, game: 'cs-soft' });
  await pg.init();
  assert.ok(pg.available, 'PgStore должен быть доступен после init');
  assert.ok(
    fake.queries.some((q) => q.sql.includes('CREATE TABLE IF NOT EXISTS rounds')),
    'схема применяется при старте'
  );

  const id1 = await pg.saveRound(entry);
  assert.ok(id1 > 0, 'saveRound вернул id');
  const id2 = await pg.saveRound({ ...entry, round: 2 });
  assert.ok(id2 > id1, 'id растёт');

  // все дропы попали в round_softs с механиками
  assert.strictEqual(fake.state.drops.length, 4, 'два раунда × два игрока');
  assert.ok(fake.state.drops.every((d) => d.mechanic), 'у каждого дропа есть mechanic');

  // лидерборд
  const lb = await pg.leaderboard(10);
  assert.strictEqual(lb.length, 2, 'лидерборд: 2 игрока');
  assert.strictEqual(lb[0].rounds, 2, 'лидерборд: по 2 раунда');

  // личная статистика
  const st = await pg.playerStats('Trinity');
  assert.strictEqual(st[0].soft_id, 'bhop', 'статистика: любимый софт Тринити');
  assert.strictEqual(st[0].times, 2, 'статистика: дважды');

  // история раундов
  const rounds = await pg.recentRounds(10);
  assert.strictEqual(rounds.length, 2, 'история: 2 раунда');
  assert.strictEqual(rounds[0].round_no, 2, 'история: свежий первым');
  assert.strictEqual(rounds[0].drops.length, 2, 'история: дропы внутри раунда');

  // reroll того же раунда не дублирует записи
  await pg.saveRound({ ...entry, round: 2 });
  assert.strictEqual(fake.state.drops.length, 4, 'повторное сохранение раунда не дублирует дропы');

  // транзакция соблюдается
  assert.ok(fake.queries.some((q) => q.sql === 'BEGIN'), 'есть BEGIN');
  assert.ok(fake.queries.some((q) => q.sql === 'COMMIT'), 'есть COMMIT');

  // ── 3. база упала на середине — saveRound кидает, но сервер жив ──
  const broken = makeFakePg({ failOn: 'INSERT INTO round_softs' });
  const pgBroken = new PgStore('postgresql://u:p@db:5432/cs', { Pg: broken.Pg });
  await pgBroken.init();
  let threw = false;
  try {
    await pgBroken.saveRound(entry);
  } catch {
    threw = true;
  }
  assert.ok(threw, 'при обрыве базы saveRound сообщает об ошибке');
  assert.strictEqual(pgBroken.available, false, 'после ошибки хранилище помечено недоступным');

  // ── 4. недоступная база при старте → откат на память ──
  const deadFake = makeFakePg({ failOn: 'CREATE TABLE' });
  const storeDead = await createStore({
    url: 'postgresql://u:p@nowhere:5432/x',
    Pg: deadFake.Pg,
    logger: { info() {}, warn() {} },
  });
  assert.ok(storeDead instanceof MemoryStore, 'если база недоступна — память');

  // ── 5. схема на месте и содержит нужные таблицы ──
  const schema = fs.readFileSync(path.join(__dirname, '../server/storage/schema.sql'), 'utf8');
  for (const t of ['rounds', 'round_softs', 'player_soft_stats']) {
    assert.ok(schema.includes(`CREATE TABLE IF NOT EXISTS ${t}`), `схема: таблица ${t}`);
  }
  assert.ok(schema.includes('UNIQUE (game, round_no)'), 'схема: идемпотентность раунда');

  console.log('OK: хранилище работает и в Postgres, и без него');
  console.log('  память: история, лидерборд, личная статистика');
  console.log('  postgres: транзакции, upsert, без дублей при reroll');
  console.log('  обрыв базы: игра продолжается, ошибка логируется');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.stack || e.message);
  process.exit(1);
});
