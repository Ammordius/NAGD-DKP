/**
 * Vite inlines every VITE_ variable that client code can read. A service-role
 * key under that prefix would ship in the browser bundle.
 */
export function clientServiceRoleError(env) {
  const value = env?.VITE_SUPABASE_SERVICE_ROLE_KEY
  if (typeof value === 'string' && value.trim()) {
    return 'VITE_SUPABASE_SERVICE_ROLE_KEY must not be set. Use SUPABASE_SERVICE_ROLE_KEY so the service role is not shipped to the browser.'
  }
  return ''
}
