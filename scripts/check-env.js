'use strict';

// Показывает, откуда сервер возьмёт каждую настройку прямо сейчас:
// переменная окружения → .env → дефолт. Запуск: npm run env

const { CONFIG, FALLBACK, loadDotEnv } = require('../server/config');

const loadedFromDotEnv = new Set(CONFIG.dotenvLoaded);
const KEYS = Object.keys(FALLBACK);

const rows = KEYS.map((key) => {
  const inEnv = process.env[key] !== undefined && process.env[key] !== '';
  let source;
  if (loadedFromDotEnv.has(key)) source = '.env';
  else if (inEnv) source = 'окружение';
  else source = 'дефолт';
  return {
    key,
    value: CONFIG[key] === '' ? '(пусто)' : String(CONFIG[key]),
    source,
    fallback: String(FALLBACK[key]) === '' ? '(пусто)' : String(FALLBACK[key]),
  };
});

const w1 = Math.max(...rows.map((r) => r.key.length), 4);
const w2 = Math.max(...rows.map((r) => r.value.length), 5);
const w3 = 10;

console.log('\nCS SOFT — настройки сервера\n');
console.log(
  'ПЕРЕМЕННАЯ'.padEnd(w1) + '  ' + 'ЗНАЧЕНИЕ'.padEnd(w2) + '  ' + 'ОТКУДА'.padEnd(w3) + '  ДЕФОЛТ'
);
console.log('-'.repeat(w1 + w2 + w3 + 24));
for (const r of rows) {
  console.log(
    r.key.padEnd(w1) + '  ' + r.value.padEnd(w2) + '  ' + r.source.padEnd(w3) + '  ' + r.fallback
  );
}
console.log('\nИсточники: окружение (PORT=8080 npm start) → .env → встроенный дефолт.');
console.log('Шаблон всех переменных: .env.example\n');
