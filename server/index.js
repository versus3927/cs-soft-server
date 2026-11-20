'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const { Game, CFG } = require('./game');
const { publicCatalog, LIST, TOTAL_WEIGHT, getDoubleSoftChance } = require('./softs');
const { CONFIG } = require('./config');

const PORT = CONFIG.PORT;
const HOST = CONFIG.HOST;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  if (urlPath === '/api/softs') {
    const body = JSON.stringify({ softs: publicCatalog(), totalWeight: TOTAL_WEIGHT });
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }

  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1>');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const io = new Server(server, {
  cors: { origin: CONFIG.ALLOWED_ORIGIN, methods: ['GET', 'POST'] },
  pingInterval: 5000,
  pingTimeout: 10000,
});

const game = new Game(io);

io.on('connection', (socket) => {
  const p = game.addPlayer(socket);
  if (!p) return;

  socket.on('input', (input) => game.setInput(p.id, input || {}));
  socket.on('name', (name) => game.renamePlayer(p.id, name));
  socket.on('chat', (text) => {
    if (typeof text !== 'string') return;
    const clean = text.trim().slice(0, 140);
    if (!clean) return;
    io.emit('chat', { name: p.name, color: p.color, text: clean });
  });
  socket.on('disconnect', () => game.removePlayer(p.id));
});

server.listen(PORT, HOST, () => {
  console.log(`[cs-soft] сервер слушает ${HOST}:${PORT}`);
  console.log(`[cs-soft] софтов в пуле: ${LIST.length}, суммарный вес: ${TOTAL_WEIGHT}`);
  console.log(`[cs-soft] раунд: ${CFG.ROUND_TIME}s игры + ${CFG.INTERMISSION}s перерыв`);
  console.log(
    `[cs-soft] двойной дроп: ${Math.round(getDoubleSoftChance() * 100)}%, ` +
      `макс. игроков: ${CFG.MAX_PLAYERS}`
  );
});

process.on('SIGTERM', () => {
  io.close();
  server.close(() => process.exit(0));
});
