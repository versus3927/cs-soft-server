'use strict';

// Проверка подключения к базе: npm run db:check
// Показывает режим, версию Postgres, число раундов и лидерборд.

const { Pool } = require('pg');

(async () => {
  const url = process.env.DATABASE_URL || '';
  if (!url) {
    console.log('DATABASE_URL не задан → история раундов хранится в памяти.');
    console.log('Railway: добавь сервис Postgres и переменную DATABASE_URL (Railway сам подставит её в сервис).');
    process.exit(0);
  }

  const ssl = /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: url, ssl, connectionTimeoutMillis: 8000 });

  try {
    const ver = await pool.query('SELECT version()');
    const rounds = await pool.query('SELECT count(*)::int AS n FROM rounds').catch(() => ({ rows: [{ n: 'нет таблицы' }] }));
    const softs = await pool.query('SELECT count(*)::int AS n FROM round_softs').catch(() => ({ rows: [{ n: 'нет таблицы' }] }));
    const top = await pool
      .query(
        `SELECT player_name, COUNT(*)::int AS rounds
           FROM round_softs GROUP BY player_name ORDER BY rounds DESC LIMIT 5`
      )
      .catch(() => ({ rows: [] }));

    console.log('OK: подключение к PostgreSQL работает');
    console.log('  ' + ver.rows[0].version.split(' on ')[0]);
    console.log(`  раундов в базе: ${rounds.rows[0].n}, дропов: ${softs.rows[0].n}`);
    if (top.rows.length) {
      console.log('  лидерборд:');
      for (const r of top.rows) console.log(`    ${r.player_name}: ${r.rounds}`);
    } else {
      console.log('  лидерборд: пока пусто (сыграй раунд)');
    }
  } catch (e) {
    console.error('FAIL: не смог подключиться к базе');
    console.error('  ' + e.message);
    console.error('  Проверь DATABASE_URL и доступ по сети (Railway: Public Networking → TCP Proxy).');
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
})();
