'use strict';

// Проверяет API, которое использует CS2-плагин:
// /api/rounds (история раздач) и /api/admin (nextround / soft / reroll).

const { spawn } = require('child_process');

const PORT = 4455;
const URL = `http://127.0.0.1:${PORT}`;
const TOKEN = 'test-bridge-token';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), ROUNDS_TOKEN: TOKEN, ROUND_TIME: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => (log += d));
  srv.stderr.on('data', (d) => (log += d));

  const fail = (m) => {
    console.error('FAIL:', m);
    console.error('--- лог ---\n' + log);
    srv.kill();
    process.exit(1);
  };
  const j = (r) => r.json();

  try {
    await wait(800);

    // плагин всегда стартует на карте с игроками: имитируем одного
    const ioMod = require('socket.io-client');
    const sock = ioMod.io(URL, { transports: ['websocket'], forceNew: true });
    await wait(500);

    // без токена — 401/403
    const noTok = await fetch(`${URL}/api/rounds`);
    if (noTok.status !== 401) fail(`без токена ожидали 401, получили ${noTok.status}`);

    // неверный токен — 401
    const badTok = await fetch(`${URL}/api/rounds`, { headers: { 'X-Rounds-Token': 'nope' } });
    if (badTok.status !== 401) fail(`с плохим токеном ожидали 401, получили ${badTok.status}`);

    // правильный токен — история (может быть пустой до первого раунда)
    const okTok = await fetch(`${URL}/api/rounds`, { headers: { 'X-Rounds-Token': TOKEN } }).then(j);
    if (!Array.isArray(okTok.rounds)) fail('/api/rounds не вернул массив');

    // nextround без токена — 401
    const admNoTok = await fetch(`${URL}/api/admin`, { method: 'POST', body: '{"action":"nextround"}' });
    if (admNoTok.status !== 401) fail('admin без токена пустил');

    // attach → сервер перестаёт крутить раунды сам
    const att = await fetch(`${URL}/api/admin`, {
      method: 'POST',
      headers: { 'X-Rounds-Token': TOKEN },
      body: JSON.stringify({ action: 'attach' }),
    }).then(j);
    if (!att.ok || att.externalRounds !== true) fail('attach не включил внешние раунды');

    // плагин сообщает о старте раунда с карты
    const rnd = await fetch(`${URL}/api/admin`, {
      method: 'POST',
      headers: { 'X-Rounds-Token': TOKEN },
      body: JSON.stringify({ action: 'round', round: 7 }),
    }).then(j);
    if (!rnd.ok || rnd.round !== 7) fail('round не применил номер: ' + JSON.stringify(rnd));
    if (!rnd.entry) fail('round не записал историю');

    // nextround с токеном
    const nr = await fetch(`${URL}/api/admin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rounds-Token': TOKEN },
      body: JSON.stringify({ action: 'nextround' }),
    }).then(j);
    if (!nr.ok) fail('nextround не сработал: ' + JSON.stringify(nr));

    // плагин делает это сразу после смены карты — раздаём раунд с игроком
    await fetch(`${URL}/api/admin`, {
      method: 'POST',
      headers: { 'X-Rounds-Token': TOKEN },
      body: JSON.stringify({ action: 'nextround' }),
    });
    await wait(200);
    const hist = await fetch(`${URL}/api/rounds`, { headers: { 'X-Rounds-Token': TOKEN } }).then(j);
    if (!hist.rounds.length) fail('история пуста после старта раунда с игроком');
    if (hist.rounds[hist.rounds.length - 1].players.length === 0) fail('в истории нет игроков');
    const last = hist.rounds[hist.rounds.length - 1];
    if (typeof last.round !== 'number') fail('в истории нет номера раунда');
    if (!Array.isArray(last.players)) fail('в истории нет игроков');

    // каждая запись софта содержит mechanic — это то, что плагин превращает в cfg
    for (const pl of last.players) {
      for (const s of pl.softs) {
        if (!s.id || !s.name) fail('софт без id/name в истории');
        if (typeof s.mechanic !== 'string') fail('софт без mechanic');
      }
    }

    // reroll
    const rr = await fetch(`${URL}/api/admin`, {
      method: 'POST',
      headers: { 'X-Rounds-Token': TOKEN },
      body: JSON.stringify({ action: 'reroll' }),
    }).then(j);
    if (!rr.ok) fail('reroll не сработал');

    // мусорная команда — 400
    const bad = await fetch(`${URL}/api/admin`, {
      method: 'POST',
      headers: { 'X-Rounds-Token': TOKEN },
      body: JSON.stringify({ action: 'drop_database' }),
    });
    if (bad.status !== 400) fail('неизвестное действие не отбито 400');

    // битый JSON — 400
    const broken = await fetch(`${URL}/api/admin`, {
      method: 'POST',
      headers: { 'X-Rounds-Token': TOKEN },
      body: '{oops',
    });
    if (broken.status !== 400) fail('битый JSON не отбит 400');

    sock.close();
    console.log('OK: API для CS2-плагина работает (attach/round/nextround/reroll)');
    console.log(`  раунд в истории: ${last.round}, записей: ${hist.rounds.length}`);
    console.log(`  механики в каталоге доступны, токен проверяется`);

    srv.kill();
    process.exit(0);
  } catch (e) {
    fail(e.stack || e.message);
  }
})();
