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
}

export const FIXTURE_RAIDS = [
  { raid_id: 'r-fire-new', raid_name: 'Fire Minis', date_iso: '2026-03-01' },
  { raid_id: 'r-fire-old', raid_name: 'PoF Full', date_iso: '2026-01-15' },
  { raid_id: 'r-time-mixed', raid_name: 'Time P1-P3 + Gods', date_iso: '2026-02-20' },
  { raid_id: 'r-time-p3', raid_name: 'Time P3', date_iso: '2026-02-10' },
  { raid_id: 'r-quarm', raid_name: 'Quarm', date_iso: '2026-02-25' },
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
}

/** Flattened history rows with dates. */
export function fixtureHistoryRows() {
  const raidsById = Object.fromEntries(FIXTURE_RAIDS.map((r) => [r.raid_id, r]))
  /** @type {object[]} */
  const rows = []
  for (const [raidId, loot] of Object.entries(FIXTURE_LOOT_BY_RAID)) {
    const raid = raidsById[raidId]
    for (const row of loot) {
      rows.push({
        ...row,
        raid_name: raid?.raid_name,
        date_iso: raid?.date_iso,
        date: raid?.date_iso,
        assigned_char_id: null,
        assigned_character_name: null,
      })
    }
  }
  // Duplicate award for date-ordering / multi-recipient tests
  rows.push({
    id: 8,
    raid_id: 'r-fire-old',
    item_name: 'Cloak of Wishes',
    character_name: 'Ammordius',
    char_id: 'c2',
    cost: '5',
    raid_name: 'PoF Full',
    date_iso: '2026-01-15',
    date: '2026-01-15',
    assigned_char_id: null,
    assigned_character_name: null,
  })
  rows.push({
    id: 9,
    raid_id: 'r-time-p3',
    item_name: 'Cloak of Wishes',
    character_name: 'Frank',
    char_id: 'c8',
    cost: '8',
    raid_name: 'Time P3',
    date_iso: '2026-02-10',
    date: '2026-02-10',
    assigned_char_id: null,
    assigned_character_name: null,
  })
  // Older Quarm ring award (distant history) — last drop should prefer r-quarm Helen
  rows.push({
    id: 12,
    raid_id: 'r-time-mixed',
    item_name: 'Band of the Eternal',
    character_name: 'Older',
    char_id: 'c12',
    cost: '70',
    raid_name: 'Time P1-P3 + Gods',
    date_iso: '2026-01-01',
    date: '2026-01-01',
    assigned_char_id: null,
    assigned_character_name: null,
  })
  return rows
}
