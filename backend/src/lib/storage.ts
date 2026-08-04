import path from "node:path";
import fs from "node:fs";

// Local disk for now — the schema's `storage_path` column is provider-
// agnostic (just a string), so swapping to S3/R2 in Phase 6 means changing
// this file's write/delete logic and storing an object key instead of a
// filesystem path. No schema or route changes needed.
export const STORAGE_ROOT = path.resolve(process.cwd(), "storage");

fs.mkdirSync(STORAGE_ROOT, { recursive: true });

export function storagePathFor(userId: string, documentId: string, originalFilename: string): string {
  // Namespaced by user so two users' files can never collide on disk, even
  // though ownership is really enforced at the DB/query layer, not the
  // filesystem layer. Extension preserved for debugging convenience only —
  // it plays no role in how the file is read back (we always read it as PDF
  // bytes based on the DB row, not the path).
  const ext = path.extname(originalFilename) || ".pdf";
  return path.join(STORAGE_ROOT, userId, `${documentId}${ext}`);
}
