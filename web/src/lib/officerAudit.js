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
    const { error } = await supabase.rpc('log_officer_audit', {
      p_action: action,
      p_target_type: target_type,
      p_target_id: target_id ?? null,
      p_delta: delta && Object.keys(delta).length > 0 ? delta : null,
    })
    if (error) console.warn('Officer audit log failed:', error.message)
  } catch (err) {
    console.warn('Officer audit log failed:', err)
  }
}
