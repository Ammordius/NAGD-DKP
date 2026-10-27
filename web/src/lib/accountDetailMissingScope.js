export const ACCOUNT_DETAIL_CACHE_PREFIX = 'account-detail-cache'
export const ACCOUNT_DETAIL_SWR_PREFIX = 'account-detail'
export const CHAR_TO_ACCOUNT_SWR_KEY = 'char-to-account-map'

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

export function myAccountActivitySwrKey(accountId) {
  if (!accountId) return null
  return `my-account-activity-${accountId}`
}

/**
 * Clear both missing-scope session blobs and revalidate related SWR keys after
 * character link / claim changes that affect account activity.
 * @param {string} accountId
 * @param {(key: string) => unknown} [globalMutate] useSWRConfig().mutate
 */
export function invalidateAccountActivityCaches(accountId, globalMutate) {
  if (!accountId) return
  for (const includeMissing of [false, true]) {
    const sessionKey = accountDetailSessionKey(accountId, includeMissing)
    if (sessionKey) {
      try { sessionStorage.removeItem(sessionKey) } catch (_) { /* ignore */ }
    }
    if (typeof globalMutate === 'function') {
      const swrKey = accountDetailSwrKey(accountId, includeMissing)
      if (swrKey) globalMutate(swrKey)
    }
  }
  if (typeof globalMutate === 'function') {
    const myKey = myAccountActivitySwrKey(accountId)
    if (myKey) globalMutate(myKey)
    globalMutate(CHAR_TO_ACCOUNT_SWR_KEY)
  }
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
