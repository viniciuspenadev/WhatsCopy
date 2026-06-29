"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/** Compare two WhatsApp JIDs by their local part (digits / group id). */
function sameJid(a: string, b: string): boolean {
  const local = (j: string) => j.split("@")[0].replace(/[^a-zA-Z0-9]/g, "");
  return local(a) === local(b);
}

/**
 * Whether the contact in the active chat is currently typing/recording.
 *
 * The Evolution webhook broadcasts ephemeral presence on `presence:<accountId>`
 * (no DB write). We listen and reflect it for the open conversation, with an
 * auto-clear timeout in case the "stopped typing" event never arrives.
 */
export function useTypingPresence(
  accountId: string | null | undefined,
  activeChatJid: string | null,
): boolean {
  const [typing, setTyping] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Reset when the chat changes — typing state never carries across chats.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTyping(false);
    if (!accountId) return;

    const supabase = createClient();
    const channel = supabase
      .channel(`presence:${accountId}`)
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        const p = payload as { chatJid?: string; typing?: boolean };
        if (!activeChatJid || !p?.chatJid || !sameJid(p.chatJid, activeChatJid)) return;
        if (p.typing) {
          setTyping(true);
          if (timerRef.current) clearTimeout(timerRef.current);
          // Auto-clear so a missed "paused" event doesn't pin it forever.
          timerRef.current = setTimeout(() => setTyping(false), 8000);
        } else {
          if (timerRef.current) clearTimeout(timerRef.current);
          setTyping(false);
        }
      })
      .subscribe();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      supabase.removeChannel(channel);
    };
  }, [accountId, activeChatJid]);

  return typing;
}
