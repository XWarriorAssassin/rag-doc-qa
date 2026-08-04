/**
 * Retrieval-accuracy eval harness. Run against a live backend (local via
 * docker-compose, or the deployed Render instance) with a real
 * OPENROUTER_API_KEY configured server-side — this makes real embedding and
 * chat completion calls, so it costs a little OpenRouter quota each run.
 *
 * Usage:
 *   cd eval && npm install && npm run eval
 *   (EVAL_API_BASE defaults to http://localhost:4000; override for a
 *   deployed backend, e.g. EVAL_API_BASE=https://your-app.onrender.com)
 *
 * What this measures, and what it deliberately doesn't:
 *  - Answerability accuracy: for the 12 questions the fixture PDF actually
 *    answers, did the system attempt an answer (not the fallback message)?
 *    For the 3 it doesn't, did the system correctly say so instead of
 *    hallucinating?
 *  - Citation-page accuracy: for answerable questions, does at least one
 *    cited chunk's page number match the question's known ground-truth
 *    page? This is a retrieval-quality signal, not answer-correctness — a
 *    right-page-wrong-answer case would still score as a retrieval hit
 *    here. Grading actual answer *content* against ground truth would need
 *    either human review or a second LLM-as-judge call, both out of scope
 *    for a lightweight eval script; see README's eval section for why this
 *    tradeoff is reasonable at this project's scale.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.EVAL_API_BASE ?? "http://localhost:4000";
const FIXTURE_PDF = path.join(__dirname, "fixtures", "aurora-bikes-handbook.pdf");
const QUESTIONS_PATH = path.join(__dirname, "fixtures", "questions.json");
// Randomized per run (not a fixed constant) so re-running the eval doesn't
// collide with "account already exists" from a previous run against the
// same backend.
const EVAL_EMAIL = `eval-${Date.now()}@example.com`;
const EVAL_PASSWORD = "eval-harness-password-not-real";

interface Question {
  id: string;
  question: string;
  expectedAnswerable: boolean;
  expectedPages: number[];
}

interface Citation {
  marker: number;
  chunkId: string;
  pageNumber: number;
  excerpt: string;
}

interface AskResponse {
  message: { content: string };
  isAnswerable: boolean;
  retrievedChunkCount: number;
  usedChunkCount: number;
  citations: Citation[];
}

// fetch() doesn't persist cookies across calls the way a browser does — the
// login/signup response's Set-Cookie has to be captured and re-sent
// manually on every subsequent request. This one-line helper (rather than
// a cookie-jar library) is all that's needed for a single-session script
// like this.
let sessionCookie = "";

/**
 * The ask-question endpoint enforces a per-user rate limit (see backend
 * src/lib/rateLimiter.ts) — by design, since it guards real LLM spend. This
 * eval script asks 15 questions back-to-back, which can outrun that limit
 * well before OpenRouter itself would ever be a concern. Rather than fail
 * the whole run, back off and retry on 429 using the server's own
 * Retry-After header, up to a few attempts.
 */
async function api(pathname: string, init: RequestInit = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_BASE}${pathname}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
    });

    const setCookie = res.headers.get("set-cookie");
    if (setCookie) sessionCookie = setCookie.split(";")[0] ?? "";

    if (res.status === 429 && attempt < 5) {
      const retryAfterSec = Number(res.headers.get("retry-after") ?? "5");
      console.log(`  (rate limited, waiting ${retryAfterSec}s before retrying...)`);
      await new Promise((r) => setTimeout(r, (retryAfterSec + 1) * 1000));
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${init.method ?? "GET"} ${pathname} -> ${res.status}: ${body}`);
    }
    return res;
  }
}

async function signup() {
  await api("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EVAL_EMAIL, password: EVAL_PASSWORD }),
  });
}

async function uploadFixture(): Promise<string> {
  const bytes = await readFile(FIXTURE_PDF);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/pdf" }), "aurora-bikes-handbook.pdf");

  const res = await api("/api/documents/upload", { method: "POST", body: form });
  const doc = (await res.json()) as { id: string };
  return doc.id;
}

/** Polls until the async extract-chunk-embed pipeline (Phase 2) finishes. */
async function waitUntilReady(documentId: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api(`/api/documents/${documentId}`);
    const doc = (await res.json()) as { status: string; errorMessage?: string };
    if (doc.status === "ready") return;
    if (doc.status === "failed") throw new Error(`Document processing failed: ${doc.errorMessage}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Timed out waiting for document to become ready");
}

