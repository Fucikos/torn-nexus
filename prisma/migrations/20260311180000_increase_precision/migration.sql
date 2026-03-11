-- alter existing columns to four‑decimal precision
ALTER TABLE "rounds" ALTER COLUMN "crash_point" TYPE decimal(10,4);
ALTER TABLE "bets" ALTER COLUMN "cashout_mult" TYPE decimal(10,4);
