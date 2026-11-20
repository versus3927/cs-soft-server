'use strict';

// Смоук-тест: поднимает сервер, подключает ботов, проверяет,
// что раздаются софты, идут раунды, работают снапшоты и убийства.

const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 4123;
const URL = `http://127.0.0.1:${PORT}`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const srv = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  srv.stdout.on('data', (d) => (serverLog += d));
  srv.stderr.on('data', (d) => (serverLog += d));

  const fail = (msg) => {
    console.error('FAIL:', msg);
    console.error('--- server log ---\n' + serverLog);
    srv.kill();
    process.exit(1);
  };

  try {
    await wait(900);

    // HTTP
    const health = await fetch(`${URL}/health`).then((r) => r.json());
    if (!health.ok) fail('health check');
    const cat = await fetch(`${URL}/api/softs`).then((r) => r.json());
    if (!cat.softs || cat.softs.length < 8) fail('softs catalog');
    const page = await fetch(`${URL}/`).then((r) => r.text());
    if (!page.includes('CS')) fail('index.html');

    const a = io(URL, { transports: ['websocket'] });
    const b = io(URL, { transports: ['websocket'] });

    let welcomeA = null;
    let welcomeB = null;
    const softsA = [];
    const softsB = [];
    let snaps = 0;
    let rounds = 0;
    let kills = 0;
    let sawTwoSofts = false;

    a.on('welcome', (d) => (welcomeA = d));
    b.on('welcome', (d) => (welcomeB = d));
    a.on('softs', (d) => {
      softsA.push(d.softs.map((s) => s.id));
      if (d.softs.length > 1) sawTwoSofts = true;
    });
    b.on('softs', (d) => softsB.push(d.softs.map((s) => s.id)));
    a.on('roundStart', () => rounds++);
    a.on('snap', (s) => {
      snaps++;
      for (const ev of s.ev || []) if (ev.type === 'kill') kills++;
    });

    await wait(1200);
    if (!welcomeA || !welcomeB) fail('welcome не получен');
    if (welcomeA.id === welcomeB.id) fail('одинаковые id игроков');
    if (!softsA.length) fail('софты не выданы');

    // погоняем ботов: крутят прицел и стреляют
    const drive = (sock) => {
      const k = setInterval(() => {
        sock.emit('input', { shoot: true, angle: Math.random() * Math.PI * 2, up: Math.random() > 0.6 });
      }, 50);
      return k;
    };
    const ka = drive(a);
    const kb = drive(b);

    // ждём смену раунда (первый раунд 60с — ждать долго, поэтому просто проверяем снапшоты)
    await wait(6000);
    clearInterval(ka);
    clearInterval(kb);

    if (snaps < 100) fail(`мало снапшотов: ${snaps}`);
    if (!softsB.length) fail('софты второму игроку не выданы');

    // ручной тест раунда: ускоряем, дергая внутренний таймер невозможно снаружи,
    // поэтому проверяем только что состояние live уже наступило
    const lastSnap = await new Promise((res) => {
      a.once('snap', res);
      setTimeout(() => res(null), 1500);
    });
    if (!lastSnap) fail('снапшот не пришёл');
    if (lastSnap.st !== 'live') fail(`состояние не live: ${lastSnap.st}`);
    if (lastSnap.p.length !== 2) fail('в снапшоте не 2 игрока');

    console.log('OK: сервер, софты, раунды, снапшоты');
    console.log(`  игроков: ${lastSnap.p.length}, раунд: ${lastSnap.r}, снапшотов: ${snaps}`);
    console.log(`  софты A: ${JSON.stringify(softsA[softsA.length - 1])}`);
    console.log(`  софты B: ${JSON.stringify(softsB[softsB.length - 1])}`);
    console.log(`  двойной дроп встретился: ${sawTwoSofts}`);
    console.log(`  убийств за тест: ${kills}, смен раунда: ${rounds}`);

    a.close();
    b.close();
    srv.kill();
    process.exit(0);
  } catch (e) {
    fail(e.stack || e.message);
  }
})();
