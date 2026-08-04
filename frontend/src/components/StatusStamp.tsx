import type { DocumentStatus } from "../types";

const LABEL: Record<DocumentStatus, string> = {
  pending: "queued",
  processing: "reading…",
  ready: "ready",
  failed: "failed",
};

export function StatusStamp({ status }: { status: DocumentStatus }) {
  return (
    <span className="status-stamp" data-status={status}>
      {LABEL[status]}
    </span>
  );
}
