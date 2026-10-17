function query(result) {
  const builder = {
    select() { return builder },
    order() { return builder },
    range() { return builder },
    in() { return builder },
    eq() { return builder },
    single() { return builder },
    then(onFulfilled, onRejected) {
      return Promise.resolve(result).then(onFulfilled, onRejected)
    },
  }
  return builder
}

function zoneDelayMs() {
  if (typeof window === 'undefined') return 0
  const raw = new URLSearchParams(window.location.search).get('zoneDelay')
  const delay = Number(raw)
  return Number.isFinite(delay) && delay > 0 ? delay : 0
}

export const supabase = {
  from(table) {
    if (table === 'raid_classifications') {
      const delayed = new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            data: [
              { raid_id: 'r1', mob: 'Split_Anar', zone: 'Plane of Time' },
            ],
          })
        }, zoneDelayMs())
      })
      return query(delayed)
    }
    if (table === 'raids') {
      return query({ data: [{ raid_id: 'r1', raid_name: 'Potime' }] })
    }
    return query({ data: [] })
  },
  auth: {
    getSession() {
      return Promise.resolve({ data: { session: null } })
    },
    onAuthStateChange() {
      return { data: { subscription: { unsubscribe() {} } } }
    },
  },
}
