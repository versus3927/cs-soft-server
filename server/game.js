'use strict';

const map = require('./map');
const { SOFTS, rollSofts } = require('./softs');

const CFG = {
  TICK: 30,
  SNAP_EVERY: 1, // 30 снапшотов/с
  ROUND_TIME: 60,
  INTERMISSION: 8,
  MAX_HP: 100,
  RADIUS: 12,
  BASE_SPEED: 200,
  ACCEL: 16,
  BHOP_ACCEL: 60,
  BULLET_SPEED: 1150,
  BULLET_LIFE: 1.1,
  DAMAGE: 26,
  FIRE_DELAY: 0.12,
  MAG: 25,
  RELOAD: 1.6,
  BASE_SPREAD: 0.026,
  MOVE_SPREAD: 0.05,
  RESPAWN: 2.5,
  AIMBOT_RANGE: 620,
  AIMBOT_FOV: 1.5,
  TRIGGER_CONE: 0.06,
  MAX_PLAYERS: 16,
};

// Переопределения для тестов/тюнинга: ROUND_TIME=10 INTERMISSION=3 npm start
if (process.env.ROUND_TIME) CFG.ROUND_TIME = Number(process.env.ROUND_TIME);
if (process.env.INTERMISSION) CFG.INTERMISSION = Number(process.env.INTERMISSION);

const NAMES_POOL = [
  'Neo', 'Trinity', 'Morpheus', 'Cypher', 'Tank', 'Dozer', 'Switch', 'Apoc',
  'Mouse', 'Oracle', 'Seraph', 'Merovingian', 'Ghost', 'Niobe', 'Link', 'Kid',
];

const DEFAULTS = {
  hp: CFG.MAX_HP,
  mag: CFG.MAG,
  reloading: 0,
  cooldown: 0,
  alive: true,
  respawnAt: 0,
  kills: 0,
  deaths: 0,
  roundKills: 0,
};

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function angleDiff(a, b) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Пересекает ли окружность (x,y,r) твёрдую клетку карты
function circleHits(x, y, r) {
  const minTx = Math.floor((x - r) / map.TILE);
  const maxTx = Math.floor((x + r) / map.TILE);
  const minTy = Math.floor((y - r) / map.TILE);
  const maxTy = Math.floor((y + r) / map.TILE);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!map.isSolidTile(tx, ty)) continue;
      const rx = tx * map.TILE;
      const ry = ty * map.TILE;
      const nx = clamp(x, rx, rx + map.TILE);
      const ny = clamp(y, ry, ry + map.TILE);
      if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true;
    }
  }
  return false;
}

// Прямая видимость между двумя точками (для аимбота/триггербота)
function visible(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 10);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (map.isSolidAt(ax + dx * t, ay + dy * t)) return false;
  }
  return true;
}

let nextPlayerId = 1;

class Game {
  constructor(io) {
    this.io = io;
    this.players = new Map();
    this.bullets = [];
    this.events = [];
    this.round = 0;
    this.state = 'intermission';
    this.timer = 3; // короткий старт до первого раунда
    this.tickCount = 0;
    this.roundStats = [];
    this.lastSpawns = [];
    this.tickAcc = 0;
    this.lastTime = Date.now();

    setInterval(() => this.loop(), 1000 / CFG.TICK);
  }

  // ---------- игроки ----------
  addPlayer(socket) {
    if (this.players.size >= CFG.MAX_PLAYERS) {
      socket.emit('serverFull');
      return null;
    }
    const used = new Set([...this.players.values()].map((p) => p.name));
    let name = 'Player';
    for (const n of NAMES_POOL) {
      if (!used.has(n)) {
        name = n;
        break;
      }
    }
    if (used.has(name)) name = 'Player' + nextPlayerId;

    const hue = Math.floor(Math.random() * 360);
    const p = {
      id: nextPlayerId++,
      socketId: socket.id,
      name,
      color: `hsl(${hue} 85% 62%)`,
      x: 0,
      y: 0,
      angle: 0,
      a: 0,
      vx: 0,
      vy: 0,
      input: { up: false, down: false, left: false, right: false, shoot: false },
      softs: [],
      spin: 0,
      ...DEFAULTS,
    };
    this.players.set(p.id, p);
    this.assignSpawn(p);
    this.giveSofts(p, true);
    this.pushEvent({ type: 'join', name: p.name, color: p.color });
    socket.emit('welcome', {
      id: p.id,
      name: p.name,
      color: p.color,
      config: CFG,
      map: { tile: map.TILE, rows: map.rows, width: map.WORLD_WIDTH, height: map.WORLD_HEIGHT },
    });
    this.sendSofts(p, true);
    return p;
  }

