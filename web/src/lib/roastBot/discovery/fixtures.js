/**
 * Synthetic multi-raid fixtures for discovery unit tests.
 */

export const FIXTURE_ITEM_SOURCES = {
  'cloak of wishes': [{ mob: 'P3', zone: 'Plane of Time' }],
  'ossein of limitless time': [{ mob: 'P3', zone: 'Plane of Time' }],
  'pauldrons of purity': [{ mob: 'P3 Guardian', zone: 'Plane of Time' }],
  'sleeves of temporal force': [{ mob: 'P3', zone: 'Plane of Time' }],
  'mask of conceptual energy': [{ mob: 'P1', zone: 'Plane of Time' }],
  'eye of cazic thule': [{ mob: 'Cazic_Thule', zone: 'Plane of Time' }],
  'quarm tooth': [{ mob: 'Quarm', zone: 'Plane of Time' }],
  'band of the eternal': [{ mob: 'Quarm', zone: 'Plane of Time' }],
  'blazing whip of trillia': [{ mob: 'Fennin_Ro_the_Tyrant_of_Fire', zone: 'Plane of Fire' }],
  'timeless breastplate mold': [{ mob: 'P3', zone: 'Plane of Time' }],
  'timeless silk robe pattern': [{ mob: 'P3', zone: 'Plane of Time' }],
}

/** Conflicting dkp_mob_loot-style rows (should NOT override P3 for discovery). */
export const FIXTURE_MOB_LOOT = {
  'A_Deadly_Warboar|Plane of Time': {
    mob: 'A_Deadly_Warboar',
    zone: 'Plane of Time',
    loot: [
      { item_id: 21997, name: 'Cloak of Wishes' },
      { item_id: 68217, name: 'Ossein of Limitless Time' },
    ],
  },
  'P3|Plane of Time': {
    mob: 'P3',
    zone: 'Plane of Time',
    loot: [
      { item_id: 16375, name: 'Timeless Breastplate Mold' },
      { item_id: 16384, name: 'Timeless Silk Robe Pattern' },
      { item_id: 21997, name: 'Cloak of Wishes' },
      { item_id: 68217, name: 'Ossein of Limitless Time' },
    ],
  },
  'Quarm|Plane of Time': {
    mob: 'Quarm',
    zone: 'Plane of Time',
    loot: [
      { item_id: 90001, name: 'Quarm Tooth' },
      { item_id: 90003, name: 'Band of the Eternal' },
    ],
  },
  'Cazic_Thule|Plane of Time': {
    mob: 'Cazic_Thule',
    zone: 'Plane of Time',
    loot: [{ item_id: 90002, name: 'Eye of Cazic Thule' }],
  },
  'Fennin_Ro_the_Tyrant_of_Fire|Plane of Fire': {
    mob: 'Fennin_Ro_the_Tyrant_of_Fire',
    zone: 'Plane of Fire',
    loot: [{ item_id: 80001, name: 'Blazing Whip of Trillia' }],
  },
}

export const FIXTURE_ITEM_STATS = {
  '13638': {
    name: 'Pauldrons of Purity',
    slot: 'SHOULDERS',
    classes: 'CLR DRU SHM NEC WIZ MAG ENC',
  },
  '21997': {
    name: 'Cloak of Wishes',
    slot: 'BACK',
    classes: 'ALL',
  },
  '77777': {
    name: 'Sleeves of Temporal Force',
    slot: 'ARMS',
    classes: 'ALL',
  },
  '99999': {
    name: 'Plate of the Warrior',
    slot: 'SHOULDERS',
    classes: 'WAR PAL SHD',
  },
  '88888': {
    name: 'Spaulders of the Wind',
    slot: 'SHOULDERS',
    classes: 'RNG MNK BRD ROG BST',
  },
  '90003': {
    name: 'Band of the Eternal',
    slot: 'FINGER',
    classes: 'ALL',
  },
  '90001': {
    name: 'Quarm Tooth',
    slot: 'PRIMARY',
    classes: 'ALL',
  },
  '16375': {
    name: 'Timeless Breastplate Mold',
    slot: 'CHEST',
    classes: 'WAR PAL SHD CLR BRD',
  },
  '16384': {
    name: 'Timeless Silk Robe Pattern',
    slot: 'CHEST',
    classes: 'NEC WIZ MAG ENC',
  },
}

