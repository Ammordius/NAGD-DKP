/**
 * Officer audit logging: who, what, when for sensitive actions.
 * Writes minimal rows (small delta only) to control DB size and egress.
 * Only call from officer context; RLS restricts insert to officers.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ action: string, target_type: string, target_id?: string | null, delta?: object | null }} payload
 */
export async function logOfficerAudit(supabase, { action, target_type, target_id = null, delta = null }) {
  try {
    const { data: { user } } = await supabase.auth.getUser()
    const actor_id = user?.id ?? null
    const actor_email = (user?.email ?? '').trim() || null
    let actor_display_name = null
    if (actor_id) {
      const { data: profile } = await supabase.from('profiles').select('account_id').eq('id', actor_id).single()
      if (profile?.account_id) {
        const { data: account } = await supabase.from('accounts').select('display_name').eq('account_id', profile.account_id).single()
        const name = (account?.display_name ?? '').trim()
        if (name) actor_display_name = name
      }
    }
    const row = {
      action,
      target_type,
      target_id: target_id ?? null,
      delta: delta && Object.keys(delta).length > 0 ? delta : null,
      actor_id,
      actor_email,
      actor_display_name,
    }
    await supabase.from('officer_audit_log').insert(row)
  } catch (err) {
    console.warn('Officer audit log failed:', err)
  }
}
