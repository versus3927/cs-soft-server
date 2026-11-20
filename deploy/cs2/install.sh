#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Установка CS2-сервера на чистый Ubuntu 22.04/24.04 (root).
#  Запуск:  bash install.sh
#  Скрипт идемпотентный: можно запускать повторно.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say() { echo -e "${GREEN}[cs2]${NC} $1"; }
warn() { echo -e "${YELLOW}[cs2]${NC} $1"; }
die() { echo -e "${RED}[cs2]${NC} $1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "запускать от root: sudo bash install.sh"

# ── 1. Проверка ресурсов ──
RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
say "RAM: ${RAM_MB} МБ, свободно на диске: ${DISK_GB} ГБ"
[[ $RAM_MB -ge 3500 ]] || warn "меньше 4 ГБ RAM — CS2 может падать. Рекомендую 4-8 ГБ."
[[ $DISK_GB -ge 70 ]] || warn "меньше 70 ГБ диска — установка CS2 (~60 ГБ) может не влезть."

# ── 2. Docker ──
if ! command -v docker >/dev/null 2>&1; then
  say "ставлю Docker..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg openssl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
  say "Docker уже стоит: $(docker --version)"
fi

# ── 3. Firewall ──
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "открываю порты в ufw"
  ufw allow 27015/tcp >/dev/null
  ufw allow 27015/udp >/dev/null
  ufw allow 27020/udp >/dev/null
fi

# ── 4. Файлы проекта ──
cd "$(dirname "$0")"
if [[ ! -f .env ]]; then
  cp .env.example .env
  TOKEN=$(openssl rand -hex 24)
  sed -i "s|ROUNDS_TOKEN=.*|ROUNDS_TOKEN=\"${TOKEN}\"|" .env
  say "создал .env и сгенерировал ROUNDS_TOKEN"
  warn "ОСТАЛОСЬ ВПИСАТЬ GSLT: nano .env → SRCDS_TOKEN=..."
else
  say ".env уже есть, не трогаю"
fi

# ── Настройка под вариант хостинга ──
if [[ "${1:-}" == "--playit" ]]; then
  CPFILE="docker-compose.playit.yml"
  say "режим playit.gg: публичный IP не нужен, трафик пойдёт через туннель"
else
  CPFILE="docker-compose.yml"
fi

# ── 5. Публичный IP для подсказки ──
IP=$(curl -4 -s --max-time 5 https://ifconfig.me || echo "IP.IP.IP.IP")

cat <<EOF

$(say "почти готово") Что делать дальше:

 1) Получи GSLT-токен (бесплатно, нужен Steam-аккаунт с CS2):
    https://steamcommunity.com/dev/managegameservers  → App ID 730

 2) Впиши его в конфиг:
    nano $(pwd)/.env     →  SRCDS_TOKEN="твой_токен"

 3) Запусти:
    cd $(pwd) && docker compose -f ${CPFILE} up -d
    docker compose -f ${CPFILE} logs -f cs2    # первый старт качает ~60 ГБ

 4) Когда в логе появится "GameServerSteamAPIActivated", заходи в CS2:
    открыть консоль (~) и ввести:

        connect ${IP}:27015


 5) Плагин софтов (опционально, см. PLUGIN.md в этой папке) кладётся в
    ./data/game/csgo/addons/counterstrikesharp/plugins/CsSoft/

  Статус моста:  docker compose logs -f cs-soft
EOF
