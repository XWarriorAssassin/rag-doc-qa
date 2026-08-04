# DocuQuery — RAG Document Q&A

Upload a PDF, ask questions about it in plain English, get answers grounded
strictly in that document's content — with inline citations back to the
exact page they came from, and an honest "not in this document" instead of
a hallucinated guess when the answer isn't there.

Built as a portfolio project targeting product-based company placements.
Full-stack: React/TypeScript frontend, Node/Express backend, Postgres +
pgvector for both relational data and embeddings, JWT auth over httpOnly
cookies, and a WebSocket-streamed chat interface.

## Table of contents

- [Architecture](#architecture)
- [Why these tech choices](#why-these-tech-choices)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Testing strategy](#testing-strategy)
- [Evaluation](#evaluation)
- [Security notes](#security-notes)
- [What I'd do differently at scale](#what-id-do-differently-at-scale)
- [Project structure](#project-structure)

## Architecture

```mermaid
flowchart TD
    subgraph Client["Browser"]
        UI[React + TypeScript SPA]
    end

    subgraph Backend["Express Backend (Render)"]
        REST["REST API<br/>/api/auth, /api/documents, /api/conversations"]
        WS["WebSocket server<br/>/ws — streaming answers"]
        Pipeline["Ingestion pipeline<br/>extract → chunk → embed"]
        RAG["RAG layer<br/>retrieve → prompt → generate"]
    end

    subgraph External["OpenRouter"]
        Embed["Embedding model<br/>nvidia/nemotron-3-embed-1b (2048-dim)"]
        Chat["Chat model<br/>free-tier, configurable via CHAT_MODEL"]
    end

    subgraph DB["Postgres + pgvector (Neon)"]
        Users[(users)]
        Docs[(documents)]
        Chunks[(chunks<br/>embedding vector(2048))]
        Convos[(conversations)]
        Msgs[(messages)]
        RateLimit[(rate_limit_windows)]
    end

    UI -- "fetch, credentials: include" --> REST
    UI -- "WebSocket, cookie auth" --> WS
    REST -- "upload" --> Pipeline
    Pipeline -- "embed chunks" --> Embed
    Pipeline --> Chunks
    REST -- "ask (non-streaming)" --> RAG
    WS -- "ask (streaming)" --> RAG
    RAG -- "embed question" --> Embed
    RAG -- "hybrid search: cosine <=> AND full-text" --> Chunks
    RAG -- "generate" --> Chat
    REST --> Users
    REST --> Docs
    REST --> Convos
    REST --> Msgs
    REST -.->|"rate limit check"| RateLimit
    WS -.->|"rate limit check"| RateLimit
```

**Request flow, end to end:**

1. **Upload** — PDF lands in per-user storage, a `documents` row is created
   with `status: pending`, and the response returns immediately. Extraction/
   chunking/embedding happens asynchronously (see `backend/src/pipeline/`);
   the frontend polls document status until it flips to `ready`.
2. **Ask** — the question is embedded, then matched against the document's
   chunks via **hybrid search**: cosine distance (`<=>`, pgvector) *and* a
   Postgres full-text match, fused by reciprocal rank. A chunk counts as
   relevant if either leg vouches for it. If nothing clears the bar, the
   LLM is never called — the fallback message is returned directly.
3. **Generate** — relevant chunks are numbered and inserted into a system
   prompt instructing the model to answer *only* from the given excerpts,
   cite every fact with a `[n]` marker, and emit an exact sentinel token
   (`NOT_FOUND_IN_DOCUMENT`) if the excerpts don't actually answer the
   question. The REST path calls this non-streaming; the WebSocket path
   streams tokens live and resolves citations once the full completion
   lands (citation markers can't be resolved mid-token — a `[1]` can arrive
   split across two stream chunks).
4. **Persist** — both the question and answer are stored in `messages`,
   with `cited_chunk_ids` for citation replay on conversation reload.

## Why these tech choices

### Postgres + pgvector instead of a dedicated vector DB

The brief specifically asked for this tradeoff to be justified, so:

**Why this is the right call here:** one database instead of two, one
connection pool, one set of migrations, one backup/restore story, one place
transactions can span (e.g. a document row and its chunks committing
together). At this project's scale — a portfolio app with per-user document
counts in the tens to low hundreds, not a multi-tenant SaaS serving
millions of vectors — pgvector's brute-force/IVFFlat/HNSW search is
comfortably fast enough, and the operational simplicity of "one Postgres
instance" is worth far more than a dedicated vector DB's extra query
throughput at this scale.

**Where a dedicated vector DB (Pinecone, Qdrant, Weaviate) wins instead:**
horizontal scaling of vector search independent of the relational
workload, more advanced ANN index tuning options, and native multi-vector/
hybrid-search features that Postgres's full-text search + pgvector
combination approximates but doesn't natively unify. If document/user
counts grew by 100–1000x, or if vector search latency became the
bottleneck under real concurrent load, that's the point to reconsider —
and it's a swap, not a rewrite, since the retrieval layer (`retrieveChunks.ts`)
is already isolated behind a single function.

**A concrete gap today:** there's currently no HNSW/IVFFlat index on
`chunks.embedding` — the migrations create the column, but not an ANN
index — so vector search is an exact sequential scan. That's genuinely
fine at this project's chunk-count scale (and arguably *more* accurate
than an approximate index at this size), but it's the first thing to add
before pgvector's simplicity story would start to break down at larger
scale.

### OpenRouter for both embeddings and chat

One API key, one base URL, OpenAI-compatible SDK — and the ability to swap
either the embedding or chat model with a one-line env change (`CHAT_MODEL`)
instead of a provider-specific SDK migration. The tradeoff: OpenRouter adds
a proxy hop and its own rate limits on top of the underlying provider's,
which is part of why this project also implements its own app-level rate
limiting rather than relying solely on upstream limits (see
[Security notes](#security-notes)).

**Embeddings do not support streaming on OpenRouter** — only the chat/
generation call does. This is why the pipeline's embedding step
(`pipeline/embedChunks.ts`) is a single blocking batch call per document,
while only the final answer-generation call
(`rag/generateAnswer.ts`'s `streamAnswer`) streams token-by-token.

### Hybrid search (vector + full-text), not vector-only

Pure embedding similarity search misses exact keyword/proper-noun matches
surprisingly often — a chunk mentioning a specific product SKU or a named
policy can rank below more "semantically similar" but less relevant
chunks. `retrieveChunks.ts` runs both a cosine-distance vector search and a
Postgres full-text (`tsvector`/`plainto_tsquery`) search, then fuses the two
ranked lists via **reciprocal rank fusion** — a chunk that either leg
strongly vouches for survives the relevance cutoff, not just chunks that
both legs agree on.

### WebSocket for streaming, not SSE

Server-Sent Events would have been the simpler choice for this project's
one-directional token stream, and was seriously considered. WebSocket was
chosen instead specifically as a deliberate scope decision to build (and be
able to speak to in interviews) full-duplex, stateful connection handling —
cookie-authenticated upgrade handshake, per-message ownership
re-validation, reconnect-with-backoff on the client. The real product
tradeoff this introduces: WebSocket needs its own reconnection logic (SSE
gets this for free via `EventSource`'s built-in auto-reconnect), which is
why `frontend/src/hooks/useChatSocket.ts` implements a bounded single-retry
reconnect rather than assuming the connection just stays up.

### httpOnly cookie auth, not localStorage + Authorization header

A JWT in `localStorage` is readable by any JS running on the page — one XSS
vulnerability anywhere in the frontend's dependency tree (including a
compromised npm package) means every logged-in user's session is
exfiltratable. An httpOnly cookie is invisible to JavaScript entirely; the
tradeoff is CSRF exposure instead, which is why every state-changing route
lives behind `SameSite` cookie policy plus CORS configured to an exact
origin (`CORS_ORIGIN`, no wildcard) rather than `*`.

Because the frontend (Vercel) and backend (Render) are different origins in
production, the cookie needs `SameSite=None; Secure` there — which also
means the whole auth flow silently doesn't work over plain HTTP; both
deploy targets serve HTTPS by default, and local dev falls back to
`SameSite=Lax` (see `backend/src/lib/auth.ts`).

### Postgres-backed rate limiting, not Redis

Consistent with the pgvector decision above: this project already commits
to "just Postgres," and a fixed-window counter via one atomic
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (see
`backend/src/lib/rateLimiter.ts`) needs no new infrastructure. The known
weakness of a fixed window — up to 2x the stated limit if requests cluster
right across a window boundary — is an accepted tradeoff; a sliding-window
or token-bucket scheme (typically Redis-backed, often via a Lua script for
atomicity) is the natural upgrade if this ever needed to be precise under
real adversarial load rather than just protect free-tier LLM quota from
accidental bursts.

## Local development

### Option A — Docker Compose (recommended)

```bash
cp backend/.env.example backend/.env
# fill in OPENROUTER_API_KEY, CHAT_MODEL, JWT_SECRET (openssl rand -base64 48)
# DATABASE_URL and CORS_ORIGIN are overridden by docker-compose.yml for
# local use — you don't need to set them in backend/.env for this path.

docker compose up --build
# backend on :4000, Postgres+pgvector on :5432 (auto-migrated on container start)
```

```bash
cd frontend
npm install
npm run dev
# :5173, proxies /api and /ws to the backend container automatically
```

### Option B — running natively (no Docker)

Requires a local Postgres with the `vector` extension available (e.g. via
`apt install postgresql-16-pgvector` on Debian/Ubuntu, or use Neon's free
tier directly instead of a local instance).

```bash
cd backend
cp .env.example .env   # fill in all values, including a real DATABASE_URL
npm install
npm run db:migrate
npm run dev             # :4000
```

```bash
cd frontend
cp .env.example .env    # VITE_API_URL can stay empty for local dev
npm install
npm run dev              # :5173
```

## Deployment

| Piece | Target | Notes |
|---|---|---|
| Frontend | Vercel | Root directory `frontend/`, build command `npm run build`, output `dist/`. Set `VITE_API_URL` to the deployed backend's URL. |
| Backend | Render | `render.yaml` blueprint at repo root — "New > Blueprint" in Render picks it up directly. Builds from `backend/Dockerfile`. Set the `sync: false` env vars in Render's dashboard (never commit real secrets). |
| Database | Neon | Free tier, pgvector-enabled, persistent (not the ephemeral/branching-only tier). Run `npm run db:migrate` once against the Neon connection string, or let the container's start command do it automatically (see `backend/Dockerfile`). |

After both are deployed: set the backend's `CORS_ORIGIN` to the exact
Vercel URL, and the frontend's `VITE_API_URL` to the exact Render URL. Both
have to be exact — no wildcards, no trailing slashes — for the
credentialed CORS + cross-origin cookie setup to work (see
[Why httpOnly cookies](#httponly-cookie-auth-not-localstorage--authorization-header)
above).

## Testing strategy

**What's covered today:** pure-function unit tests (`backend/src/**/*.test.ts`,
run via `npm test` / `vitest`) for the chunking algorithm, prompt
construction + citation parsing, and the auth library (password hashing,
JWT round-trip, cookie policy by environment) — 25 tests, no database
dependency, fast enough to run on every push (see
`.github/workflows/backend-ci.yml`).

**What's deliberately not covered yet, and why:** route-level integration
tests (e.g. `supertest` against `POST /api/auth/signup` → `POST
/api/documents/upload` → `POST /api/conversations/:id/messages`) would need
a real Postgres instance in CI — a `postgres` service container with
migrations run before the test job, which `supertest` is already a
devDependency for. This is the natural next testing investment, scoped out
here to keep CI simple and fast while the pure-logic layer (where most of
the actual bugs during development showed up — citation parsing edge
cases, chunk boundary math) has solid coverage.

**Frontend:** no component tests yet. CI currently treats a clean
`tsc -b && vite build` as the smoke-test signal. React Testing Library +
Vitest would be the natural addition, starting with `MessageBubble`'s
citation-marker rendering logic (the highest-complexity, most bug-prone
piece of frontend code in this project).

## Evaluation

`eval/` contains a small retrieval-accuracy harness:

- `eval/fixtures/aurora-bikes-handbook.pdf` — a generated, fictional
  6-page employee handbook (source: `generate_fixture.py`) with one clear,
  unambiguous fact per page, so ground-truth page numbers aren't a
  judgment call.
- `eval/fixtures/questions.json` — 15 questions: 12 the document actually
  answers (with verified expected page numbers), and 3 deliberately
  unanswerable — including one adversarial case ("vacation days in the
  London office") designed to tempt a weaker RAG pipeline into
  extrapolating from a real but different policy instead of admitting it
  doesn't know.
- `eval/run.ts` — signs up a throwaway user, uploads the fixture, waits for
  processing, asks every question via the REST endpoint, and scores two
  metrics: **answerability accuracy** (did it correctly attempt an answer
  vs. correctly refuse?) and **citation-page accuracy** (for answerable
  questions, does at least one cited page match a known-correct page?).

Run it yourself against a running backend with a real `OPENROUTER_API_KEY`
configured:

```bash
cd eval
npm install
npm run eval                 # defaults to http://localhost:4000
# EVAL_API_BASE=https://your-app.onrender.com npm run eval
```

<!--
Run at 2026-08-04T05:00:35.166Z, against a local backend with a real
OpenRouter free-tier chat model configured. Re-run `npm run eval` and
update this if the chat model, prompt, or retrieval logic changes.
-->

| Metric | Result |
|---|---|
| Answerability accuracy | **93% (14/15)** |
| Citation page accuracy (answerable questions only) | **75% (9/12)** |

Full per-question breakdown: see `eval/results.md` after running `npm run eval`.

**The three misses, and why they happened** (worth calling out explicitly —
a suspiciously perfect eval score is less credible than one with explained
gaps):

- **q3 and q5 — correct answer, right page, but zero citation markers.**
  The model answered accurately from the correct excerpt in both cases, but
  didn't emit a `[n]` marker at all. This isn't a retrieval failure (the
  relevant chunk was clearly found and used) — it's the free-tier chat
  model not reliably following the citation-format instruction in the
  system prompt. Smaller/free-tier models tend to lose formatting
  constraints before they lose the core task; a paid model, or a stricter
  prompt with a few-shot citation example, would likely close this gap.
- **q12 — the one deliberately cross-section question, correctly refused
  rather than guessed.** This question needs two facts from topically
  distant pages (PTO carryover on page 3, parental leave on page 6).
  Top-k retrieval ranks chunks by similarity to the question as a whole; a
  question needing two unrelated facts stitched together doesn't match
  either page's embedding as strongly as a single-fact question would, so
  one or both facts likely didn't make it into the retrieved set together.
  The model then correctly emitted the "not found" sentinel rather than
  guessing at a comparison it couldn't fully support — arguably the
  fallback behaving exactly as designed, not a defect. Multi-hop questions
  like this are a known limitation of single-pass top-k retrieval; a
  query-decomposition step (splitting a compound question into sub-
  questions, retrieving for each separately, then combining) is the
  standard fix, and a natural next feature rather than something this
  project currently attempts.
- **All 3 deliberately unanswerable questions (q13–q15) were correctly
  refused**, including the adversarial "London office" question, which is
  the more important signal for a document Q&A tool than any single
  citation-accuracy point — a wrong refusal (hallucinating an answer that
  isn't in the document) is a worse failure mode than a missed citation.

**What this eval measures, and what it doesn't:** it checks retrieval
quality (right page cited) and refusal correctness (says "not found" when
it should), not answer *content* correctness — that would need either
human review or an LLM-as-judge second pass, both scoped out here as
beyond what a lightweight harness needs to demonstrate the retrieval
pipeline is sound.

## Security notes

- **httpOnly + SameSite cookie auth**, exact-origin CORS — see rationale
  above.
- **Postgres-backed rate limiting** on every LLM-calling endpoint (REST and
  WebSocket both), so a client can't bypass the limit by switching
  protocols.
- **Fixed a real vulnerability during development**: an earlier version of
  the documents router had a `POST /api/documents` endpoint (predating file
  upload, from before Phase 2) that accepted a client-supplied
  `storagePath` string. `DELETE /api/documents/:id` later passed that
  stored path straight into `fs.unlink()`. With a single fake dev-user
  stand-in (used before real auth existed) this was inert; once real
  multi-user auth landed, it became a genuine arbitrary-file-delete
  vector — any authenticated user could register a document row pointing
  at any path on the server's filesystem, then delete it. It was dead code
  by that point anyway (the frontend only ever called `/upload`), so it was
  removed rather than patched.
- **Zod validation** on every request body, server-side, independent of
  frontend form validation.
- **No refresh-token flow / server-side session store**: a session is a
  self-contained JWT valid for 7 days. The only revocation mechanism is
  rotating `JWT_SECRET`, which invalidates every session at once — a
  known, accepted scope cut (see `backend/src/lib/auth.ts`).

## What I'd do differently at scale

- **Add an HNSW index on `chunks.embedding`** once chunk counts grow past
  what exact search comfortably handles — see the pgvector section above.
- **Move rate limiting to Redis** with a token-bucket or sliding-window
  algorithm if this needed to hold up under real adversarial traffic
  rather than just guard free-tier LLM quota from accidental bursts.
- **Object storage instead of local disk** for uploaded PDFs — the current
  `storage/` directory (see `backend/src/lib/storage.ts`) works for a
  single Render instance but doesn't survive a redeploy or scale past one
  instance. S3-compatible storage (or Neon's own object storage, if/when
  available) would be the swap.
- **A real session/revocation story** — either short-lived access tokens
  with a refresh-token rotation flow, or a server-side session table so a
  single compromised token can be revoked without rotating the secret for
  every user.
- **DB-backed integration tests in CI** — see [Testing strategy](#testing-strategy).
- **Code-split the frontend bundle** — the production build currently
  warns about a >500KB chunk, driven mostly by KaTeX's font files loading
  eagerly for a math-rendering feature most conversations never use;
  dynamic `import()` for the KaTeX/math-rendering path would defer that
  weight until a document's answers actually contain math.
- **LLM-as-judge or human-reviewed answer-content scoring** in the eval
  harness, on top of today's retrieval/refusal-only metrics.
- **Query decomposition for multi-hop questions** — the eval's one
  cross-section question (q12: comparing a fact on page 3 against a fact on
  page 6) was correctly refused rather than answered, because single-pass
  top-k retrieval doesn't reliably surface two topically-distant chunks for
  one compound question. Splitting a compound question into sub-questions,
  retrieving separately for each, then combining, is the standard fix — a
  measured gap from the eval results above, not a hypothetical one.
- **A few-shot citation example in the system prompt**, or evaluating a
  paid (non-free-tier) chat model — the eval showed two cases (q3, q5)
  where the model gave a correct, correctly-sourced answer but skipped the
  `[n]` citation marker entirely. That's an instruction-following gap
  specific to the free-tier model in use, not a retrieval or prompt-logic
  bug; worth re-running the eval against a couple of different free-tier
  models to see whether it's model-specific before investing in a fancier
  citation-enforcement scheme.

## Project structure

```
backend/
  src/
    routes/          REST routes (auth, documents, conversations)
    ws/               WebSocket server (streaming chat)
    pipeline/         PDF extract -> chunk -> embed
    rag/              retrieval, prompt construction, citation parsing, generation
    lib/              auth, rate limiting, OpenRouter client, file storage
    middleware/       JWT authentication
    db/               Drizzle schema + migrations
  Dockerfile
frontend/
  src/
    components/       Sidebar, ChatPanel, MessageBubble, AuthScreen, ...
    hooks/            useAuth, useChatSocket
    api/              typed fetch client
eval/
  fixtures/           generated fixture PDF + ground-truth questions
  run.ts              eval harness
docker-compose.yml     local dev: pgvector Postgres + backend
render.yaml            Render Blueprint for backend deployment
.github/workflows/     CI: lint + typecheck + test/build, per package
```
