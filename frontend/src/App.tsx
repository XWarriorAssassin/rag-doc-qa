import { useEffect, useRef, useState } from "react";
import { Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "./api/client";
import type { ConversationRecord, DocumentRecord } from "./types";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { EmptyState } from "./components/EmptyState";
import { AuthScreen } from "./components/AuthScreen";
import { useAuth } from "./hooks/useAuth";
import { useChatSocket } from "./hooks/useChatSocket";

type Theme = "light" | "dark";
const THEME_STORAGE_KEY = "docuquery-theme";

function getInitialTheme(): Theme {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Top-level auth gate. Split out from the main app shell (AuthedApp below)
 * rather than branching inside one component, so the chat socket and the
 * document/conversation-loading effects only ever mount once there's a
 * valid session to use them with — an anonymous visitor never opens a
 * WebSocket or calls a 401-guaranteed endpoint just to have it rejected.
 */
export default function App() {
  const auth = useAuth();

  if (auth.status === "checking") {
    // Deliberately blank rather than a spinner: this resolves in one fetch
    // round trip (GET /api/auth/me), almost always faster than a spinner
    // would even finish fading in — a skeleton here would flicker more
    // than it would reassure.
    return <div className="app-shell" />;
  }

  if (auth.status === "anonymous" || !auth.user) {
    return <AuthScreen auth={auth} />;
  }

  return <AuthedApp userEmail={auth.user.email} onLogout={() => void auth.logout()} />;
}

function AuthedApp({ userEmail, onLogout }: { userEmail: string; onLogout: () => void }) {
  const socket = useChatSocket();
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [documentsLoaded, setDocumentsLoaded] = useState(false);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  const navigate = useNavigate();
  const location = useLocation();
  const documentsRef = useRef(documents);
  documentsRef.current = documents;

  // The attribute (not a class) is what index.css's :root[data-theme="dark"]
  // block targets, and persisting to localStorage means the choice survives
  // a refresh rather than falling back to system preference every load.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  async function refreshDocuments() {
    const rows = await api.listDocuments();
    setDocuments(rows);
  }

  useEffect(() => {
    (async () => {
      try {
        const [docs, convs] = await Promise.all([api.listDocuments(), api.listConversations()]);
        setDocuments(docs);
        setConversations(convs);
      } finally {
        setDocumentsLoaded(true);
      }
    })();
  }, []);

  // Poll while anything is still processing. A document typically clears
  // "pending"/"processing" within well under a minute for the PDF sizes
  // this project targets, so a plain 3s poll is simpler than wiring up
  // SSE/websockets for a state transition that happens once per document
  // and only briefly — that machinery earns its cost once uploads or
  // per-document processing time get large enough that polling itself
  // becomes a meaningful load, which isn't this project's scale.
  useEffect(() => {
    const interval = setInterval(() => {
      const hasPending = documentsRef.current.some((d) => d.status === "pending" || d.status === "processing");
      if (hasPending) void refreshDocuments();
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const created = await api.uploadDocument(file);
      setDocuments((prev) => [...prev, created]);
      navigate(`/documents/${created.id}`);
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteDocument(id);
      setDocuments((prev) => prev.filter((d) => d.id !== id));
      setConversations((prev) => prev.filter((c) => c.documentId !== id));
      if (location.pathname === `/documents/${id}`) navigate("/");
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Delete failed");
    }
  }

  function handleConversationCreated(conv: ConversationRecord) {
    setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [...prev, conv]));
  }

  return (
    <div className="app-shell">
      <Sidebar
        documents={documents}
        onUpload={handleUpload}
        onDelete={handleDelete}
        uploading={uploading}
        uploadError={uploadError}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        userEmail={userEmail}
        onLogout={onLogout}
      />
      <Routes>
        <Route path="/" element={<EmptyState />} />
        <Route
          path="/documents/:id"
          element={
            <DocumentRoute
              documents={documents}
              documentsLoaded={documentsLoaded}
              conversations={conversations}
              onConversationCreated={handleConversationCreated}
              socket={socket}
            />
          }
        />
      </Routes>
    </div>
  );
}

function DocumentRoute({
  documents,
  documentsLoaded,
  conversations,
  onConversationCreated,
  socket,
}: {
  documents: DocumentRecord[];
  documentsLoaded: boolean;
  conversations: ConversationRecord[];
  onConversationCreated: (conv: ConversationRecord) => void;
  socket: ReturnType<typeof useChatSocket>;
}) {
  const { id } = useParams<{ id: string }>();
  const doc = documents.find((d) => d.id === id);

  if (!doc) {
    return (
      <div className="empty-state">
        <div className="empty-state-inner">
          <h3>{documentsLoaded ? "Document not found" : "Loading…"}</h3>
          {documentsLoaded && <p>This document may have been deleted.</p>}
        </div>
      </div>
    );
  }

  const conversation = conversations.find((c) => c.documentId === doc.id);
  return (
    <ChatPanel
      doc={doc}
      conversation={conversation}
      onConversationCreated={onConversationCreated}
      socket={socket}
    />
  );
}
