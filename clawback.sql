-- PAT tip-exploit claw-back (d0g3-origin, scripting from 2026-07-16)
-- BACK UP THE DB FIRST:   cp myapp.db myapp.db.bak
-- Then run:               sqlite3 myapp.db < clawback.sql
--
-- Net: removes 72,000,567 minted PAT; 10,000,000 of it is re-seeded into the jackpot.
--   d0g3       9,225,661 -> 5,000,000   (kept 5M bounty for reporting the exploit)
--   kimmy      65,429,267 -> 60,000     (-65,369,267)
--   wise_guy   26,701,034 -> 24,295,395 (-2,405,639)
--   jackpot    +10,000,000

BEGIN TRANSACTION;

-- Audit rows (capture the ACTUAL delta from current balance, before the updates)
INSERT INTO transactions (transactionId, userId, type, points)
  SELECT lower(hex(randomblob(16))), userId, 'Exploit bounty (d0g3)', 5000000 - points_balance
  FROM users WHERE userId = '67f9bb21-66cf-49a3-98d8-ff53cb5c3326';

INSERT INTO transactions (transactionId, userId, type, points)
  SELECT lower(hex(randomblob(16))), userId, 'Exploit clawback', -MIN(points_balance, 65369267)
  FROM users WHERE userId = 'e6b1197c-ff12-4f73-a608-ef51f43336fc';

INSERT INTO transactions (transactionId, userId, type, points)
  SELECT lower(hex(randomblob(16))), userId, 'Exploit clawback', -MIN(points_balance, 2405639)
  FROM users WHERE userId = '0ccbaf0d-fb31-4153-9fe2-7531859576cc';

-- Balance corrections
UPDATE users SET points_balance = 5000000
  WHERE userId = '67f9bb21-66cf-49a3-98d8-ff53cb5c3326';                 -- d0g3 -> 5M bounty

UPDATE users SET points_balance = MAX(0, points_balance - 65369267)
  WHERE userId = 'e6b1197c-ff12-4f73-a608-ef51f43336fc';                 -- kimmy_cakes

UPDATE users SET points_balance = MAX(0, points_balance - 2405639)
  WHERE userId = '0ccbaf0d-fb31-4153-9fe2-7531859576cc';                 -- wise_guy007

-- Seed 10,000,000 of the recovered PAT into the jackpot pot
INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount)
  VALUES (lower(hex(randomblob(16))), NULL, NULL, 10000000);

COMMIT;
