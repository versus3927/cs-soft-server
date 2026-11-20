'use strict';

// Прогон клиента в jsdom: ловим ошибки рендера/обработчиков.
const fs = require('fs');
const path = require('path');
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('SKIP: jsdom не установлен (npm i -D jsdom)');
  process.exit(0);
}

const ROOT = '/home/user/cs-soft-server';
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const clientJs = fs.readFileSync(path.join(ROOT, 'public/client.js'), 'utf8');

const errors = [];

function makeCtx() {
  const noop = () => {};
  const ctx = new Proxy(
    {
      canvas: { width: 200, height: 200 },
      measureText: () => ({ width: 10 }),
      createLinearGradient: () => ({ addColorStop: noop }),
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return noop;
      },
      set(target, prop, val) {
        target[prop] = val;
        return true;
      },
    }
  );
  return ctx;
}

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost:3000/',
});
const { window } = dom;

window.HTMLCanvasElement.prototype.getContext = () => makeCtx();
window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
window.devicePixelRatio = 2;
Object.defineProperty(window.navigator, 'clipboard', {
  value: { writeText: () => Promise.resolve() },
  configurable: true,
});

// фейковый io
const handlers = {};
function fakeSocket() {
  return {
    on(ev, fn) {
      handlers[ev] = handlers[ev] || [];
      handlers[ev].push(fn);
    },
    emit() {},
    io: { on() {} },
    close() {},
    trigger(ev, data) {
      for (const fn of handlers[ev] || []) fn(data);
    },
  };
}
const sock = fakeSocket();
window.io = () => sock;

window.fetch = (url) => {
  if (String(url).includes('/api/softs')) {
    return Promise.resolve({
      json: () =>
        Promise.resolve({
          softs: [
            { id: 'aimbot', name: 'AIMBOT', file: 'aimbot.dll', rarity: 'epic', color: '#f472b6', rarityLabel: 'EPIC', desc: 'd', icon: '◎', weight: 8 },
            { id: 'wallhack', name: 'WALLHACK', file: 'wallhack.dll', rarity: 'epic', color: '#f472b6', rarityLabel: 'EPIC', desc: 'd', icon: '◈', weight: 10 },
          ],
          totalWeight: 18,
        }),
    });
  }
  if (String(url).includes('/api/server')) {
    return Promise.resolve({
      json: () =>
        Promise.resolve({
          name: 'CS SOFT SERVER',
          address: 'localhost:3000',
          connectAddress: '192.168.0.10:3000',
          players: 3,
          maxPlayers: 16,
          round: 2,
          state: 'live',
          softs: 11,
        }),
    });
  }
  return Promise.resolve({ json: () => Promise.resolve({}) });
};

window.addEventListener('error', (e) => errors.push('window.onerror: ' + (e.error ? e.error.stack : e.message)));

try {
  window.eval(clientJs);
} catch (e) {
  errors.push('eval: ' + e.stack);
}

const $ = (id) => window.document.getElementById(id);
$('nick').value = 'TestBot';
$('playBtn').click();

// приветствие от сервера
const rows = fs.readFileSync(path.join(ROOT, 'server/map.js'), 'utf8');
const mapMod = require(path.join(ROOT, 'server/map.js'));

sock.trigger('welcome', {
  id: 1,
  name: 'TestBot',
  color: 'hsl(100 80% 60%)',
  config: { MAX_HP: 100 },
  map: { tile: mapMod.TILE, rows: mapMod.rows, width: mapMod.WORLD_WIDTH, height: mapMod.WORLD_HEIGHT },
});

sock.trigger('softs', {
  round: 2,
  softs: [
    { id: 'aimbot', name: 'AIMBOT', file: 'aimbot.dll', rarity: 'epic', desc: 'авто', icon: '◎' },
    { id: 'wallhack', name: 'WALLHACK', file: 'wallhack.dll', rarity: 'epic', desc: 'стены', icon: '◈' },
  ],
});

