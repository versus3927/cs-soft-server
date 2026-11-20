'use strict';

// Проверяет, что переменные окружения реально доходят до игры:
// PORT, PLAYER_NAME, ROUND_TIME, MAX_PLAYERS, DOUBLE_SOFT_CHANCE, HOST.

const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 4321;
const URL = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '0.0.0.0',
      PLAYER_NAME: 'EnvTester',
      ROUND_TIME: '10',
      INTERMISSION: '2',
      MAX_PLAYERS: '2',
      DOUBLE_SOFT_CHANCE: '1',
      ALLOWED_ORIGIN: '*',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += d));

  const fail = (m) => {
    console.error('FAIL:', m);
    console.error('--- лог сервера ---\n' + log);
    srv.kill();
    process.exit(1);
  };

  try {
    await wait(900);
    if (!/двойной дроп: 100%/.test(log)) fail('DOUBLE_SOFT_CHANCE не применён');
    if (!/макс\. игроков: 2/.test(log)) fail('MAX_PLAYERS не применён');
    if (!/раунд: 10s игры \+ 2s перерыв/.test(log)) fail('ROUND_TIME/INTERMISSION не применены');
    if (!new RegExp(`${PORT}`).test(log)) fail('PORT не применён');

    const sockets = [];
    const names = [];
    const softCounts = [];
    const roundTimes = [];

    for (let i = 0; i < 3; i++) {
      const s = io(URL, { transports: ['websocket'], forceNew: true });
      sockets.push(s);
      s.on('welcome', (d) => names.push(d.name));
      s.on('softs', (d) => softCounts.push(d.softs.length));
      s.on('roundStart', (d) => roundTimes.push(d.time));
      await wait(300);
    }

    // MAX_PLAYERS=2 → третий должен получить отказ
    if (names.length !== 2) fail(`MAX_PLAYERS=2 не сработал, подключилось ${names.length}`);
    if (!names.includes('EnvTester')) fail(`PLAYER_NAME не применился: ${names.join(',')}`);

    // DOUBLE_SOFT_CHANCE=1 → всегда два софта
    await wait(500);
    if (!softCounts.length) fail('softs не пришли');
    if (softCounts.some((n) => n !== 2)) fail(`ожидалось 2 софта всегда, получили ${softCounts}`);

    // roundStart уже мог пройти — ждём следующий, чтобы увидеть ROUND_TIME=10
    await wait(11000);
    if (!roundTimes.length) fail('roundStart не пришёл');
    if (roundTimes.some((t) => t !== 10)) fail(`ROUND_TIME не 10: ${roundTimes}`);

    console.log('OK: все переменные окружения доходят до игры');
    console.log(`  имена: ${names.join(', ')}`);
    console.log(`  софтов в дропе: ${softCounts.join(', ')} (DOUBLE_SOFT_CHANCE=1)`);
    console.log(`  время раунда: ${roundTimes.join(', ')}с (ROUND_TIME=10)`);

    sockets.forEach((s) => s.close());
    srv.kill();
    process.exit(0);
  } catch (e) {
    fail(e.stack || e.message);
  }
})();
