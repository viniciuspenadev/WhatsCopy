import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * PATCH /api/offers/[id] — save the user's edited copy.
 * Body: { edited_copy: string }. RLS enforces account ownership (agent+).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const { edited_copy } = body as { edited_copy?: string }
  if (typeof edited_copy !== 'string') {
    return NextResponse.json({ error: 'edited_copy é obrigatório.' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('offers')
    .update({ edited_copy })
    .eq('id', id)
    .select('id')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Oferta não encontrada.' }, { status: 404 })

  return NextResponse.json({ ok: true })
}
