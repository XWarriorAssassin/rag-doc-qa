import { useRef, useState } from "react";

interface Props {
  onUpload: (file: File) => void;
  uploading: boolean;
}

export function UploadDropzone({ onUpload, uploading }: Props) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File | undefined) {
    if (!file) return;
    if (file.type !== "application/pdf") return; // mismatched files are silently ignored here; the real 400 comes from the backend's fileFilter if this check is ever bypassed
    onUpload(file);
  }

  return (
    <label
      className={`upload-zone${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFile(e.dataTransfer.files[0]);
      }}
    >
      {uploading ? "Uploading…" : "Drop a PDF here, or click to browse"}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        disabled={uploading}
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          e.target.value = ""; // allow re-selecting the same file later
        }}
      />
    </label>
  );
}
