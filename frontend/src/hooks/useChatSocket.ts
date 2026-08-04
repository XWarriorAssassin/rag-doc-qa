import { useCallback, useEffect, useRef, useState } from "react";
import { wsBaseUrl } from "../api/client";
import type { WsServerEvent } from "../types";

export type SocketStatus = "connecting" | "open" | "closed";

interface AskCallbacks {
  onToken: (text: string) => void;
  onDone: (event: Extract<WsServerEvent, { type: "done" }>) => void;
  onError: (message: string) => void;
}

/**
 * One WebSocket connection per mounted app (not per conversation) — the
 * server doesn't scope a connection to a single conversationId (see
 * socketServer.ts), so a single long-lived socket can carry questions for
 * whichever document/conversation the user is currently viewing without
 * reconnecting on every navigation.
 *
 * Reconnection: on an unexpected close, retry once after a short delay
 * rather than looping forever — if auth itself is the problem (expired
 * cookie), the retry will also get rejected at the upgrade handshake and
 * this just settles into "closed", which the UI surfaces as "reconnecting
 * failed, refresh the page" rather than a silent infinite retry loop
 * hammering the server.
 */
export function useChatSocket() {
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const callbacksRef = useRef<Map<string, AskCallbacks>>(new Map());
  const retriedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      const ws = new WebSocket(`${wsBaseUrl()}/ws`);
      wsRef.current = ws;
      setStatus("connecting");

      ws.onopen = () => {
        if (cancelled) return;
        retriedRef.current = false;
        setStatus("open");
      };

      ws.onclose = () => {
        if (cancelled) return;
        setStatus("closed");
        // One retry, after a short delay — covers a transient drop (e.g.
        // Render free-tier cold start) without retrying indefinitely
        // against a hard auth failure.
        if (!retriedRef.current) {
          retriedRef.current = true;
          setTimeout(() => {
            if (!cancelled) connect();
          }, 1500);
        }
      };

      ws.onerror = () => {
        // No separate handling needed: a WS 'error' event is always
        // followed by a 'close' event, which already drives status/retry
        // above. Left here only so an unhandled-error console warning
        // doesn't show up in dev tools for something we do handle.
      };

      ws.onmessage = (event) => {
        let parsed: WsServerEvent;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }

        // conversationId is present on 'token'/'done' and optional on
        // 'error' (a malformed-message error from the server has no
        // conversation to attach to) — route by it when present, otherwise
        // broadcast to every listener so a connection-level error still
        // surfaces somewhere instead of being silently dropped.
        const targets =
          "conversationId" in parsed && parsed.conversationId
            ? [callbacksRef.current.get(parsed.conversationId)].filter((c): c is AskCallbacks => !!c)
            : [...callbacksRef.current.values()];

        for (const cb of targets) {
          if (parsed.type === "token") cb.onToken(parsed.text);
          else if (parsed.type === "done") cb.onDone(parsed);
          else if (parsed.type === "error") cb.onError(parsed.error);
        }
      };
    }

    connect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, []);

  /**
   * Registers callbacks for one in-flight question on one conversation and
   * sends the 'ask' message. Only one in-flight question per conversation
   * is supported (the send button in ChatPanel is disabled while sending,
   * which is what actually enforces this) — a second concurrent `ask` for
   * the same conversationId would just overwrite the first's callbacks.
   */
  const ask = useCallback((conversationId: string, question: string, callbacks: AskCallbacks) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      callbacks.onError("Not connected. Please wait a moment and try again.");
      return;
    }

    callbacksRef.current.set(conversationId, callbacks);
    ws.send(JSON.stringify({ type: "ask", conversationId, question }));
  }, []);

  const release = useCallback((conversationId: string) => {
    callbacksRef.current.delete(conversationId);
  }, []);

  return { status, ask, release };
}
