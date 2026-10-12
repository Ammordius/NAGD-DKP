/**
 * Client rules for the officer display-name picker.
 * The database function is the authority; these checks keep the form from
 * submitting a character that is not in the account's loaded link list.
 */

function characterOption(character) {
  const charId = character?.char_id == null ? '' : String(character.char_id).trim()
  const name = character?.name == null ? '' : String(character.name).trim()
  if (!charId || !name) return null
  return { charId, name }
}

/**
 * Characters the officer may choose. `characters` must already be the
 * account's linked rows. `query` only narrows that list.
 * @param {Array<{ char_id?: string, name?: string }> | null | undefined} characters
 * @param {string} [query]
 * @returns {{ charId: string, name: string }[]}
 */
export function linkedCharacterOptions(characters, query = '') {
  const q = String(query || '').trim().toLowerCase()
  const options = []
  for (const character of characters || []) {
    const option = characterOption(character)
    if (!option) continue
    if (q && !option.name.toLowerCase().includes(q) && !option.charId.toLowerCase().includes(q)) continue
    options.push(option)
  }
  options.sort((a, b) => a.name.localeCompare(b.name) || a.charId.localeCompare(b.charId))
  return options
}

/**
 * Resolve a selected id against the linked list. Throws if the id is missing
 * or belongs to a character that was not passed in.
 * @param {Array<{ char_id?: string, name?: string }> | null | undefined} characters
 * @param {string} charId
 * @returns {{ charId: string, name: string }}
 */
export function selectLinkedCharacter(characters, charId) {
  const id = charId == null ? '' : String(charId).trim()
  if (!id) {
    throw new Error('Select a linked character')
  }
  const match = linkedCharacterOptions(characters, '').find((option) => option.charId === id)
  if (!match) {
    throw new Error('Character is not linked to this account')
  }
  return match
}

/**
 * @param {string | null | undefined} currentDisplayName
 * @param {string | null | undefined} proposedName
 * @returns {{ current: string, proposed: string }}
 */
export function displayNamePreview(currentDisplayName, proposedName) {
  return {
    current: currentDisplayName == null ? '' : String(currentDisplayName).trim(),
    proposed: proposedName == null ? '' : String(proposedName).trim(),
  }
}

/**
 * True when the stored label already matches the selected character name.
 * Callers should not write in that case.
 * @param {string | null | undefined} currentDisplayName
 * @param {string | null | undefined} proposedName
 */
export function isDisplayNameUnchanged(currentDisplayName, proposedName) {
  const preview = displayNamePreview(currentDisplayName, proposedName)
  return preview.current === preview.proposed
}
