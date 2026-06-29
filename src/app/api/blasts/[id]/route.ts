import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { tickBlasts } from '@/lib/blasts/runner'

/**
 * GET /api/blasts/[id] — campaign + per-group targets (for the detail view).
 * RLS scopes everything to the caller's account.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: blast } = await supabase.from('group_blasts').select('*').eq('id', id).maybeSingle()
  if (!blast) return NextResponse.json({ error: 'Campanha não encontrada' }, { status: 404 })

  const { data: targets } = await supabase
    .from('group_blast_targets')
    .select('id, group_jid, conversation_id, status, error, sent_at, conversation:conversations(group_name)')
    .eq('blast_id', id)
    .order('created_at', { ascending: true })

  return NextResponse.json({ blast, targets: targets ?? [] })
}

/**
 * POST /api/blasts/[id] — campaign actions.
 * Body: { action: 'cancel' | 'pause' | 'resume' | 'retry' }
 * (Duplicate is handled client-side by reopening the create modal prefilled.)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { action } = (await req.json().catch(() => ({}))) as { action?: string }

  switch (action) {
    case 'cancel': {
      await supabase
        .from('group_blasts')
        .update({ status: 'canceled', finished_at: new Date().toISOString() })
        .eq('id', id)
        .in('status', ['scheduled', 'sending', 'paused'])
      break
    }
    case 'pause': {
      await supabase.from('group_blasts').update({ status: 'paused' }).eq('id', id).eq('status', 'sending')
      break
    }
    case 'resume': {
      await supabase.from('group_blasts').update({ status: 'sending' }).eq('id', id).eq('status', 'paused')
      after(() => tickBlasts())
      break
    }
    case 'retry': {
      // Re-queue only the failed groups.
      await supabase
        .from('group_blast_targets')
        .update({ status: 'pending', error: null, next_attempt_at: null })
        .eq('blast_id', id)
        .eq('status', 'failed')
      await supabase
        .from('group_blasts')
        .update({ status: 'sending', failed_count: 0, finished_at: null })
        .eq('id', id)
      after(() => tickBlasts())
      break
    }
    default:
      return NextResponse.json({ error: 'Ação inválida' }, { status: 400 })
  }

  const { data: blast } = await supabase.from('group_blasts').select('*').eq('id', id).maybeSingle()
  return NextResponse.json({ ok: true, blast })
}