export const FIXTURE_RAIDS = [
  { raid_id: 'r-fire-new', raid_name: 'Fire Minis', date_iso: '2026-03-01' },
  { raid_id: 'r-fire-old', raid_name: 'PoF Full', date_iso: '2026-01-15' },
  { raid_id: 'r-time-mixed', raid_name: 'Time P1-P3 + Gods', date_iso: '2026-02-20' },
  { raid_id: 'r-time-p3', raid_name: 'Time P3', date_iso: '2026-02-10' },
  { raid_id: 'r-quarm', raid_name: 'Quarm', date_iso: '2026-02-25' },
  // Dated before r-time-mixed so "P3 last time" still selects the mixed night for EP-god filter tests
  { raid_id: 'r-molds-new', raid_name: 'Time Molds Recent', date_iso: '2026-02-18' },
  { raid_id: 'r-molds-old', raid_name: 'Time Molds Older', date_iso: '2026-01-20' },
  { raid_id: 'r-empty', raid_name: 'Fire empty', date_iso: '2025-12-01' },
]

export const FIXTURE_CLASSIFICATIONS = [
  { raid_id: 'r-fire-new', mob: 'Fennin_Ro_the_Tyrant_of_Fire', zone: 'Plane of Fire' },
  { raid_id: 'r-fire-old', mob: 'Fennin_Ro_the_Tyrant_of_Fire', zone: 'Plane of Fire' },
  { raid_id: 'r-empty', mob: 'Fennin_Ro_the_Tyrant_of_Fire', zone: 'Plane of Fire' },
  { raid_id: 'r-time-mixed', mob: 'P3', zone: 'Plane of Time' },
  { raid_id: 'r-time-mixed', mob: 'P3 Guardian', zone: 'Plane of Time' },
  { raid_id: 'r-time-mixed', mob: 'Cazic_Thule', zone: 'Plane of Time' },
  { raid_id: 'r-time-p3', mob: 'P3', zone: 'Plane of Time' },
  { raid_id: 'r-quarm', mob: 'Quarm', zone: 'Plane of Time' },
  { raid_id: 'r-molds-new', mob: 'P3', zone: 'Plane of Time' },
  { raid_id: 'r-molds-old', mob: 'P3', zone: 'Plane of Time' },
]

/** Loot rows keyed by raid_id (assignment view shape). */
export const FIXTURE_LOOT_BY_RAID = {
  'r-fire-new': [
    {
      id: 1,
      raid_id: 'r-fire-new',
      item_name: 'Blazing Whip of Trillia',
      character_name: 'Tandiyen',
      char_id: 'c1',
      cost: '50',
    },
  ],
  'r-fire-old': [
    {
      id: 2,
      raid_id: 'r-fire-old',
      item_name: 'Blazing Whip of Trillia',
      character_name: 'Ammordius',
      char_id: 'c2',
      cost: '40',
    },
  ],
  'r-empty': [],
  'r-time-mixed': [
    {
      id: 3,
      raid_id: 'r-time-mixed',
      item_name: 'Cloak of Wishes',
      character_name: 'Alice',
      char_id: 'c3',
      cost: '10',
    },
    {
      id: 4,
      raid_id: 'r-time-mixed',
      item_name: 'Pauldrons of Purity',
      character_name: 'Bob',
      char_id: 'c4',
      cost: '20',
    },
    {
      id: 5,
      raid_id: 'r-time-mixed',
      item_name: 'Eye of Cazic Thule',
      character_name: 'Carol',
      char_id: 'c5',
      cost: '30',
    },
  ],
  'r-time-p3': [
    {
      id: 6,
      raid_id: 'r-time-p3',
      item_name: 'Ossein of Limitless Time',
      character_name: 'Dave',
      char_id: 'c6',
      cost: '15',
    },
    {
      id: 10,
      raid_id: 'r-time-p3',
      item_name: 'Sleeves of Temporal Force',
      character_name: 'Gina',
      char_id: 'c10',
      cost: '12',
    },
  ],
  'r-quarm': [
    {
      id: 7,
      raid_id: 'r-quarm',
      item_name: 'Quarm Tooth',
      character_name: 'Eve',
      char_id: 'c7',
      cost: '100',
    },
    {
      id: 11,
      raid_id: 'r-quarm',
      item_name: 'Band of the Eternal',
      character_name: 'Helen',
      char_id: 'c11',
      cost: '75',
    },
  ],
  'r-molds-new': [
    {
      id: 20,
      raid_id: 'r-molds-new',
      item_name: 'Timeless Breastplate Mold',
      character_name: 'PlateWinner',
      char_id: 'c20',
      cost: '200',
    },
    {
      id: 21,
      raid_id: 'r-molds-new',
      item_name: 'Timeless Silk Robe Pattern',
      character_name: 'SilkWinner',
      char_id: 'c21',
      cost: '180',
    },
  ],
  'r-molds-old': [
    {
      id: 22,
      raid_id: 'r-molds-old',
      item_name: 'Timeless Breastplate Mold',
      character_name: 'OldPlate',
      char_id: 'c22',
      cost: '190',
    },
    {
      id: 23,
      raid_id: 'r-molds-old',
      item_name: 'Timeless Silk Robe Pattern',
      character_name: 'OldSilk',
      char_id: 'c23',
      cost: '170',
    },
  ],
}

