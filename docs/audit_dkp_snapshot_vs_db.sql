-- Audit DKP: snapshot (per-account from HTML) vs DB account totals. Run in Supabase SQL Editor.
-- Snapshot rows are already aggregated per account; we sum dkp_summary by account_id and compare.

WITH snapshot AS (
  SELECT * FROM (VALUES
  ('Inacht', 5050, 3773),
  ('Baily', 2686, 2338),
  ('Rimidal', 4626, 4414),
  ('Radda', 1845, 1635),
  ('Pickletickle', 1105, 897),
  ('Fayze', 2399, 2196),
  ('Akbar', 1006, 835),
  ('Crushzilla', 4159, 4014),
  ('Vanuk', 877, 734),
  ('Uberest', 680, 541),
  ('Diox', 1798, 1664),
  ('Zender', 2368, 2244),
  ('Bhodi', 2869, 2746),
  ('Zentile', 1668, 1561),
  ('Shoosh', 1976, 1873),
  ('Shortok', 613, 524),
  ('Debrie', 717, 642),
  ('Jarisy', 2190, 2121),
  ('Lamia', 3049, 2983),
  ('Gheff', 2213, 2153),
  ('Dula Allazaward', 2037, 1978),
  ('Dopp', 773, 718),
  ('Elrontaur', 410, 335),
  ('Savok', 3604, 3551),
  ('Slay', 2677, 2626),
  ('Emryes', 318, 268),
  ('Kovah', 304, 254),
  ('Spreckles', 1345, 1296),
  ('Barndog', 683, 638),
  ('Aldiss', 650, 607),
  ('Thornwood', 148, 106),
  ('Silent', 608, 567),
  ('Captainhash', 51, 10),
  ('Rgrok', 276, 235),
  ('Pursuit', 821, 781),
  ('Cavalier', 1536, 1497),
  ('Frinop', 1943, 1904),
  ('Gulo', 664, 627),
  ('Wildcaller', 46, 9),
  ('Minpal', 1075, 1039),
  ('Serro', 2256, 2221),
  ('Walex', 3216, 3182),
  ('Fireblade', 218, 185),
  ('Jyslia', 1510, 1478),
  ('Rembylynn', 668, 636),
  ('Hamorf', 227, 197),
  ('Pigpen', 330, 300),
  ('Bopp', 590, 561),
  ('Xaiterlyn', 1040, 1013),
  ('Darco', 32, 5),
  ('Monara', 1013, 987),
  ('Fanglore', 239, 213),
  ('Warboss', 1316, 1291),
  ('Tudogs', 270, 245),
  ('Rangerwoodelf', 560, 538),
  ('Handolur', 21, 0),
  ('Zelus', 40, 19),
  ('Bizo', 572, 553),
  ('Skaruga', 353, 334),
  ('Threllin', 157, 138),
  ('Stickie', 27, 8),
  ('Pugnacious', 796, 778),
  ('Hinora', 18, 0),
  ('Elcid', 57, 40),
  ('Sverder', 94, 78),
  ('Headcrushar', 243, 227),
  ('Noze', 15, 0),
  ('Meww', 1026, 1012),
  ('Meriadoc', 88, 74),
  ('Manstache', 35, 21),
  ('Culkasi', 696, 683),
  ('Adilene', 257, 244),
  ('Wesley', 21, 9),
  ('Thian', 149, 138),
  ('Beanwolf', 357, 346),
  ('Zaltak', 503, 492),
  ('Omegalord', 11, 0),
  ('Xcivi', 82, 72),
  ('Tolsarian', 71, 62),
  ('Tyrreni', 52, 43),
  ('Jisu', 8, 0),
  ('Neokkin', 526, 519),
  ('Yuukii', 320, 314),
  ('Ammordius', 877, 872),
  ('Tuluvien', 733, 728),
  ('Timmysk', 7, 2),
  ('Necrophobia', 4, 0),
  ('Nemce', 1288, 1285),
  ('Kohler', 85, 82),
  ('Tesadar', 127, 124),
  ('Tuen', 68, 65),
  ('Mugs', 3, 0),
  ('Clegane', 171, 169),
  ('Fridgelargemeat', 2, 0),
  ('Paen', 0, 0),
  ('Freedom', 0, 0),
  ('Bruceh', 0, 0),
  ('Gekal', 0, 0),
  ('Aurellia', 0, 0),
  ('Notoriousone', 0, 0),
  ('Cavalier_Backup', 0, 0),
  ('Askepios', 0, 0),
  ('Princevelium', 0, 0),
  ('Darcnite', 0, 0),
  ('Mugs', 0, 0),
  ('Megatherion', 0, 0),
  ('Kaindragoon', 0, 0)
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
