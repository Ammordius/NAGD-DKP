-- Audit DKP: snapshot (per-account from HTML) vs DB account totals. Run in Supabase SQL Editor.
-- Snapshot rows are already aggregated per account; we sum dkp_summary by account_id and compare.

WITH snapshot AS (
  SELECT * FROM (VALUES
  ('Inacht', 5106, 3773),
  ('Baily', 2686, 2338),
  ('Rimidal', 4652, 4436),
  ('Radda', 1845, 1635),
  ('Pickletickle', 1105, 897),
  ('Fayze', 2421, 2226),
  ('Akbar', 1059, 881),
  ('Bhodi', 2925, 2759),
  ('Crushzilla', 4215, 4058),
  ('Vanuk', 877, 734),
  ('Diox', 1798, 1664),
  ('Zender', 2373, 2244),
  ('Uberest', 731, 620),
  ('Zentile', 1680, 1571),
  ('Shoosh', 1976, 1873),
  ('Shortok', 613, 524),
  ('Lamia', 3075, 2999),
  ('Slay', 2721, 2645),
  ('Elrontaur', 431, 344),
  ('Dula Allazaward', 2037, 1978),
  ('Gheff', 2224, 2169),
  ('Savok', 3604, 3551),
  ('Emryes', 318, 268),
  ('Spreckles', 1345, 1296),
  ('Rembylynn', 724, 676),
  ('Kovah', 322, 275),
  ('Ammordius', 929, 884),
  ('Fireblade', 240, 196),
  ('Walex', 3225, 3182),
  ('Jarisy', 2240, 2197),
  ('Beanwolf', 397, 355),
  ('Thornwood', 148, 106),
  ('Cavalier', 1538, 1497),
  ('Captainhash', 51, 10),
  ('Rgrok', 276, 235),
  ('Minpal', 1105, 1066),
  ('Gulo', 664, 627),
  ('Monara', 1069, 1032),
  ('Wildcaller', 46, 9),
  ('Pugnacious', 849, 815),
  ('Headcrushar', 276, 242),
  ('Frinop', 1993, 1960),
  ('Zaltak', 554, 521),
  ('Debrie', 773, 741),
  ('Stickie', 40, 8),
  ('Meww', 1045, 1014),
  ('Hamorf', 227, 197),
  ('Jyslia', 1566, 1537),
  ('Barndog', 734, 705),
  ('Xaiterlyn', 1040, 1013),
  ('Tudogs', 272, 245),
  ('Darco', 63, 36),
  ('Kalmic', 35, 8),
  ('Tuluvien', 784, 758),
  ('Fanglore', 239, 213),
  ('Warboss', 1316, 1291),
  ('Sverder', 102, 80),
  ('Rangerwoodelf', 560, 538),
  ('Lalisa', 172, 150),
  ('Handolur', 21, 0),
  ('Zelus', 41, 21),
  ('Bizo', 572, 553),
  ('Skaruga', 353, 334),
  ('Silent', 661, 642),
  ('Hinora', 18, 0),
  ('Elcid', 57, 40),
  ('Clegane', 186, 169),
  ('Noze', 20, 3),
  ('Pigpen', 356, 340),
  ('Meriadoc', 88, 74),
  ('Manstache', 35, 21),
  ('Culkasi', 696, 683),
  ('Karis', 385, 373),
  ('Threllin', 199, 187),
  ('Wesley', 21, 9),
  ('Thian', 149, 138),
  ('Omegalord', 11, 0),
  ('Tesadar', 136, 126),
  ('Xcivi', 82, 72),
  ('Adilene', 296, 286),
  ('Yuukii', 331, 322),
  ('Tolsarian', 71, 62),
  ('Tyrreni', 52, 43),
  ('Jisu', 8, 0),
  ('Bopp', 600, 593),
  ('Pursuit', 865, 858),
  ('Neokkin', 526, 519),
  ('Mugs', 36, 29),
  ('Timmysk', 7, 2),
  ('Dopp', 789, 785),
  ('Necrophobia', 4, 0),
  ('Aldiss', 704, 700),
  ('Nemce', 1288, 1285),
  ('Kohler', 85, 82),
  ('Tuen', 68, 65),
  ('Fridgelargemeat', 2, 0),
  ('Serro', 2298, 2297),
  ('Paen', 0, 0),
  ('Freedom', 0, 0),
  ('Bruceh', 0, 0),
  ('Gekal', 0, 0),
  ('Aurellia', 0, 0),
  ('Notoriousone', 0, 0),
  ('Cavalier_Backup', 0, 0),
  ('Askepios', 0, 0),
  ('Princevelium', 0, 0),
  ('Megatherion', 0, 0),
  ('Kaindragoon', 0, 0),
  ('Munga', 0, 0),
  ('Meledus', 0, 0),
  ('Fillet', 0, 0),
  ('Buug', 0, 0),
  ('Duddly', 0, 0),
  ('Zugs', 0, 0),
  ('Snugs', 0, 0),
  ('Sugarbear', 0, 0),
  ('Euterpe', 0, 0),
  ('David', 0, 0),
  ('Cyst', 0, 0),
  ('Duess', 0, 0)
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
