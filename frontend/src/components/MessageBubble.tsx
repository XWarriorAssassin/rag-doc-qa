import { createContext, useContext, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { Citation, MessageRecord } from "../types";

type CitationContextValue = {
  interactive: boolean;
  byMarker: Map<number, Citation>;
  activeMarker: number | null;
  setActiveMarker: React.Dispatch<React.SetStateAction<number | null>>;
};

const CitationContext = createContext<CitationContextValue | null>(null);

function useCitationContext() {
  const ctx = useContext(CitationContext);
  if (!ctx) {
    throw new Error("CitationContext is missing");
  }
  return ctx;
}

// mdast/hast node shape isn't worth pulling in `unist`'s generic Node<Data>
// typing for what this plugin does (recursively walk .children, read
// .type/.value, splice in replacement nodes) — every one of those is
// effectively `any` under unified's types without the full generic dance.
// One named, documented alias here beats scattering bare `any` across five
// call sites below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MdastNode = any;

/**
 * Remark plugin that converts `[n]` tokens in normal prose into custom
 * citation nodes, while leaving Markdown and KaTeX to be rendered normally.
 *
 * Because this runs on the parsed markdown tree, it does not break math
 * blocks the way string-splitting does.
 */
function remarkCitationMarkers() {
  return (tree: MdastNode) => {
    const walk = (node: MdastNode) => {
      if (!node || !Array.isArray(node.children)) return;

      for (let i = 0; i < node.children.length; i += 1) {
        const child = node.children[i];

        if (child?.type === "text" && typeof child.value === "string") {
          const value: string = child.value;
          const regex = /\[(\d+)\]/g;
          const matches = [...value.matchAll(regex)];

          if (matches.length === 0) continue;

          const replacementNodes: MdastNode[] = [];
          let lastIndex = 0;

          for (const match of matches) {
            const matchIndex = match.index ?? 0;

            if (matchIndex > lastIndex) {
              replacementNodes.push({
                type: "text",
                value: value.slice(lastIndex, matchIndex),
              });
            }

            const n = match[1] ?? "";
            replacementNodes.push({
              type: "citationMarker",
              data: {
                hName: "citation-marker",
                hProperties: { n },
              },
            });

            lastIndex = matchIndex + match[0].length;
          }

          if (lastIndex < value.length) {
            replacementNodes.push({
              type: "text",
              value: value.slice(lastIndex),
            });
          }

          node.children.splice(i, 1, ...replacementNodes);
          i += replacementNodes.length - 1;
          continue;
        }

        walk(child);
      }
    };

    walk(tree);
  };
}

function CitationMarkerNode({ node }: { node?: MdastNode }) {
  const { interactive, byMarker, activeMarker, setActiveMarker } =
    useCitationContext();

  const raw = node?.properties?.n;
  const n = Number(raw);

  if (!Number.isFinite(n)) {
    return null;
  }

  const citation = byMarker.get(n);

  // If we do not have a marker mapping (history reload), keep the text visible
  // instead of turning it into a broken button.
  if (!interactive || !citation) {
    return <span>[{n}]</span>;
  }

  return (
    <button
      type="button"
      className="citation-marker"
      aria-expanded={activeMarker === n}
      onClick={() => setActiveMarker((cur) => (cur === n ? null : n))}
    >
      {n}
    </button>
  );
}

function Footnote({ citation }: { citation: Citation }) {
  return (
    <div className="citation-footnote">
      <strong>p.{citation.pageNumber}</strong> — {citation.excerpt}
    </div>
  );
}

function SourcesFooter({ citations }: { citations: Citation[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const active = citations.find((c) => c.chunkId === openId);

  return (
    <div>
      <div className="sources-footer">
        <span className="sources-footer-label">Sources</span>
        {citations.map((c, i) => (
          <button
            key={c.chunkId}
            type="button"
            className="citation-marker"
            aria-expanded={openId === c.chunkId}
            onClick={() => setOpenId((cur) => (cur === c.chunkId ? null : c.chunkId))}
          >
            {i + 1} · p.{c.pageNumber}
          </button>
        ))}
      </div>
      {active && <Footnote citation={active} />}
    </div>
  );
}

function RichMarkdown({
  text,
  citations,
  interactive,
}: {
  text: string;
  citations: Citation[];
  interactive: boolean;
}) {
  const [activeMarker, setActiveMarker] = useState<number | null>(null);

  const byMarker = useMemo(
    () =>
      new Map(
        citations
          .filter((c): c is Citation & { marker: number } => c.marker !== undefined)
          .map((c) => [c.marker, c])
      ),
    [citations]
  );

  const active = activeMarker !== null ? byMarker.get(activeMarker) : undefined;

  return (
    <CitationContext.Provider
      value={{
        interactive,
        byMarker,
        activeMarker,
        setActiveMarker,
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkCitationMarkers]}
        rehypePlugins={[rehypeKatex]}
        components={
          {
            p: ({ children }: { children?: React.ReactNode }) => <p style={{ margin: 0 }}>{children}</p>,
            "citation-marker": CitationMarkerNode,
            // react-markdown's Components type is generated from standard
            // HTML tag names; "citation-marker" is a synthetic element we
            // introduce ourselves via the remark plugin's hName above, so
            // TS has no way to know it's valid. This is the narrowest
            // possible escape hatch — cast only this object literal, not
            // the whole file's type-checking.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any
        }
      >
        {text}
      </ReactMarkdown>

      {interactive && active && <Footnote citation={active} />}
    </CitationContext.Provider>
  );
}

/** Renders assistant prose and supports both markdown + KaTeX + citations. */
function AnsweredContent({
  content,
  citations,
}: {
  content: string;
  citations: Citation[];
}) {
  const hasMarkerMapping = citations.some((c) => c.marker !== undefined);

  if (!hasMarkerMapping) {
    // History reload: we may still have citations, but not the original
    // marker-to-chunk mapping. Render the prose normally and show a sources list.
    return (
      <>
        <RichMarkdown text={content} citations={citations} interactive={false} />
        {citations.length > 0 && <SourcesFooter citations={citations} />}
      </>
    );
  }

  return <RichMarkdown text={content} citations={citations} interactive />;
}

export function MessageBubble({ message }: { message: MessageRecord }) {
  if (message.role === "user") {
    return (
      <div className="message-row user">
        <div className="message-user-card">{message.content}</div>
      </div>
    );
  }

  const isFallback = message.citedChunkIds.length === 0;

  return (
    <div className="message-row assistant">
      <div className={`message-assistant${isFallback ? " unanswerable" : ""}`}>
        {isFallback ? (
          <RichMarkdown
            text={message.content}
            citations={message.citations ?? []}
            interactive={false}
          />
        ) : (
          <AnsweredContent content={message.content} citations={message.citations ?? []} />
        )}
      </div>
    </div>
  );
}