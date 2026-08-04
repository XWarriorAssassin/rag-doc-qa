import type { AskResponse, ConversationRecord, DocumentRecord, MessageRecord, UserRecord } from "../types";

// Empty string -> requests hit same-origin "/api/...", which vite.config.ts
// proxies to the local backend in dev. In production (Vercel) VITE_API_URL
// points at the deployed Render URL, a genuinely different origin.
const API_BASE = import.meta.env.VITE_API_URL ?? "";

// Same origin resolution as API_BASE, but converted to a ws(s):// URL for
// the streaming chat socket (see hooks/useChatSocket.ts). Derived from
// API_BASE rather than a second env var, so there's exactly one place
// (VITE_API_URL) to configure when pointing the frontend at a different
// backend — a second, independently-set WS URL would be one more thing to
// forget to update together.
export function wsBaseUrl(): string {
  if (API_BASE) {
    return API_BASE.replace(/^http/, "ws");
  }
  // Empty API_BASE means "same origin as the page" for fetch(), but a
  // WebSocket URL can't be relative — build it explicitly from
  // window.location, using wss:// whenever the page itself is https:.
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    // fetch() does NOT send cookies cross-origin by default, even same-site
    // ones — "include" is required for the Vercel frontend to send the
    // httpOnly auth cookie to the Render backend. Harmless same-origin too
    // (local dev via the Vite proxy), so it's just always on.
    credentials: "include",
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    // The backend always returns { error: string } on failure (see app.ts's
    // error handler and every route's early-return branches) — surfacing
    // that string directly means UI error states never say generic things
    // like "Request failed" when the server already explained what's wrong.
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // Non-JSON error body (e.g. a proxy/timeout page) — fall back to the
      // generic message above rather than crashing on the .json() call.
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  signup: (email: string, password: string) =>
    request<UserRecord>("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }),

  login: (email: string, password: string) =>
    request<UserRecord>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),

  logout: () => request<void>("/api/auth/logout", { method: "POST" }),

  // Used on app load to check for an existing valid session cookie. Callers
  // treat a 401 ApiError as "not logged in", not as an unexpected failure —
  // see hooks/useAuth.ts.
  me: () => request<UserRecord>("/api/auth/me"),

  listDocuments: () => request<DocumentRecord[]>("/api/documents"),

  getDocument: (id: string) => request<DocumentRecord>(`/api/documents/${id}`),

  uploadDocument: (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return request<DocumentRecord>("/api/documents/upload", { method: "POST", body: formData });
  },

  deleteDocument: (id: string) => request<void>(`/api/documents/${id}`, { method: "DELETE" }),

  listConversations: () => request<ConversationRecord[]>("/api/conversations"),

  createConversation: (documentId: string) =>
    request<ConversationRecord>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ documentId }),
    }),

  listMessages: (conversationId: string) =>
    request<MessageRecord[]>(`/api/conversations/${conversationId}/messages`),

  sendMessage: (conversationId: string, question: string) =>
    request<AskResponse>(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ question }),
    }),
};
