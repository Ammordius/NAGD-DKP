/** Per-user last route. The unscoped key is legacy and must not be adopted. */
export const LAST_PATH_PREFIX = 'dkp-last-path:'
export const LEGACY_LAST_PATH_KEY = 'dkp-last-path'

export function persistLastPath(userId, path, storage) {
  if (!userId || !storage) return
  try {
    storage.setItem(`${LAST_PATH_PREFIX}${userId}`, path)
  } catch {
    // ignore quota or private mode
  }
}

/**
 * Return this user's saved path and drop any unscoped leftover.
 * The leftover is not copied onto the signed-in user.
 */
export function consumeLastPath(userId, localStore, sessionStore) {
  let saved = null
  try {
    saved = localStore?.getItem(`${LAST_PATH_PREFIX}${userId}`) ?? null
  } catch {
    saved = null
  }
  try {
    localStore?.removeItem(LEGACY_LAST_PATH_KEY)
  } catch {
    // ignore quota or private mode
  }
  try {
    sessionStore?.removeItem(LEGACY_LAST_PATH_KEY)
  } catch {
    // ignore quota or private mode
  }
  return saved || null
}
