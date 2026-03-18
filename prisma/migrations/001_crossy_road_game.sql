-- Migration: Replace crash-game tables with crossy-road Game model
-- Run this manually in Supabase SQL editor or via prisma migrate

-- Drop old tables (order matters for FK constraints)
DROP TABLE IF EXISTS "bets" CASCADE;
DROP TABLE IF EXISTS "rounds" CASCADE;
DROP TABLE IF EXISTS "game_state" CASCADE;

-- Drop old enums
DROP TYPE IF EXISTS "round_phase" CASCADE;

-- Update transactions table: swap round_id for game_id
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "round_id";
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "game_id" INTEGER;

-- Create game_status enum
DO $$ BEGIN
  CREATE TYPE "game_status" AS ENUM ('ACTIVE', 'CASHED_OUT', 'BUSTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create games table
CREATE TABLE IF NOT EXISTS "games" (
  "id"            SERIAL PRIMARY KEY,
  "user_id"       INTEGER NOT NULL REFERENCES "users"("id"),
  "bet_amount"    BIGINT NOT NULL,
  "seed"          TEXT NOT NULL,
  "steps_reached" INTEGER NOT NULL DEFAULT 0,
  "cashout_mult"  DECIMAL(10,4),
  "payout"        BIGINT NOT NULL DEFAULT 0,
  "fee"           BIGINT NOT NULL DEFAULT 0,
  "status"        "game_status" NOT NULL DEFAULT 'ACTIVE',
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "ended_at"      TIMESTAMPTZ
);

-- FK from transactions to games
ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_game_id_fkey"
  FOREIGN KEY ("game_id") REFERENCES "games"("id")
  ON DELETE SET NULL;

-- Index for fast per-user lookups
CREATE INDEX IF NOT EXISTS "games_user_id_idx" ON "games"("user_id");
CREATE INDEX IF NOT EXISTS "games_status_idx"  ON "games"("status");
