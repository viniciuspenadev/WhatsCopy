import { createClient } from '@/lib/supabase/server'

/**
 * Server-side God Mode guard. The AUTHORITATIVE platform-admin check —
 * `is_platform_admin()` (migration 030) backs RLS + UI gating, but every
 * cross-account / platform-owned write goes through a `/api/admin/*` route
 * that calls this first. Reads the signed-in user's `profiles.platform_admin`.
 *
 * Returns `{ userId }` when the caller is a platform admin, otherwise `null`.
 */
export async function requirePlatformAdmin(): Promise<{ userId: string } | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('platform_admin')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!profile || profile.platform_admin !== true) return null
  return { userId: user.id }
}
