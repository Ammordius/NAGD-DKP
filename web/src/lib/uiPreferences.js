export const UI_PREFERENCE_DEFAULTS = {
  showTicCharacterPicker: true,
  useCharacterAdminSelectors: true,
  // true (default, including a missing key): any raid name, date is today.
  // false: Raid Admin requires a Discord raid_schedule line.
  // The profile checkbox is the inverse of this stored value.
  raidNameOnly: true,
}

const PREFERENCE_KEYS = Object.keys(UI_PREFERENCE_DEFAULTS)

export function normalizeUiPreferences(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const key of PREFERENCE_KEYS) {
    out[key] = typeof src[key] === 'boolean' ? src[key] : true
  }
  return out
}

/** Profile checkbox "Require Discord raid_schedule raid names".
 *  Ticked when stored raidNameOnly is false. Default (missing or true) is unticked. */
export function discordRaidNameRequired(raw) {
  return !normalizeUiPreferences(raw).raidNameOnly
}

export function ticDraftStorageKey(raidId) {
  return `pageState:/officer/RaidAdmin:ticDraft:${raidId}`
}

export function emptyTicDraft() {
  return {
    ticPaste: '',
    ticResolutions: {},
    ticExcludedCharIds: [],
    ticAttendingIds: [],
    ticDestination: 'new',
    ticDkpValue: '1',
    ticDate: '',
    ticTime: '',
    ticDateTimeTouched: false,
  }
}

export function sanitizeTicDraft(raw) {
  const base = emptyTicDraft()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const resolutions = raw.ticResolutions
  return {
    ticPaste: typeof raw.ticPaste === 'string' ? raw.ticPaste : base.ticPaste,
    ticResolutions: resolutions && typeof resolutions === 'object' && !Array.isArray(resolutions)
      ? resolutions
      : base.ticResolutions,
    ticExcludedCharIds: Array.isArray(raw.ticExcludedCharIds) ? raw.ticExcludedCharIds.map(String) : [],
    ticAttendingIds: Array.isArray(raw.ticAttendingIds) ? raw.ticAttendingIds.map(String) : [],
    ticDestination: raw.ticDestination === 'existing' ? 'existing' : 'new',
    ticDkpValue: raw.ticDkpValue != null && raw.ticDkpValue !== '' ? String(raw.ticDkpValue) : base.ticDkpValue,
    ticDate: typeof raw.ticDate === 'string' ? raw.ticDate : '',
    ticTime: typeof raw.ticTime === 'string' ? raw.ticTime : '',
    ticDateTimeTouched: raw.ticDateTimeTouched === true,
  }
}

export function readTicDraft(storage, raidId) {
  if (!raidId || !storage) return null
  try {
    const raw = storage.getItem(ticDraftStorageKey(raidId))
    if (raw == null) return null
    return sanitizeTicDraft(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeTicDraft(storage, raidId, draft) {
  if (!raidId || !storage) return
  try {
    storage.setItem(ticDraftStorageKey(raidId), JSON.stringify(sanitizeTicDraft(draft)))
  } catch {
    // Private mode or a full session store should not block the form.
  }
}
