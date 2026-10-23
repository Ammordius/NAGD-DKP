export const ACCOUNT_DETAIL_CACHE_PREFIX = 'account-detail-cache'
export const ACCOUNT_DETAIL_SWR_PREFIX = 'account-detail'

/** True when either Account History missing-tic control needs the raid universe. */
export function needsMissingRaidUniverse(showMissingDetails, onlyMissingRaids) {
  return Boolean(showMissingDetails || onlyMissingRaids)
}

export function accountDetailSessionKey(accountId, includeMissing) {
  if (!accountId) return null
  return `${ACCOUNT_DETAIL_CACHE_PREFIX}-${accountId}${includeMissing ? ':missing' : ''}`
}

export function accountDetailSwrKey(accountId, includeMissing) {
  if (!accountId) return null
  return `${ACCOUNT_DETAIL_SWR_PREFIX}-${accountId}${includeMissing ? ':missing' : ''}`
}

/**
 * All four UI control combinations for missing-tic fetch scope.
 * @returns {Array<{ showMissingDetails: boolean, onlyMissingRaids: boolean, includeMissing: boolean, sessionKey: string, swrKey: string }>}
 */
export function missingTicControlMatrix(accountId = 'acct-demo') {
  const combos = [
    { showMissingDetails: false, onlyMissingRaids: false },
    { showMissingDetails: true, onlyMissingRaids: false },
    { showMissingDetails: false, onlyMissingRaids: true },
    { showMissingDetails: true, onlyMissingRaids: true },
  ]
  return combos.map((c) => {
    const includeMissing = needsMissingRaidUniverse(c.showMissingDetails, c.onlyMissingRaids)
    return {
      ...c,
      includeMissing,
      sessionKey: accountDetailSessionKey(accountId, includeMissing),
      swrKey: accountDetailSwrKey(accountId, includeMissing),
    }
  })
}