async function createConversation(documentId: string): Promise<string> {
  const res = await api("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId }),
  });
  const conv = (await res.json()) as { id: string };
  return conv.id;
}

async function ask(conversationId: string, question: string): Promise<AskResponse> {
  const res = await api(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  return (await res.json()) as AskResponse;
}

interface EvalRow {
  id: string;
  question: string;
  expectedAnswerable: boolean;
  actualAnswerable: boolean;
  answerabilityCorrect: boolean;
  expectedPages: number[];
  citedPages: number[];
  pageMatch: boolean | null; // null = not applicable (question was correctly unanswerable)
}

async function main() {
  const questions: Question[] = JSON.parse(await readFile(QUESTIONS_PATH, "utf-8"));

  console.log(`Signing up eval user ${EVAL_EMAIL}...`);
  await signup();

  console.log("Uploading fixture PDF...");
  const documentId = await uploadFixture();

  console.log("Waiting for processing (extract -> chunk -> embed)...");
  await waitUntilReady(documentId);

  console.log("Starting conversation...");
  const conversationId = await createConversation(documentId);

  const rows: EvalRow[] = [];
  for (const q of questions) {
    process.stdout.write(`  ${q.id}: ${q.question}\n`);
    const result = await ask(conversationId, q.question);
    const citedPages = [...new Set(result.citations.map((c) => c.pageNumber))].sort((a, b) => a - b);

    const answerabilityCorrect = result.isAnswerable === q.expectedAnswerable;
    const pageMatch = q.expectedAnswerable
      ? q.expectedPages.some((p) => citedPages.includes(p))
      : null;

    rows.push({
      id: q.id,
      question: q.question,
      expectedAnswerable: q.expectedAnswerable,
      actualAnswerable: result.isAnswerable,
      answerabilityCorrect,
      expectedPages: q.expectedPages,
      citedPages,
      pageMatch,
    });
  }

  const answerabilityAccuracy = rows.filter((r) => r.answerabilityCorrect).length / rows.length;
  const answerableRows = rows.filter((r) => r.expectedAnswerable);
  const pageAccuracy = answerableRows.filter((r) => r.pageMatch).length / answerableRows.length;

  const lines: string[] = [];
  lines.push(`# Eval results`);
  lines.push("");
  lines.push(`Run at: ${new Date().toISOString()}`);
  lines.push(`Backend: ${API_BASE}`);
  lines.push("");
  lines.push(`**Answerability accuracy: ${(answerabilityAccuracy * 100).toFixed(0)}% (${rows.filter((r) => r.answerabilityCorrect).length}/${rows.length})**`);
  lines.push(`**Citation page accuracy (answerable questions only): ${(pageAccuracy * 100).toFixed(0)}% (${answerableRows.filter((r) => r.pageMatch).length}/${answerableRows.length})**`);
  lines.push("");
  lines.push("| ID | Question | Expected answerable | Got answerable | Expected page(s) | Cited page(s) | Page match |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.question} | ${r.expectedAnswerable} | ${r.actualAnswerable} | ${r.expectedPages.join(", ") || "—"} | ${r.citedPages.join(", ") || "—"} | ${r.pageMatch === null ? "n/a" : r.pageMatch} |`
    );
  }

  const report = lines.join("\n");
  console.log("\n" + report);

  const outPath = path.join(__dirname, "results.md");
  await import("node:fs/promises").then((fs) => fs.writeFile(outPath, report));
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => {
  console.error("Eval run failed:", err);
  process.exit(1);
});
