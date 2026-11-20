'use strict';

/* global io */
(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- DOM ----------
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const radar = $('radar');
  const rctx = radar.getContext('2d');
  const menu = $('menu');
  const hud = $('hud');
  const nickInput = $('nick');
  const nickError = $('nickError');
  const playBtn = $('playBtn');
  const softList = $('softList');
  const killfeed = $('killfeed');
  const centerMsg = $('centerMsg');

  const isTouch = matchMedia('(hover: none) and (pointer: coarse)').matches;

  // ---------- карточка сервера ----------
  const svAddr = $('svAddr');
  const svPlayers = $('svPlayers');
  const copyBtn = $('copyAddr');
  const origin = location.origin;

  function setAddr(text) {
    svAddr.value = text;
    svAddr.title = text;
  }
  setAddr(origin);

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(svAddr.value);
      } catch {
        svAddr.select();
        document.execCommand('copy');
      }
      copyBtn.textContent = 'СКОПИРОВАНО';
      copyBtn.classList.add('done');
      setTimeout(() => {
        copyBtn.textContent = 'КОПИРОВАТЬ';
        copyBtn.classList.remove('done');
      }, 1600);
    });
  }

  function refreshServerInfo() {
    fetch('/api/server')
      .then((r) => r.json())
      .then((d) => {
        svPlayers.textContent = `${d.players} / ${d.maxPlayers}`;
        svPlayers.style.color = d.players >= d.maxPlayers ? '#ff4d6d' : '#7cf9b4';
        // если открыто по localhost — показываем адрес для друзей в той же сети
        const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])/.test(location.hostname);
        if (isLocal && d.connectAddress) {
          setAddr(`http://${d.connectAddress}`);
          svAddr.parentElement.title = 'локальная сеть';
        }
      })
      .catch(() => {});
  }
  refreshServerInfo();
  setInterval(refreshServerInfo, 5000);

  // ---------- состояние ----------
  const S = {
    me: null,
    map: null,
    cfg: null,
    snap: null,
    softs: [],
    catalog: [],
    joined: false,
    mouse: { x: 0, y: 0, down: false },
    keys: {},
    stick: { active: false, dx: 0, dy: 0, id: null },
    touchFire: false,
    camera: { x: 0, y: 0 },
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    lastSnapAt: 0,
    names: new Map(),
    hitmarks: [],
    flashes: [],
    touchAim: null,
  };

  let socket = null;

  // ---------- утилиты ----------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const isSolidLocal = (x, y) => {
    if (!S.map) return false;
    const tx = Math.floor(x / S.map.tile);
    const ty = Math.floor(y / S.map.tile);
    if (ty < 0 || ty >= S.map.rows.length) return true;
    const row = S.map.rows[ty];
    if (tx < 0 || tx >= row.length) return true;
    const ch = row[tx];
    return ch === '#' || ch === 'B';
  };

  function resize() {
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * S.dpr);
    canvas.height = Math.floor(h * S.dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- миникарта (пререндер) ----------
  let miniCache = null;
  function buildMini() {
    if (!S.map) return;
    const c = document.createElement('canvas');
    c.width = S.map.width;
    c.height = S.map.height;
    const g = c.getContext('2d');
    g.fillStyle = '#0b0f16';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#243247';
    const t = S.map.tile;
    for (let y = 0; y < S.map.rows.length; y++) {
      for (let x = 0; x < S.map.rows[y].length; x++) {
        const ch = S.map.rows[y][x];
        if (ch === '#') g.fillRect(x * t, y * t, t, t);
        else if (ch === 'B') {
          g.fillStyle = '#3b4a5f';
          g.fillRect(x * t + 4, y * t + 4, t - 8, t - 8);
          g.fillStyle = '#243247';
        }
      }
    }
    miniCache = c;
  }

  // ---------- меню / пул софтов ----------
  fetch('/api/softs')
    .then((r) => r.json())
    .then((data) => {
      S.catalog = data.softs;
      $('softTotal').textContent = String(data.softs.length);
      const book = $('softBook');
      book.innerHTML = '';
      for (const s of [...data.softs].sort((a, b) => b.weight - a.weight)) {
        const pct = Math.round((s.weight / data.totalWeight) * 100);
        const el = document.createElement('div');
        el.className = 'sb-item';
        el.style.setProperty('--rar', s.color);
        el.innerHTML = `<div class="sb-name">${s.icon} ${s.name}<span class="sb-chance">${pct}%</span></div>
          <div class="sb-desc">${s.desc}</div>`;
        book.appendChild(el);
      }
    })
    .catch(() => {});

  const savedNick = localStorage.getItem('cssoft.nick');
  if (savedNick) nickInput.value = savedNick;

  // ---------- сеть ----------
  function connect() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('welcome', (data) => {
      S.me = data.id;
      S.name = data.name;
      S.map = data.map;
      S.cfg = data.config;
      buildMini();
      menu.classList.add('hidden');
      hud.classList.remove('hidden');
      S.joined = true;
      if (nickInput.value.trim()) socket.emit('name', nickInput.value.trim());
      startStatsPolling();
      if (isTouch) buildTouchControls();
    });

    socket.on('renamed', (d) => {
      S.name = d.name;
      localStorage.setItem('cssoft.nick', d.name);
    });

    socket.on('softs', (d) => {
      S.softs = d.softs;
      renderSofts(d.softs, d.round);
    });

    socket.on('renamed', (d) => {
      refreshMyStats();
    });

    socket.on('snap', (snap) => {
      S.snap = snap;
      for (const ev of snap.ev || []) {
        if (ev.type === 'kill') {
          addKillFeed(ev.killer, ev.victim, ev.softs, ev.killerColor, ev.victimColor);
        } else if (ev.type === 'hit') {
          S.hitmarks.push({ x: ev.x, y: ev.y, t: 0.35, lethal: ev.lethal });
          if (ev.lethal) S.hitmarks.push({ x: ev.x, y: ev.y, t: 0.6, lethal: true, big: true });
        } else if (ev.type === 'shot') {
          S.flashes.push({ x: ev.x, y: ev.y, a: ev.a, c: ev.c, t: 0.08 });
        }
      }
      S.lastSnapAt = performance.now();
      S.names.clear();
      for (const p of snap.p) S.names.set(p.id, p);
      updateHud(snap);
    });

    socket.on('chat', onChat);

    socket.on('roundStart', (d) => {
      S.roundTable = null;
      setTimeout(() => {
        if (S.roundTable) return;
        showCenter(`РАУНД ${d.round}`, 'софты выданы — иди убивай');
      }, 500);
    });

    socket.on('roundEnd', (d) => {
      S.roundTable = d;
      renderRoundTable(d);
    });

    socket.on('serverFull', () => {
      showCenter('СЕРВЕР ЗАПОЛНЕН', 'попробуй позже');
    });

    socket.on('disconnect', () => {
      showCenter('СВЯЗЬ ПОТЕРЯНА', 'переподключение...');
    });

    socket.io.on('reconnect', () => {
      centerMsg.classList.remove('show');
    });
  }

  // ---------- HUD ----------
  const RARITY_LABEL = {
    common: 'COMMON',
    rare: 'RARE',
    epic: 'EPIC',
    legendary: 'LEGENDARY',
  };
  const RARITY_COLOR = {
    common: '#7dd3fc',
    rare: '#a78bfa',
    epic: '#f472b6',
    legendary: '#fbbf24',
  };

  function renderSofts(list, round) {
    softList.innerHTML = '';
    for (const s of list) {
      const el = document.createElement('div');
      el.className = 'soft-card' + (s.rarity === 'legendary' ? ' legendary' : '');
      el.style.setProperty('--rar', RARITY_COLOR[s.rarity] || '#7dd3fc');
      el.innerHTML = `<div class="sc-head">
          <span class="sc-icon">${s.icon}</span>
          <span class="sc-name">${s.name}</span>
          <span class="sc-rar">${RARITY_LABEL[s.rarity] || ''}</span>
        </div>
        <div class="sc-file">loaded: ${s.file}</div>
        <div class="sc-desc">${s.desc}</div>`;
      softList.appendChild(el);
    }
    const ss = $('specSofts');
    if (ss) ss.textContent = list.map((s) => s.name).join(' + ');
    $('statusLine').textContent = list.length > 1
      ? 'двойной дроп: два софта одновременно'
      : '';
  }

  // ---------- статистика из базы ----------
  let statsTimer = null;
  function refreshMyStats() {
    const name = (S.name || (nickInput.value || '').trim() || '').trim();
    if (!name) return;
    fetch(`/api/stats/me?name=${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((d) => {
        const place = $('ssPlace');
        if (!place) return;
        place.textContent = d.place ? `#${d.place}` : '—';
        $('ssRounds').textContent = String(d.roundsPlayed || 0);
        $('ssTopSoft').textContent = d.topSofts && d.topSofts.length ? d.topSofts[0].soft_id : '—';
        $('ssSrc').textContent = d.source === 'db' ? 'БД' : 'ПАМЯТЬ';
        $('ssSrc').title =
          d.source === 'db' ? 'статистика из PostgreSQL' : 'DATABASE_URL не задан, считаем в памяти';
      })
      .catch(() => {});
  }

  function startStatsPolling() {
    clearInterval(statsTimer);
    refreshMyStats();
    statsTimer = setInterval(refreshMyStats, 15000);
  }

  function updateHud(snap) {
    $('roundNum').textContent = String(Math.max(1, snap.r));
    $('timer').textContent = Math.ceil(snap.t).toString();
    $('phase').textContent = snap.st === 'live' ? 'РАУНД ИДЁТ' : 'ПЕРЕРЫВ';
    $('phase').parentElement.classList.toggle('hurry', snap.st === 'live' && snap.t <= 10);

    const me = snap.p.find((p) => p.id === S.me);
    if (!me) return;

    $('kd').textContent = `${me.k} / ${me.d}`;

    const hp = me.hp;
    const fill = $('hpFill');
    fill.style.width = `${Math.max(0, hp)}%`;
    fill.classList.toggle('low', hp <= 35);
    $('hpText').textContent = String(hp);

    const ammoEl = $('ammo');
    ammoEl.textContent = me.mg < 0 ? '∞' : String(me.mg);
    $('reload').classList.toggle('hidden', !(me.rl > 0));

    const spec = $('spectate');
    spec.classList.toggle('hidden', me.al === 1);
    const rt = $('respawnT');
    if (rt) rt.textContent = (me.rs || 0).toFixed(1);
  }

  let centerTimer = null;
  function showCenter(title, sub) {
    centerMsg.innerHTML = `${title}${sub ? `<span class="sub">${sub}</span>` : ''}`;
    centerMsg.classList.add('show');
    clearTimeout(centerTimer);
    centerTimer = setTimeout(() => centerMsg.classList.remove('show'), 2600);
  }

  function renderRoundTable(d) {
    const rows = d.table
      .slice(0, 6)
      .map((r) => {
        const tags = (r.softs || [])
          .map((s) => `<span class="rt-soft ${s.rarity}">${escapeHtml(s.name)}</span>`)
          .join('');
        return `<div class="rt-row">
            <span class="rt-name" style="color:${r.color}">${escapeHtml(r.name)}</span>
            <span class="rt-tags">${tags}</span>
            <span class="rt-kills">${r.kills}</span>
          </div>`;
      })
      .join('');
    const el = document.createElement('div');
    el.className = 'round-table';
    el.innerHTML = `<div class="rt-head">ИТОГИ РАУНДА ${d.round}</div>${rows}
      <div class="rt-foot">следующий раунд — новые софты</div>`;
    const app = document.getElementById('app');
    app.appendChild(el);
    setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => el.remove(), 500);
    }, 7000);
  }

  function addKillFeed(killer, victim, softs, killerColor, victimColor) {
    const el = document.createElement('div');
    el.className = 'kf';
    const softTags = (softs || []).map((s) => `<span class="kf-soft">${s}</span>`).join('');
    el.innerHTML = `<span class="kf-k" style="color:${killerColor}">${escapeHtml(killer)}</span>
      ${softTags}
      <span class="kf-w">☠</span>
      <span class="kf-v" style="color:${victimColor}">${escapeHtml(victim)}</span>`;
    killfeed.appendChild(el);
    while (killfeed.children.length > 6) killfeed.firstChild.remove();
    setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => el.remove(), 600);
    }, 6000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  let chatBox = null;
  function onChat(m) {
    if (!chatBox) {
      chatBox = document.createElement('div');
      chatBox.className = 'chat';
      hud.appendChild(chatBox);
    }
    const line = document.createElement('div');
    line.innerHTML = `<b style="color:${m.color}">${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}`;
    chatBox.appendChild(line);
    while (chatBox.children.length > 6) chatBox.firstChild.remove();
    setTimeout(() => line.remove(), 12000);
  }

  // ---------- ввод ----------
  window.addEventListener('keydown', (e) => {
    if (e.target === nickInput) return;
    S.keys[e.key.toLowerCase()] = true;
    if (e.key.toLowerCase() === 'r' && S.joined) socket.emit('input', { reload: true, ...makeInput() });
    if (e.key === 'Escape' && S.joined) {
      menu.classList.toggle('hidden');
      playBtn.textContent = menu.classList.contains('hidden') ? 'В ИГРУ' : 'ПРОДОЛЖИТЬ';
    }
    if (e.key === 'Enter' && !menu.classList.contains('hidden') && document.activeElement === nickInput) {
      playBtn.click();
    }
  });
  window.addEventListener('keyup', (e) => {
    S.keys[e.key.toLowerCase()] = false;
  });

  canvas.addEventListener('mousemove', (e) => {
    S.mouse.x = e.clientX;
    S.mouse.y = e.clientY;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) S.mouse.down = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) S.mouse.down = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function makeInput() {
    const k = S.keys;
    let up = !!(k['w'] || k['ц'] || k['arrowup']);
    let down = !!(k['s'] || k['ы'] || k['arrowdown']);
    let left = !!(k['a'] || k['ф'] || k['arrowleft']);
    let right = !!(k['d'] || k['в'] || k['arrowright']);
    if (S.stick.active) {
      const m = Math.hypot(S.stick.dx, S.stick.dy);
      if (m > 12) {
        if (S.stick.dy < -12) up = true;
        if (S.stick.dy > 12) down = true;
        if (S.stick.dx < -12) left = true;
        if (S.stick.dx > 12) right = true;
      }
    }
    return {
      up,
      down,
      left,
      right,
      shoot: S.mouse.down || S.touchFire,
      angle: aimAngle(),
    };
  }

  function aimAngle() {
    if (!S.me) return 0;
    const me = S.names.get(S.me);
    const cam = S.camera;
    if (isTouch) {
      // на телефоне прицел ведётся движением правой части экрана
      const p = S.touchAim;
      if (p && me) {
        const wx = cam.x + (p.x - canvas.clientWidth / 2);
        const wy = cam.y + (p.y - canvas.clientHeight / 2);
        return Math.atan2(wy - me.y, wx - me.x);
      }
      if (me) return me.a;
      return 0;
    }
    if (!me) return 0;
    const wx = cam.x + (S.mouse.x - window.innerWidth / 2);
    const wy = cam.y + (S.mouse.y - window.innerHeight / 2);
    return Math.atan2(wy - me.y, wx - me.x);
  }

  // ---------- тач-управление ----------
  function buildTouchControls() {
    if (document.querySelector('.touch')) return;
    const wrap = document.createElement('div');
    wrap.className = 'touch';
    wrap.innerHTML = `
      <div class="stick-zone"></div>
      <div class="stick-base"></div>
      <div class="stick-knob"></div>
      <button class="fire">ОГОНЬ</button>
      <button class="reload-btn">R</button>`;
    document.getElementById('app').appendChild(wrap);

    const zone = wrap.querySelector('.stick-zone');
    const base = wrap.querySelector('.stick-base');
    const knob = wrap.querySelector('.stick-knob');
    let origin = { x: 0, y: 0 };
    let stickId = null;

    zone.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      stickId = t.identifier;
      origin = { x: t.clientX, y: t.clientY };
      base.style.left = knob.style.left = t.clientX + 'px';
      base.style.top = knob.style.top = t.clientY + 'px';
      wrap.classList.add('active');
      S.stick.active = true;
      e.preventDefault();
    }, { passive: false });

    zone.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== stickId) continue;
        let dx = t.clientX - origin.x;
        let dy = t.clientY - origin.y;
        const m = Math.hypot(dx, dy);
        const max = 50;
        if (m > max) {
          dx = (dx / m) * max;
          dy = (dy / m) * max;
        }
        S.stick.dx = dx;
        S.stick.dy = dy;
        knob.style.left = origin.x + dx + 'px';
        knob.style.top = origin.y + dy + 'px';
      }
      e.preventDefault();
    }, { passive: false });

    const endStick = () => {
      stickId = null;
      S.stick.active = false;
      S.stick.dx = S.stick.dy = 0;
      wrap.classList.remove('active');
    };
    zone.addEventListener('touchend', endStick);
    zone.addEventListener('touchcancel', endStick);

    const fireBtn = wrap.querySelector('.fire');
    fireBtn.addEventListener('touchstart', (e) => {
      S.touchFire = true;
      e.preventDefault();
    }, { passive: false });
    fireBtn.addEventListener('touchend', () => {
      S.touchFire = false;
    });
    wrap.querySelector('.reload-btn').addEventListener('click', () => {
      socket.emit('input', { reload: true, ...makeInput() });
    });

    // прицеливание: свайп по правой части экрана
    let aimId = null;
    canvas.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      aimId = t.identifier;
      S.touchAim = { x: t.clientX, y: t.clientY };
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === aimId) S.touchAim = { x: t.clientX, y: t.clientY };
      }
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', () => {
      aimId = null;
    });
  }

  // ---------- рендер ----------
  const VIEW_SCALE = 1; // 1 = 1 пиксель карты на CSS-пиксель

  let lastRenderAt = 0;
  let dtGlobal = 0.016;
  function render(now) {
    requestAnimationFrame(render);
    dtGlobal = Math.min(0.05, (now - lastRenderAt) / 1000 || 0.016);
    lastRenderAt = now;
    if (!S.map || !S.snap) return;

    const W = window.innerWidth;
    const H = window.innerHeight;
    const me = S.names.get(S.me);

    // камера
    if (me) {
      S.camera.x = lerp(S.camera.x, me.x, 0.25);
      S.camera.y = lerp(S.camera.y, me.y, 0.25);
    } else {
      S.camera.x = S.map.width / 2;
      S.camera.y = S.map.height / 2;
    }
    const mapW = S.map.width;
    const mapH = S.map.height;
    S.camera.x = mapW <= W ? mapW / 2 : clamp(S.camera.x, W / 2, mapW - W / 2);
    S.camera.y = mapH <= H ? mapH / 2 : clamp(S.camera.y, H / 2, mapH - H / 2);

    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, W, H);

    const ox = Math.round(W / 2 - S.camera.x);
    const oy = Math.round(H / 2 - S.camera.y);

    ctx.save();
    ctx.translate(ox, oy);

    drawFloor();
    drawBullets();
    drawEffects(dtGlobal);
    drawPlayers(me);
    ctx.restore();

    drawCrosshair(me);
    drawReticle(me);
    drawRadar();
  }

  function drawFloor() {
    const t = S.map.tile;
    // пол
    ctx.fillStyle = '#0d1219';
    ctx.fillRect(0, 0, S.map.width, S.map.height);

    ctx.strokeStyle = 'rgba(66,215,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= S.map.width; x += t) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, S.map.height);
    }
    for (let y = 0; y <= S.map.height; y += t) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(S.map.width, y + 0.5);
    }
    ctx.stroke();

    // стены
    for (let y = 0; y < S.map.rows.length; y++) {
      const row = S.map.rows[y];
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === '#') {
          ctx.fillStyle = '#1b2534';
          ctx.fillRect(x * t, y * t, t, t);
          ctx.fillStyle = '#243146';
          ctx.fillRect(x * t, y * t, t, 4);
        } else if (ch === 'B') {
          ctx.fillStyle = '#2d3a2a';
          ctx.fillRect(x * t + 3, y * t + 3, t - 6, t - 6);
          ctx.strokeStyle = '#4d6247';
          ctx.lineWidth = 2;
          ctx.strokeRect(x * t + 4, y * t + 4, t - 8, t - 8);
          ctx.beginPath();
          ctx.moveTo(x * t + 4, y * t + 4);
          ctx.lineTo(x * t + t - 4, y * t + t - 4);
          ctx.stroke();
        }
      }
    }
  }

  function drawEffects(dt) {
    for (let i = S.hitmarks.length - 1; i >= 0; i--) {
      const h = S.hitmarks[i];
      h.t -= dt;
      if (h.t <= 0) {
        S.hitmarks.splice(i, 1);
        continue;
      }
      const k = 1 - h.t / (h.big ? 0.6 : 0.35);
      ctx.save();
      ctx.translate(h.x, h.y);
      ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = h.lethal ? `rgba(255,77,109,${1 - k})` : `rgba(255,255,255,${1 - k})`;
      ctx.lineWidth = 2;
      const r = (h.big ? 12 : 7) + k * 14;
      for (let a = 0; a < 4; a++) {
        ctx.rotate(Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(r + 5, 0);
        ctx.stroke();
      }
      ctx.restore();
    }
    for (let i = S.flashes.length - 1; i >= 0; i--) {
      const f = S.flashes[i];
      f.t -= dt;
      if (f.t <= 0) {
        S.flashes.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.a);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = f.c || '#ffe9a8';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(14, -5);
      ctx.lineTo(20, 0);
      ctx.lineTo(14, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawBullets() {
    for (const b of S.snap.b) {
      const len = 14;
      ctx.strokeStyle = b.c || '#ffe9a8';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - Math.cos(b.a) * len, b.y - Math.sin(b.a) * len);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawPlayers(me) {
    for (const p of S.snap.p) {
      if (p.id === S.me) {
        drawPlayer(p, true, false);
        continue;
      }
      // видимость
      let vis = true;
      if (me) {
        vis = !segmentBlocked(me.x, me.y, p.x, p.y);
      }
      if (!vis) {
        if (!me || !me.wh) continue; // без вх — не видно
        ctx.globalAlpha = 0.32;
        drawPlayer(p, false, true);
        ctx.globalAlpha = 1;
        continue;
      }
      drawPlayer(p, false, false);
    }
  }

  function drawPlayer(p, isMe, ghost) {
    const r = 12;
    ctx.save();
    ctx.translate(p.x, p.y);

    if (p.al === 0) {
      ctx.globalAlpha *= 0.25;
    }

    // тело
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = p.c + '';
    ctx.globalAlpha *= 0.9;
    ctx.fill();
    ctx.globalAlpha = ghost ? 1 : (p.al === 0 ? 0.25 : 1);

    // обводка
    ctx.lineWidth = 2;
    ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(0,0,0,0.55)';
    ctx.stroke();

    // оружие
    const a = p.a + p.s;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (r - 2), Math.sin(a) * (r - 2));
    ctx.lineTo(Math.cos(a) * (r + 16), Math.sin(a) * (r + 16));
    ctx.strokeStyle = isMe ? '#ffe9a8' : '#c9d6e4';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.stroke();

    // hp-бар над головой
    if (p.al === 1) {
      const w = 30;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(-w / 2, -r - 12, w, 4);
      ctx.fillStyle = p.hp > 50 ? '#27d17f' : p.hp > 25 ? '#ffb43a' : '#ff4d6d';
      ctx.fillRect(-w / 2, -r - 12, (w * p.hp) / 100, 4);
    }

    // ник
    ctx.font = '600 11px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = ghost ? 'rgba(255,90,120,0.85)' : 'rgba(231,238,247,0.9)';
    ctx.fillText(p.n, 0, -r - 18);

    ctx.restore();
  }

  function segmentBlocked(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    const steps = Math.ceil(dist / 12);
    for (let i = 2; i < steps - 1; i++) {
      const t = i / steps;
      if (isSolidLocal(x1 + dx * t, y1 + dy * t)) return true;
    }
    return false;
  }

  function drawCrosshair(me) {
    if (!me || isTouch || !S.joined) return;
    const x = S.mouse.x;
    const y = S.mouse.y;
    ctx.strokeStyle = 'rgba(120,255,190,0.9)';
    ctx.lineWidth = 1.5;
    const g = 7;
    const l = 6;
    ctx.beginPath();
    ctx.moveTo(x - g - l, y);
    ctx.lineTo(x - g, y);
    ctx.moveTo(x + g, y);
    ctx.lineTo(x + g + l, y);
    ctx.moveTo(x, y - g - l);
    ctx.lineTo(x, y - g);
    ctx.moveTo(x, y + g);
    ctx.lineTo(x, y + g + l);
    ctx.stroke();
    ctx.fillStyle = 'rgba(120,255,190,0.9)';
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }

  function drawReticle(me) {
    if (!me) return;
    // прицельная линия от игрока к курсору (для аимбота/спинбота видно, куда смотрит ствол)
    const scale = isTouch ? 1 : 1;
    const a = me.a + me.s;
    ctx.beginPath();
    ctx.moveTo(me.x + Math.cos(a) * 22, me.y + Math.sin(a) * 22);
    ctx.lineTo(me.x + Math.cos(a) * 120 * scale, me.y + Math.sin(a) * 120 * scale);
    ctx.strokeStyle = 'rgba(255,233,168,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawRadar() {
    const size = radar.width;
    rctx.clearRect(0, 0, size, size);
    if (!miniCache) return;
    const pad = 4;
    const s = (size - pad * 2) / Math.max(S.map.width, S.map.height);
    rctx.fillStyle = 'rgba(5,8,12,0.9)';
    rctx.fillRect(0, 0, size, size);
    rctx.drawImage(miniCache, pad, pad, S.map.width * s, S.map.height * s);

    const me = S.names.get(S.me);
    const radarSoft = me && (me.wh || hasRadar());
    for (const p of S.snap.p) {
      if (p.id === S.me) continue;
      if (!p.al) continue;
      if (!radarSoft) continue;
      const x = pad + p.x * s;
      const y = pad + p.y * s;
      rctx.beginPath();
      rctx.arc(x, y, 3, 0, Math.PI * 2);
      rctx.fillStyle = p.c;
      rctx.fill();
    }
    if (me) {
      rctx.beginPath();
      rctx.arc(pad + me.x * s, pad + me.y * s, 3.4, 0, Math.PI * 2);
      rctx.fillStyle = '#ffffff';
      rctx.fill();
    } else {
      for (const p of S.snap.p) {
        rctx.beginPath();
        rctx.arc(pad + p.x * s, pad + p.y * s, 3, 0, Math.PI * 2);
        rctx.fillStyle = p.c;
        rctx.fill();
      }
    }
  }

  function hasRadar() {
    return S.softs.some((s) => s.id === 'radar');
  }

  // ---------- игровой цикл отправки ввода ----------
  let lastInput = 0;
  function sendInput(t) {
    if (!S.joined || !socket) return;
    if (t - lastInput < 33) return;
    lastInput = t;
    socket.emit('input', makeInput());
  }

  function frame(t) {
    sendInput(t);
    if (S.snap) {
      const me = S.names.get(S.me);
      const spec = $('spectate');
      if (me && me.al === 0) {
        const el = $('respawnT');
        if (el) el.textContent = '...';
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------- старт ----------
  playBtn.addEventListener('click', () => {
    const nick = nickInput.value.trim();
    if (nick && !/^[\p{L}\p{N}_\- ]{2,16}$/u.test(nick)) {
      nickError.textContent = '2–16 символов: буквы, цифры, _ - пробел';
      return;
    }
    nickError.textContent = '';
    if (nick) localStorage.setItem('cssoft.nick', nick);
    if (!socket) connect();
    else {
      menu.classList.add('hidden');
      hud.classList.remove('hidden');
      if (nick) socket.emit('name', nick);
    }
  });

  requestAnimationFrame(render);
  requestAnimationFrame(frame);
})();
