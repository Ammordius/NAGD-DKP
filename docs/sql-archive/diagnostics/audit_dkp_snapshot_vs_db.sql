-- Audit DKP: snapshot (per-account from HTML) vs DB account totals. Run in Supabase SQL Editor.
-- Snapshot rows are already aggregated per account; we sum dkp_summary by account_id and compare.

WITH snapshot AS (
  SELECT * FROM (VALUES
  ('Inacht', 5133, 3773),
  ('Baily', 2686, 2338),
  ('Rimidal', 4670, 4448),
  ('Radda', 1845, 1635),
  ('Pickletickle', 1105, 897),
  ('Fayze', 2436, 2247),
  ('Crushzilla', 4242, 4058),
  ('Bhodi', 2952, 2784),
  ('Vanuk', 877, 734),
  ('Diox', 1798, 1664),
  ('Zender', 2373, 2244),
  ('Akbar', 1086, 959),
  ('Uberest', 756, 629),
  ('Zentile', 1680, 1571),
  ('Shoosh', 1976, 1873),
  ('Shortok', 613, 524),
  ('Lamia', 3081, 2999),
  ('Slay', 2748, 2678),
  ('Rgrok', 303, 235),
  ('Gheff', 2233, 2169),
  ('Jarisy', 2264, 2200),
  ('Dula Allazaward', 2037, 1978),
  ('Frinop', 2018, 1960),
  ('Fireblade', 261, 203),
  ('Ammordius', 952, 895),
  ('Kovah', 330, 275),
  ('Savok', 3604, 3551),
  ('Debrie', 800, 749),
  ('Emryes', 318, 268),
  ('Spreckles', 1345, 1296),
  ('Tuluvien', 811, 764),
  ('Elrontaur', 442, 375),
  ('Pugnacious', 876, 832),
  ('Walex', 3225, 3182),
  ('Thornwood', 148, 106),
  ('Cavalier', 1538, 1497),
  ('Captainhash', 51, 10),
  ('Kalmic', 53, 14),
  ('Rembylynn', 749, 711),
  ('Gulo', 664, 627),
  ('Wildcaller', 46, 9),
  ('Minpal', 1116, 1082),
  ('Clegane', 203, 169),
  ('Adilene', 319, 286),
  ('Stickie', 40, 8),
  ('Tudogs', 276, 245),
  ('Aldiss', 731, 700),
  ('Hamorf', 227, 197),
  ('Zaltak', 579, 551),
  ('Xaiterlyn', 1040, 1013),
  ('Silent', 685, 658),
  ('Lalisa', 177, 150),
  ('Barndog', 760, 733),
  ('Darco', 86, 59),
  ('Sverder', 106, 80),
  ('Fanglore', 239, 213),
  ('Warboss', 1316, 1291),
  ('Rangerwoodelf', 560, 538),
  ('Threllin', 212, 190),
  ('Monara', 1096, 1075),
  ('Handolur', 21, 0),
  ('Jyslia', 1593, 1573),
  ('Zelus', 41, 21),
  ('Pigpen', 379, 359),
  ('Bizo', 572, 553),
  ('Skaruga', 353, 334),
  ('Hinora', 18, 0),
  ('Headcrushar', 301, 283),
  ('Noze', 20, 3),
  ('Pursuit', 886, 870),
  ('Cutten', 131, 116),
  ('Serro', 2316, 2302),
  ('Meriadoc', 88, 74),
  ('Manstache', 35, 21),
  ('Elcid', 64, 50),
  ('Culkasi', 696, 683),
  ('Karis', 385, 373),
  ('Wesley', 21, 9),
  ('Thian', 149, 138),
  ('Beanwolf', 418, 407),
  ('Omegalord', 11, 0),
  ('Dopp', 816, 806),
  ('Tesadar', 136, 126),
  ('Xcivi', 82, 72),
  ('Yuukii', 331, 322),
  ('Tolsarian', 71, 62),
  ('Tyrreni', 52, 43),
  ('Necrophobia', 8, 0),
  ('Jisu', 8, 0),
  ('Bopp', 600, 593),
  ('Meww', 1053, 1046),
  ('Neokkin', 526, 519),
  ('Timmysk', 7, 2),
  ('Megatherion', 4, 0),
  ('Nemce', 1288, 1285),
  ('Kohler', 85, 82),
  ('Tuen', 68, 65),
  ('Mugs', 51, 48),
  ('Deepmind', 3, 0),
  ('Fridgelargemeat', 2, 0),
  ('Paen', 0, 0),
  ('Freedom', 0, 0),
  ('Bruceh', 0, 0),
  ('Gekal', 0, 0),
  ('Aurellia', 0, 0),
  ('Notoriousone', 0, 0),
  ('Cavalier_Backup', 0, 0),
  ('Kaindragoon', 0, 0),
  ('Munga', 0, 0),
  ('Pullen', 0, 0)
  ) AS t(account_name, earned, spent)
),
-- Match snapshot account_name to account_id (display_name or any linked character name); one row per snapshot
account_match AS (
  SELECT DISTINCT ON (u.account_name) u.account_name, u.earned, u.spent, u.account_id
  FROM (
    SELECT s.account_name, s.earned, s.spent, a.account_id FROM snapshot s JOIN accounts a ON trim(a.display_name) = s.account_name
    UNION
    SELECT s.account_name, s.earned, s.spent, ca.account_id FROM snapshot s JOIN character_account ca ON true JOIN characters c ON c.char_id = ca.char_id AND trim(c.name) = s.account_name
  ) u
  ORDER BY u.account_name, u.account_id
),
-- Sum dkp_summary by account (character_key can be char_id or character_name)
db_by_account AS (
  SELECT account_id, sum(db_earned)::bigint AS db_earned, sum(db_spent)::bigint AS db_spent
  FROM (
    SELECT ca.account_id, (d.earned)::numeric AS db_earned, d.spent::bigint AS db_spent
    FROM character_account ca
    JOIN dkp_summary d ON d.character_key = ca.char_id
    UNION ALL
    SELECT ca.account_id, (d.earned)::numeric, d.spent::bigint
    FROM character_account ca
    JOIN characters c ON c.char_id = ca.char_id
    JOIN dkp_summary d ON d.character_key = trim(c.name)
  ) sub
  GROUP BY account_id
)
SELECT
  m.account_name,
  m.account_id,
  m.earned   AS snapshot_earned,
  m.spent    AS snapshot_spent,
  d.db_earned,
  d.db_spent,
  (m.earned - COALESCE(d.db_earned, 0))::bigint AS delta_earned,
  (m.spent  - COALESCE(d.db_spent, 0))::bigint  AS delta_spent,
  CASE
    WHEN d.account_id IS NULL THEN 'missing_in_db'
    WHEN m.earned <> COALESCE(d.db_earned, 0) OR m.spent <> COALESCE(d.db_spent, 0) THEN 'mismatch'
    ELSE 'ok'
  END AS status
FROM account_match m
LEFT JOIN db_by_account d ON d.account_id = m.account_id
ORDER BY (CASE WHEN d.account_id IS NULL THEN 2 WHEN m.earned <> COALESCE(d.db_earned, 0) OR m.spent <> COALESCE(d.db_spent, 0) THEN 1 ELSE 0 END) DESC, (m.earned - COALESCE(d.db_earned, 0)) DESC NULLS LAST;