  renamePlayer(id, raw) {
    const p = this.players.get(id);
    if (!p || typeof raw !== 'string') return;
    const name = raw.replace(/[^\p{L}\p{N}_\- ]/gu, '').trim().slice(0, 16);
    if (!name) return;
    const taken = [...this.players.values()].some(
      (o) => o !== p && o.name.toLowerCase() === name.toLowerCase()
    );
    if (taken) return;
    p.name = name;
    const socket = this.io.sockets.sockets.get(p.socketId);
    if (socket) socket.emit('renamed', { name });
    this.pushEvent({ type: 'rename', name, color: p.color });
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.pushEvent({ type: 'leave', name: p.name, color: p.color });
  }

  assignSpawn(p) {
    const others = [...this.players.values()].filter((o) => o !== p && o.alive);
    let best = map.SPAWNS[0];
    let bestScore = -Infinity;
    for (const s of map.SPAWNS) {
      let minD = Infinity;
      for (const o of others) {
        const d = Math.hypot(o.x - s.x, o.y - s.y);
        if (d < minD) minD = d;
      }
      const score = minD === Infinity ? 10000 : minD + Math.random() * 40;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    p.x = best.x;
    p.y = best.y;
    // не спавнить внутри стены
    let guard = 0;
    while (circleHits(p.x, p.y, CFG.RADIUS) && guard++ < 60) {
      const s = map.SPAWNS[Math.floor(Math.random() * map.SPAWNS.length)];
      p.x = s.x;
      p.y = s.y;
    }
  }

  giveSofts(p, announce) {
    p.softs = rollSofts();
    if (announce) this.sendSofts(p, false);
  }

  sendSofts(p, silent) {
    const payload = {
      softs: p.softs.map((id) => this.publicSoft(id)),
      round: this.round,
    };
    const socket = this.io.sockets.sockets.get(p.socketId);
    if (socket) socket.emit('softs', payload);
    if (!silent) {
      this.pushEvent({
        type: 'soft',
        name: p.name,
        color: p.color,
        softs: p.softs.map((id) => ({ name: SOFTS[id].name, rarity: SOFTS[id].rarity })),
      });
    }
  }

  publicSoft(id) {
    const s = SOFTS[id];
    return { id: s.id, name: s.name, file: s.file, rarity: s.rarity, desc: s.desc, icon: s.icon };
  }

  has(p, id) {
    return p.softs.includes(id);
  }

  // ---------- ввод ----------
  setInput(id, input) {
    const p = this.players.get(id);
    if (!p) return;
    p.input.up = !!input.up;
    p.input.down = !!input.down;
    p.input.left = !!input.left;
    p.input.right = !!input.right;
    p.input.shoot = !!input.shoot;
    if (typeof input.angle === 'number' && isFinite(input.angle)) {
      p.angle = input.angle;
    }
    if (input.reload) this.startReload(p);
  }

  startReload(p) {
    if (!this.has(p, 'infammo') && p.alive && p.reloading <= 0 && p.mag < CFG.MAG) {
      p.reloading = CFG.RELOAD;
    }
  }

  stat(p) {
    const speedMul =
      1 + (this.has(p, 'speedhack') ? 0.55 : 0) + (this.has(p, 'bhop') ? 0.4 : 0);
    const fireDelay = CFG.FIRE_DELAY / (this.has(p, 'rapidfire') ? 3 : 1);
    const damage = CFG.DAMAGE * (this.has(p, 'onehit') ? 2 : 1);
    let spread = CFG.BASE_SPREAD;
    if (this.has(p, 'norecoil')) spread = 0;
    else if (this.has(p, 'rapidfire')) spread *= 1.9;
    if (this.has(p, 'spinbot')) spread += 0.12;
    return {
      speedMul,
      fireDelay,
      damage,
      spread,
      mag: this.has(p, 'infammo') ? Infinity : CFG.MAG,
      aimbot: this.has(p, 'aimbot'),
      trigger: this.has(p, 'triggerbot'),
      wallhack: this.has(p, 'wallhack'),
      radar: this.has(p, 'radar'),
      spin: this.has(p, 'spinbot'),
    };
  }

  // ---------- цикл ----------
  loop() {
    const now = Date.now();
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    dt = clamp(dt, 0, 0.1);

    this.timer -= dt;
    if (this.state === 'intermission' && this.timer <= 0) this.startRound();
    else if (this.state === 'live' && this.timer <= 0) this.endRound();

    this.update(dt);

    this.tickCount++;
    if (this.tickCount % CFG.SNAP_EVERY === 0) this.broadcastSnapshot();
  }

  startRound() {
    if (this.players.size === 0) {
      this.timer = 2;
      return;
    }
    this.state = 'live';
    this.round++;
    this.timer = CFG.ROUND_TIME;
    this.bullets.length = 0;
    for (const p of this.players.values()) {
      p.hp = CFG.MAX_HP;
      p.alive = true;
      p.respawnAt = 0;
      p.mag = CFG.MAG;
      p.reloading = 0;
      p.cooldown = 0;
      p.roundKills = 0;
      this.assignSpawn(p);
      this.giveSofts(p, false);
    }
    this.io.emit('roundStart', { round: this.round, time: CFG.ROUND_TIME });
    this.pushEvent({ type: 'round', round: this.round });
  }

  endRound() {
    const rows = [...this.players.values()]
      .map((p) => ({
        name: p.name,
        color: p.color,
        kills: p.roundKills,
        deaths: p.deaths,
        softs: p.softs.map((id) => ({ name: SOFTS[id].name, rarity: SOFTS[id].rarity })),
      }))
      .sort((a, b) => b.kills - a.kills);
    this.io.emit('roundEnd', { round: this.round, table: rows });
    this.state = 'intermission';
    this.timer = CFG.INTERMISSION;
    this.bullets.length = 0;
  }

  update(dt) {
    const live = this.state === 'live';

    // Игроки
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (live && p.respawnAt > 0) {
          p.respawnAt -= dt;
          if (p.respawnAt <= 0) {
            p.alive = true;
            p.hp = CFG.MAX_HP;
            p.mag = CFG.MAG;
            p.reloading = 0;
            p.cooldown = 0;
            this.assignSpawn(p);
            this.pushEvent({ type: 'respawn', id: p.id });
          }
        }
        continue;
      }

      if (p.reloading > 0) {
        p.reloading -= dt;
        if (p.reloading <= 0) {
          p.reloading = 0;
          p.mag = CFG.MAG;
        }
      }
      if (p.cooldown > 0) p.cooldown -= dt;

      // движение
      let ix = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
      let iy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
      const len = Math.hypot(ix, iy);
      if (len > 0) {
        ix /= len;
        iy /= len;
      }
      const st = this.stat(p);
      const targetVx = ix * CFG.BASE_SPEED * st.speedMul;
      const targetVy = iy * CFG.BASE_SPEED * st.speedMul;
      const accel = this.has(p, 'bhop') ? CFG.BHOP_ACCEL : CFG.ACCEL;
      const k = 1 - Math.exp(-accel * dt / Math.max(1, st.speedMul));
      p.vx += (targetVx - p.vx) * k;
      p.vy += (targetVy - p.vy) * k;
      if (circleHits(p.x + p.vx * dt, p.y, CFG.RADIUS)) p.vx = 0;
      else p.x += p.vx * dt;
      if (circleHits(p.x, p.y + p.vy * dt, CFG.RADIUS)) p.vy = 0;
      else p.y += p.vy * dt;
      p.x = clamp(p.x, CFG.RADIUS, map.WORLD_WIDTH - CFG.RADIUS);
      p.y = clamp(p.y, CFG.RADIUS, map.WORLD_HEIGHT - CFG.RADIUS);

      // спиновый мем-софт
      if (st.spin) p.spin += dt * 14;
      else p.spin = 0;

      if (!live) continue;

      // аимбот
      if (st.aimbot) {
        const target = this.bestTarget(p, CFG.AIMBOT_FOV, CFG.AIMBOT_RANGE);
        if (target) p.angle = Math.atan2(target.y - p.y, target.x - p.x);
      }

      // триггербот
      if (st.trigger) {
        const target = this.bestTarget(p, CFG.TRIGGER_CONE, CFG.AIMBOT_RANGE);
        if (target) this.tryShoot(p, st);
      }

      if (p.input.shoot) this.tryShoot(p, st);
    }

