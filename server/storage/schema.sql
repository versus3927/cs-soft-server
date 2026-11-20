-- ─────────────────────────────────────────────────────────────
--  Схема истории раундов CS SOFT.
--  Применяется автоматически при старте (CREATE TABLE IF NOT EXISTS).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS rounds (
  id          BIGSERIAL PRIMARY KEY,
  game        TEXT        NOT NULL DEFAULT 'cs-soft',   -- какой сервер/инстанс
  round_no    INTEGER     NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game, round_no)
);

-- какой игрок какой софт получил в этом раунде
CREATE TABLE IF NOT EXISTS round_softs (
  id         BIGSERIAL PRIMARY KEY,
  round_id   BIGINT      NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id  BIGINT      NOT NULL,
  player_name TEXT       NOT NULL,
  soft_id    TEXT        NOT NULL,
  soft_name  TEXT        NOT NULL,
  rarity     TEXT        NOT NULL,
  mechanic   TEXT
);

CREATE INDEX IF NOT EXISTS idx_round_softs_round  ON round_softs(round_id);
CREATE INDEX IF NOT EXISTS idx_round_softs_player ON round_softs(player_name);

-- готовые агрегаты для статистики/лидерборда
CREATE TABLE IF NOT EXISTS player_soft_stats (
  player_name TEXT    NOT NULL,
  soft_id     TEXT    NOT NULL,
  times_total INTEGER NOT NULL DEFAULT 0,
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_name, soft_id)
);
