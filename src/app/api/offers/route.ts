import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/offers — list the account's generated offers (newest first).
 * RLS scopes the rows to the caller's account.
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await supabase
    .from('offers')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)

  return NextResponse.json({ offers: data ?? [] })
}
