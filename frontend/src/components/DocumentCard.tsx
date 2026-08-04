import { NavLink } from "react-router-dom";
import type { DocumentRecord } from "../types";
import { StatusStamp } from "./StatusStamp";

interface Props {
  doc: DocumentRecord;
  onDelete: (id: string) => void;
}

export function DocumentCard({ doc, onDelete }: Props) {
  const pageLabel = doc.pageCount ? `${doc.pageCount} pg` : "—";

  return (
    <NavLink to={`/documents/${doc.id}`} className={({ isActive }) => `doc-card${isActive ? " active" : ""}`}>
      <div className="doc-card-top">
        <span className="doc-card-name" title={doc.filename}>
          {doc.filename}
        </span>
        <button
          type="button"
          className="doc-card-delete"
          aria-label={`Delete ${doc.filename}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (confirm(`Delete "${doc.filename}"? This can't be undone.`)) {
              onDelete(doc.id);
            }
          }}
        >
          remove
        </button>
      </div>
      <div className="doc-card-meta">
        <span>{pageLabel}</span>
        <StatusStamp status={doc.status} />
      </div>
    </NavLink>
  );
}