/** Characters for assigned-toon class enrichment in discovery fetch tests. */
export const FIXTURE_CHARACTERS = [
  { char_id: 'c1', name: 'Tandiyen', class_name: 'Wizard' },
  { char_id: 'c2', name: 'Ammordius', class_name: 'Magician' },
  { char_id: 'c3', name: 'Alice', class_name: 'Enchanter' },
  { char_id: 'c4', name: 'Bob', class_name: 'Cleric' },
  { char_id: 'c5', name: 'Carol', class_name: 'Warrior' },
  { char_id: 'c6', name: 'Dave', class_name: 'Paladin' },
  { char_id: 'c7', name: 'Eve', class_name: 'Ranger' },
  { char_id: 'c8', name: 'Frank', class_name: 'Rogue' },
  { char_id: 'c10', name: 'Gina', class_name: 'Bard' },
  { char_id: 'c11', name: 'Helen', class_name: 'Enchanter' },
  { char_id: 'c12', name: 'Older', class_name: 'Wizard' },
  { char_id: 'c20', name: 'PlateWinner', class_name: 'Warrior' },
  { char_id: 'c21', name: 'SilkWinner', class_name: 'Wizard' },
  { char_id: 'c22', name: 'OldPlate', class_name: 'Paladin' },
  { char_id: 'c23', name: 'OldSilk', class_name: 'Enchanter' },
  { char_id: 'c-raud', name: 'Raud', class_name: 'Monk' },
]

/** Default Magelo-style self-assignment when a fixture row omits assignment cols. */
function withDefaultAssignment(row) {
  const assignedCharId = row.assigned_char_id ?? row.char_id ?? null
  const assignedCharacterName = row.assigned_character_name ?? row.character_name ?? null
  return {
    ...row,
    assigned_char_id: assignedCharId,
    assigned_character_name: assignedCharacterName,
  }
}

/** Flattened history rows with dates. */
export function fixtureHistoryRows() {
  const raidsById = Object.fromEntries(FIXTURE_RAIDS.map((r) => [r.raid_id, r]))
  /** @type {object[]} */
  const rows = []
  for (const [raidId, loot] of Object.entries(FIXTURE_LOOT_BY_RAID)) {
    const raid = raidsById[raidId]
    for (const row of loot) {
      rows.push(
        withDefaultAssignment({
          ...row,
          raid_name: raid?.raid_name,
          date_iso: raid?.date_iso,
          date: raid?.date_iso,
        }),
      )
    }
  }
  // Duplicate award for date-ordering / multi-recipient tests
  rows.push(
    withDefaultAssignment({
      id: 8,
      raid_id: 'r-fire-old',
      item_name: 'Cloak of Wishes',
      character_name: 'Ammordius',
      char_id: 'c2',
      cost: '5',
      raid_name: 'PoF Full',
      date_iso: '2026-01-15',
      date: '2026-01-15',
    }),
  )
  rows.push(
    withDefaultAssignment({
      id: 9,
      raid_id: 'r-time-p3',
      item_name: 'Cloak of Wishes',
      character_name: 'Frank',
      char_id: 'c8',
      cost: '8',
      raid_name: 'Time P3',
      date_iso: '2026-02-10',
      date: '2026-02-10',
    }),
  )
  // Older Quarm ring award (distant history) — last drop should prefer r-quarm Helen
  rows.push(
    withDefaultAssignment({
      id: 12,
      raid_id: 'r-time-mixed',
      item_name: 'Band of the Eternal',
      character_name: 'Older',
      char_id: 'c12',
      cost: '70',
      raid_name: 'Time P1-P3 + Gods',
      date_iso: '2026-01-01',
      date: '2026-01-01',
    }),
  )
  // Buyer ≠ assignee (class enrichment / render annotation)
  rows.push({
    id: 13,
    raid_id: 'r-quarm',
    item_name: 'Wristband of Icy Vengeance',
    character_name: 'Fayze',
    char_id: 'c-fayze',
    cost: '34',
    raid_name: 'Quarm Kill',
    date_iso: '2025-06-12',
    date: '2025-06-12',
    assigned_char_id: 'c-raud',
    assigned_character_name: 'Raud',
  })
  return rows
}
