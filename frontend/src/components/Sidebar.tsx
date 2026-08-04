import type { DocumentRecord } from "../types";
import { DocumentCard } from "./DocumentCard";
import { UploadDropzone } from "./UploadDropzone";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  documents: DocumentRecord[];
  onUpload: (file: File) => void;
  onDelete: (id: string) => void;
  uploading: boolean;
  uploadError: string | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  userEmail: string;
  onLogout: () => void;
}

export function Sidebar({
  documents,
  onUpload,
  onDelete,
  uploading,
  uploadError,
  theme,
  onToggleTheme,
  userEmail,
  onLogout,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-top">
          <h1 className="sidebar-title">DocuQuery</h1>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
        <p className="sidebar-subtitle">Ask your documents, cited page by page.</p>
      </div>

      <UploadDropzone onUpload={onUpload} uploading={uploading} />
      {uploadError && <p className="upload-error">{uploadError}</p>}

      <ul className="sidebar-list">
        {documents.length === 0 && !uploading && (
          <li style={{ padding: "8px 12px", fontSize: 13, color: "var(--ink-soft)" }}>
            No documents yet. Upload a PDF to begin.
          </li>
        )}
        {documents.map((doc) => (
          <li key={doc.id}>
            <DocumentCard doc={doc} onDelete={onDelete} />
          </li>
        ))}
      </ul>

      <div className="sidebar-footer">
        <span className="sidebar-user-email" title={userEmail}>
          {userEmail}
        </span>
        <button type="button" className="sidebar-logout" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
