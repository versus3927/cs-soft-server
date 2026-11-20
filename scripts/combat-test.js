'use strict';

// Юнит-тест боевой логики: софты реально влияют на игру.
// Проверяем аимбот+без отдачи (убивает), скорость банихопа, бесконечные патроны.

const assert = require('assert');
const { Game } = require('../server/game');

function makeFakeIo() {
  const emitted = [];
  const sockets = new Map();
  return {
    emitted,
    sockets: { sockets },
    emit: (ev, payload) => emitted.push({ ev, payload }),
    addSocket: (id) => {
      const s = { id, events: [], emit(ev, p) { this.events.push({ ev, p }); } };
      sockets.set(id, s);
      return s;
    },
  };
}

const io = makeFakeIo();
const game = new Game(io);
game.addPlayer(io.addSocket('s1'));
game.addPlayer(io.addSocket('s2'));
const [p1, p2] = [...game.players.values()];
game.state = 'live';
game.timer = 60;

// ставим вплотную в открытой зоне
p1.x = 720;
p1.y = 496;
p2.x = 860;
p2.y = 496;
p1.angle = 0;

// --- 1. обычная стрельба без софта: разброс есть, урон 26
p1.softs = [];
const before = p2.hp;
game.tryShoot(p1, game.stat(p1));
assert.strictEqual(game.bullets.length, 1, 'пуля не создана');
assert.strictEqual(p1.mag, 24, 'патрон не списан');
const dmgBase = game.bullets[0].damage;
assert.strictEqual(dmgBase, 26, 'базовый урон');

// --- 2. без отдачи: spread 0
p1.softs = ['norecoil'];
assert.strictEqual(game.stat(p1).spread, 0, 'norecoil не убрал разброс');

// --- 3. быстрая стрельба: задержка / 3
p1.softs = ['rapidfire'];
assert.ok(Math.abs(game.stat(p1).fireDelay - 0.04) < 1e-9, 'rapidfire');

// --- 4. двойной урон
p1.softs = ['onehit'];
assert.strictEqual(game.stat(p1).damage, 52, 'двойной урон');

// --- 5. бесконечные патроны
p1.softs = ['infammo'];
p1.mag = 0;
p1.cooldown = 0;
game.bullets.length = 0;
game.tryShoot(p1, game.stat(p1));
assert.strictEqual(game.bullets.length, 1, 'infammo не стреляет при пустом магазине');

// --- 6. спидхак/банихоп меняют множитель скорости
p1.softs = ['bhop'];
assert.ok(Math.abs(game.stat(p1).speedMul - 1.4) < 1e-9, 'bhop speed');
p1.softs = ['bhop', 'speedhack'];
assert.ok(Math.abs(game.stat(p1).speedMul - 1.95) < 1e-9, 'bhop+speedhack');

// --- 7. стрельба реально убивает: ставим aimbot и крутим апдейт
p1.softs = ['aimbot', 'norecoil', 'rapidfire'];
p1.angle = 0;
p2.hp = 100;
p2.alive = true;
p1.mag = 25;
p1.cooldown = 0;
let killed = false;
io.emitted.length = 0;
for (let i = 0; i < 300; i++) {
  p1.input.shoot = true;
  game.update(1 / 30);
  if (!p2.alive) {
    killed = true;
    break;
  }
}
assert.ok(killed, 'аимбот не убил цель за 10 секунд');
game.broadcastSnapshot();
const killEv = io.emitted.find((e) => e.ev === 'snap' && e.payload.ev.some((x) => x.type === 'kill'));
assert.ok(killEv, 'событие kill не отправлено');
assert.strictEqual(p1.kills, 1, 'счётчик убийств');

// --- 8. стрельба сквозь стену не проходит
const p3 = io.addSocket('s3');
const g2 = new Game(makeFakeIo());
g2.addPlayer(p3);
const q = [...g2.players.values()][0];
q.softs = [];
q.x = 80;
q.y = 80;
q.angle = Math.PI; // в стену слева
q.cooldown = 0;
g2.state = 'live';
g2.tryShoot(q, g2.stat(q));
const wallBullet = g2.bullets[0];
assert.ok(wallBullet, 'пуля в стену создана');
let blocked = false;
for (let i = 0; i < 40; i++) {
  g2.update(1 / 30);
  if (g2.bullets.length === 0) {
    blocked = true;
    break;
  }
}
assert.ok(blocked, 'пуля не остановилась стеной');

// --- 9. каждый раунд выдаётся новый (пере)набор софтов
const seen = new Set();
let changed = 0;
let prev = p1.softs.join(',');
for (let i = 0; i < 40; i++) {
  game.startRound();
  const cur = p1.softs.join(',');
  if (cur !== prev) changed++;
  prev = cur;
  for (const id of p1.softs) seen.add(id);
  assert.ok(game.bullets.length === 0, 'пули не очищены на старте раунда');
  assert.strictEqual(p1.hp, 100, 'hp не восстановлено');
  assert.strictEqual(p1.roundKills, 0, 'roundKills не сброшены');
}
assert.ok(changed > 30, 'софты почти не меняются между раундами: ' + changed);
assert.ok(seen.size >= 8, 'слишком мало разных софтов выпало: ' + seen.size);
assert.strictEqual(game.round, 40, 'счётчик раундов');

console.log('OK: боевая логика, все софты и ротация по раундам работают');
process.exit(0);
