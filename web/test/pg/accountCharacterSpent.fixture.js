/**
 * Shared fixture for account_character_spent() vs buildSpentByAccountFromLoot.
 * Names/ids are prefixed so disposable PG suites do not collide with other fixtures.
 */
export const accounts = [
  { account_id: 'parity-acct-1', display_name: 'ParityMain1' },
  { account_id: 'parity-acct-2', display_name: 'ParityMain2' },
]

export const characters = [
  { char_id: 'parity-100', name: 'ParityBuyer' },
  { char_id: 'parity-101', name: 'ParityAlt' },
  { char_id: 'parity-200', name: 'ParityTwin' },
  { char_id: 'parity-201', name: 'paritybuyer' },
  { char_id: 'parity-300', name: 'ParityAmbiguous' },
  { char_id: 'parity-301', name: 'ParityAmbiguous' },
]

export const characterAccount = [
  { char_id: 'parity-100', account_id: 'parity-acct-1' },
  { char_id: 'parity-101', account_id: 'parity-acct-1' },
  { char_id: 'parity-200', account_id: 'parity-acct-2' },
  { char_id: 'parity-201', account_id: 'parity-acct-2' },
  { char_id: 'parity-300', account_id: 'parity-acct-1' },
  { char_id: 'parity-301', account_id: 'parity-acct-2' },
]

export const lootRows = [
  {
    char_id: 'parity-100',
    character_name: 'ParityBuyer',
    cost: '12',
    assigned_character_name: 'ParityAlt',
    assigned_char_id: null,
  },
  {
    char_id: 'parity-100',
    character_name: 'ParityBuyer',
    cost: 40,
    assigned_character_name: null,
    assigned_char_id: null,
  },
  {
    char_id: '',
    character_name: 'ParityBuyer',
    cost: '5',
    assigned_character_name: null,
    assigned_char_id: null,
  },
  {
    char_id: 'parity-100',
    character_name: '',
    cost: 7,
    assigned_character_name: null,
    assigned_char_id: null,
  },
  {
    char_id: 'parity-200',
    character_name: 'ParityTwin',
    cost: '3',
    assigned_character_name: null,
    assigned_char_id: 'parity-200',
  },
  {
    char_id: 'parity-200',
    character_name: 'ParityTwin',
    cost: 'not-a-number',
    assigned_character_name: null,
    assigned_char_id: null,
  },
  {
    char_id: '',
    character_name: 'ParityAmbiguous',
    cost: '11',
    assigned_character_name: null,
    assigned_char_id: null,
  },
  {
    char_id: '',
    character_name: 'PARITYBUYER',
    cost: '2.5',
    assigned_character_name: null,
    assigned_char_id: null,
  },
  {
    char_id: 'parity-999',
    character_name: 'ParityStranger',
    cost: 9,
    assigned_character_name: null,
    assigned_char_id: null,
  },
  {
    char_id: 'parity-100',
    character_name: 'ParityBuyer',
    cost: '10.25',
    assigned_character_name: null,
    assigned_char_id: null,
  },
]

export function lootRowsForJs() {
  return lootRows.map((row) => ({ ...row }))
}