for (let i = 0; i < 5; i++) {
  sock.trigger('snap', {
    r: 2,
    st: 'live',
    t: 55 - i,
    p: [
      { id: 1, n: 'TestBot', c: 'hsl(100 80% 60%)', x: 720, y: 496, a: 0.5, s: 0, hp: 100, al: 1, k: 2, d: 1, wh: 1, mg: 25, rl: 0, rs: 0 },
      { id: 2, n: 'Enemy', c: 'hsl(0 80% 60%)', x: 860, y: 496, a: 3.1, s: 0, hp: 60, al: 1, k: 1, d: 2, wh: 0, mg: 10, rl: 0.5, rs: 0 },
      { id: 3, n: 'Ghost', c: 'hsl(200 80% 60%)', x: 200, y: 200, a: 1, s: 0.3, hp: 0, al: 0, k: 0, d: 3, wh: 0, mg: 25, rl: 0, rs: 1.4 },
    ],
    b: [{ x: 750, y: 496, a: 0, c: 'red' }],
    ev: [
      { type: 'kill', killer: 'TestBot', killerColor: '#0f0', victim: 'Enemy', victimColor: '#f00', softs: ['AIMBOT'] },
      { type: 'hit', x: 750, y: 496, victim: 2, dmg: 26, lethal: true },
      { type: 'shot', id: 1, x: 740, y: 496, a: 0.1, c: '#fff' },
    ],
  });
}

// тач-события и клавиатура
const ev = (type, props) => {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, props);
  return e;
};
window.dispatchEvent(ev('keydown', { key: 'w' }));
window.dispatchEvent(ev('keyup', { key: 'w' }));
window.dispatchEvent(ev('keydown', { key: 'r' }));
window.dispatchEvent(ev('keydown', { key: 'Escape' }));
$('game').dispatchEvent(ev('mousemove', { clientX: 400, clientY: 300 }));
$('game').dispatchEvent(ev('mousedown', { button: 0 }));
window.dispatchEvent(ev('mouseup', { button: 0 }));
window.dispatchEvent(ev('resize'));
// Esc открывает паузу, повторный клик «В ИГРУ» её закрывает
$('playBtn').click();

sock.trigger('roundStart', { round: 3, time: 60 });
sock.trigger('roundEnd', { round: 3, table: [{ name: 'TestBot', color: '#0f0', kills: 3 }] });
sock.trigger('chat', { name: 'Enemy', color: '#f00', text: 'gg <script>' });
sock.trigger('renamed', { name: 'TestBot2' });
sock.trigger('disconnect');

setTimeout(() => {
  // проверки DOM
  const checks = [];
  checks.push(['soft cards', $('softList').children.length === 2]);
  checks.push(['killfeed', window.document.querySelectorAll('.kf').length >= 1]);
  checks.push(['chat rendered', window.document.querySelectorAll('.chat div').length >= 1]);
  checks.push(['hp bar', $('hpFill').style.width === '100%']);
  checks.push(['ammo', $('ammo').textContent === '25']);
  checks.push(['kd', $('kd').textContent === '2 / 1']);
  checks.push(['radar canvas', $('radar').width === 200]);
  checks.push(['hud visible', !$('hud').classList.contains('hidden')]);
  checks.push(['menu hidden', $('menu').classList.contains('hidden')]);
  checks.push(['center msg', $('centerMsg').innerHTML.length > 0]);
  checks.push(['адрес сервера показан', $('svAddr').value.length > 5]);
  checks.push(['онлайн показан', $('svPlayers').textContent === '3 / 16']);

  let ok = true;
  for (const [name, pass] of checks) {
    if (!pass) {
      ok = false;
      console.log('FAIL check:', name);
    }
  }
  if (errors.length) {
    ok = false;
    console.log('JS errors:\n' + errors.join('\n'));
  }
  console.log(ok ? 'OK: клиент отработал без ошибок, DOM корректен' : 'FAIL');
  process.exit(ok ? 0 : 1);
}, 300);
