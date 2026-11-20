'use strict';

// Пул софтов. Каждый раунд игрок получает случайный софт из этого списка.
// weight — относительный шанс выпадения.
const SOFTS = {
  aimbot: {
    id: 'aimbot',
    name: 'AIMBOT',
    file: 'aimbot.dll',
    rarity: 'epic',
    weight: 8,
    desc: 'Прицел сам прилипает к ближайшему видимому врагу. Снайперская точность.',
    icon: '◎',
  },
  wallhack: {
    id: 'wallhack',
    name: 'WALLHACK',
    file: 'wallhack.dll',
    rarity: 'epic',
    weight: 10,
    desc: 'Видно всех врагов через стены — силуэты светятся сквозь геометрию.',
    icon: '◈',
  },
  rapidfire: {
    id: 'rapidfire',
    name: 'БЫСТРАЯ СТРЕЛЬБА',
    file: 'rapidfire.sys',
    rarity: 'rare',
    weight: 10,
    desc: 'Скорострельность x3. Очередь как из швейной машинки (но разброс больше).',
    icon: '≫',
  },
  norecoil: {
    id: 'norecoil',
    name: 'БЕЗ ОТДАЧИ',
    file: 'norecoil.cfg',
    rarity: 'rare',
    weight: 10,
    desc: 'Нулевой разброс даже в движении. Каждая пуля — точно в цель.',
    icon: '⊥',
  },
  bhop: {
    id: 'bhop',
    name: 'БАНИХОП',
    file: 'bhop.script',
    rarity: 'rare',
    weight: 10,
    desc: 'Скорость +40% и мгновенный разгон. Прыгай как кролик.',
    icon: '⟿',
  },
  triggerbot: {
    id: 'triggerbot',
    name: 'TRIGGERBOT',
    file: 'trigger.exe',
    rarity: 'epic',
    weight: 7,
    desc: 'Автоматическая стрельба, как только враг попадает под прицел.',
    icon: '✛',
  },
  speedhack: {
    id: 'speedhack',
    name: 'SPEEDHACK',
    file: 'speedhack.dll',
    rarity: 'common',
    weight: 9,
    desc: 'Скорость бега +55%. Нагло, быстро, эффективно.',
    icon: '⇥',
  },
  radar: {
    id: 'radar',
    name: 'РАДАР',
    file: 'radar.exe',
    rarity: 'common',
    weight: 9,
    desc: 'Все враги отображаются на мини-карте. Крысы не спрячутся.',
    icon: '◉',
  },
  infammo: {
    id: 'infammo',
    name: 'БЕСКОНЕЧНЫЕ ПАТРОНЫ',
    file: 'infammo.cfg',
    rarity: 'common',
    weight: 8,
    desc: 'Магазин никогда не пустеет. Перезарядка больше не нужна.',
    icon: '∞',
  },
  onehit: {
    id: 'onehit',
    name: 'ДВОЙНОЙ УРОН',
    file: 'damage2.cfg',
    rarity: 'epic',
    weight: 6,
    desc: 'Урон x2 — два попадания отправляют врага в спектаторы.',
    icon: '☠',
  },
  spinbot: {
    id: 'spinbot',
    name: 'SPINBOT',
    file: 'spinbot.dll',
    rarity: 'legendary',
    weight: 4,
    desc: 'Тролль-софт: прицел крутится на 360°. Иногда попадает, иногда нет.',
    icon: '✷',
  },
};

const RARITY = {
  common: { label: 'COMMON', color: '#7dd3fc' },
  rare: { label: 'RARE', color: '#a78bfa' },
  epic: { label: 'EPIC', color: '#f472b6' },
  legendary: { label: 'LEGENDARY', color: '#fbbf24' },
};

const LIST = Object.values(SOFTS);
const TOTAL_WEIGHT = LIST.reduce((s, x) => s + x.weight, 0);
// «двойной дроп»: доля игроков, у которых два софта. Настраивается через DOUBLE_SOFT_CHANCE
let SECOND_SOFT_CHANCE = 0.15;

function setDoubleSoftChance(v) {
  if (Number.isFinite(v)) SECOND_SOFT_CHANCE = Math.min(Math.max(v, 0), 1);
  return SECOND_SOFT_CHANCE;
}

function getDoubleSoftChance() {
  return SECOND_SOFT_CHANCE;
}

function rollOne(exclude) {
  let pool = LIST;
  if (exclude) pool = pool.filter((s) => s !== exclude);
  let r = Math.random() * pool.reduce((s, x) => s + x.weight, 0);
  for (const s of pool) {
    r -= s.weight;
    if (r <= 0) return s.id;
  }
  return pool[pool.length - 1].id;
}

// Возвращает массив id софтов для игрока на раунд.
function rollSofts() {
  const first = rollOne(null);
  if (Math.random() < SECOND_SOFT_CHANCE) {
    return [first, rollOne(SOFTS[first])];
  }
  return [first];
}

function publicCatalog() {
  return LIST.map((s) => ({
    id: s.id,
    name: s.name,
    file: s.file,
    rarity: s.rarity,
    color: RARITY[s.rarity].color,
    rarityLabel: RARITY[s.rarity].label,
    desc: s.desc,
    icon: s.icon,
    weight: s.weight,
  }));
}

module.exports = {
  SOFTS,
  RARITY,
  LIST,
  TOTAL_WEIGHT,
  rollSofts,
  publicCatalog,
  setDoubleSoftChance,
  getDoubleSoftChance,
};