    // Пули
    const sub = 2;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      let dead = false;
      for (let s = 0; s < sub && !dead; s++) {
        b.x += b.vx * (dt / sub);
        b.y += b.vy * (dt / sub);
        b.life -= dt / sub;
        if (b.life <= 0 || map.isSolidAt(b.x, b.y)) {
          dead = true;
          break;
        }
        for (const p of this.players.values()) {
          if (!p.alive || p.id === b.owner) continue;
          if ((p.x - b.x) ** 2 + (p.y - b.y) ** 2 <= (CFG.RADIUS + 3) ** 2) {
            this.hit(p, b);
            dead = true;
            break;
          }
        }
      }
      if (dead) this.bullets.splice(i, 1);
    }
  }

  bestTarget(p, fov, range) {
    let best = null;
    let bestDiff = Infinity;
    for (const o of this.players.values()) {
      if (o === p || !o.alive) continue;
      const dx = o.x - p.x;
      const dy = o.y - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist > range) continue;
      const ang = Math.atan2(dy, dx);
      const diff = Math.abs(angleDiff(p.angle, ang));
      if (diff > fov) continue;
      if (!visible(p.x, p.y, o.x, o.y)) continue;
      if (diff < bestDiff) {
        bestDiff = diff;
        best = o;
      }
    }
    return best;
  }

  tryShoot(p, st) {
    if (p.cooldown > 0 || p.reloading > 0) return;
    if (!this.has(p, 'infammo') && p.mag <= 0) {
      this.startReload(p);
      return;
    }
    p.cooldown = st.fireDelay;
    if (!this.has(p, 'infammo')) p.mag--;
    const spread = st.spread;
    const ang = p.angle + (Math.random() - 0.5) * 2 * spread;
    const speed = CFG.BULLET_SPEED;
    const sx = p.x + Math.cos(ang) * (CFG.RADIUS + 4);
    const sy = p.y + Math.sin(ang) * (CFG.RADIUS + 4);
    this.bullets.push({
      x: sx,
      y: sy,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      life: CFG.BULLET_LIFE,
      owner: p.id,
      damage: st.damage,
      color: p.color,
    });
    this.pushEvent({ type: 'shot', id: p.id, x: sx, y: sy, a: ang, c: p.color });
  }

  hit(victim, bullet) {
    victim.hp -= bullet.damage;
    this.pushEvent({
      type: 'hit',
      x: bullet.x,
      y: bullet.y,
      victim: victim.id,
      dmg: bullet.damage,
      lethal: victim.hp <= 0,
    });
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      victim.deaths++;
      victim.respawnAt = CFG.RESPAWN;
      const killer = this.players.get(bullet.owner);
      if (killer) {
        killer.kills++;
        killer.roundKills++;
        this.pushEvent({
          type: 'kill',
          killer: killer.name,
          killerColor: killer.color,
          victim: victim.name,
          victimColor: victim.color,
          softs: killer.softs.map((id) => SOFTS[id].name),
        });
      }
    }
  }

  // ---------- события/снапшоты ----------
  pushEvent(ev) {
    this.events.push(ev);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  }

  broadcastSnapshot() {
    const players = [];
    for (const p of this.players.values()) {
      const st = this.stat(p);
      players.push({
        id: p.id,
        n: p.name,
        c: p.color,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        a: Math.round(p.angle * 1000) / 1000,
        s: Math.round(p.spin * 100) / 100,
        hp: Math.max(0, Math.round(p.hp)),
        al: p.alive ? 1 : 0,
        k: p.kills,
        d: p.deaths,
        wh: st.wallhack ? 1 : 0,
        mg: p.mag === Infinity ? -1 : p.mag,
        rs: p.alive ? 0 : Math.max(0, Math.round(p.respawnAt * 10) / 10),
        rl: Math.round(Math.max(0, p.reloading) * 100) / 100,
      });
    }
    const bullets = this.bullets.map((b) => ({
      x: Math.round(b.x),
      y: Math.round(b.y),
      a: Math.round(Math.atan2(b.vy, b.vx) * 100) / 100,
      c: b.color,
    }));

    this.io.emit('snap', {
      r: this.round,
      st: this.state,
      t: Math.max(0, Math.round(this.timer * 10) / 10),
      p: players,
      b: bullets,
      ev: this.events,
    });
    this.events = [];
  }
}

module.exports = { Game, CFG };
