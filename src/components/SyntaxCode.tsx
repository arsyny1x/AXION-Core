import type { TextareaHTMLAttributes } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import http from "highlight.js/lib/languages/http";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import lua from "highlight.js/lib/languages/lua";
import plaintext from "highlight.js/lib/languages/plaintext";
import rust from "highlight.js/lib/languages/rust";

const LANGUAGES = { bash, http, javascript, json, lua, plaintext, rust };
export type SyntaxLanguage = keyof typeof LANGUAGES | "auto";

for (const [name, language] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, language);
}

function getHighlightedHtml(code: string, language: SyntaxLanguage): string {
  if (language === "auto") {
    return hljs.highlightAuto(code, Object.keys(LANGUAGES)).value;
  }
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}

export function SyntaxCodeBlock({
  code,
  language = "lua",
  className,
}: {
  code: string;
  language?: SyntaxLanguage;
  className?: string;
}) {
  return (
    <pre className={className}>
      <code
        className={`hljs language-${language}`}
        dangerouslySetInnerHTML={{ __html: getHighlightedHtml(code, language) }}
      />
    </pre>
  );
}

type SyntaxCodeEditorProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "className" | "onChange" | "value"
> & {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  language?: SyntaxLanguage;
};

export function SyntaxCodeEditor({
  value,
  onChange,
  className,
  language = "lua",
  onScroll,
  ...textareaProps
}: SyntaxCodeEditorProps) {
  const highlightedHtml = getHighlightedHtml(
    `${value || " "}${value.endsWith("\n") ? " " : ""}`,
    language,
  );

  return (
    <div className={`syntax-editor-shell ${className ?? ""}`}>
      <pre className="syntax-editor-highlight" aria-hidden="true">
        <code
          className={`hljs language-${language}`}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </pre>
      <textarea
        {...textareaProps}
        className="syntax-editor-input"
        value={value}
        onChange={event => onChange(event.target.value)}
        onScroll={event => {
          const highlight = event.currentTarget.previousElementSibling;
          if (highlight instanceof HTMLElement) {
            highlight.scrollTop = event.currentTarget.scrollTop;
            highlight.scrollLeft = event.currentTarget.scrollLeft;
          }
          onScroll?.(event);
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
    </div>
  );
}

const TERMINAL_TOKEN =
  /(\b(?:error|failed|failure|warning|warn|success|connected|disconnected|online|offline|ready)\b|\[[A-Z][A-Z0-9 _-]*\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b)/gi;

export function SyntaxTerminalText({ text }: { text: string }) {
  const parts = text.split(TERMINAL_TOKEN);
  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;
        if (/^(error|failed|failure)$/i.test(part)) {
          return <span className="terminal-token-error" key={index}>{part}</span>;
        }
        if (/^(warning|warn)$/i.test(part)) {
          return <span className="terminal-token-warning" key={index}>{part}</span>;
        }
        if (/^(success|connected|online|ready)$/i.test(part)) {
          return <span className="terminal-token-success" key={index}>{part}</span>;
        }
        if (/^(disconnected|offline)$/i.test(part)) {
          return <span className="terminal-token-warning" key={index}>{part}</span>;
        }
        if (/^\[/.test(part)) {
          return <span className="terminal-token-tag" key={index}>{part}</span>;
        }
        if (/^["']/.test(part)) {
          return <span className="terminal-token-string" key={index}>{part}</span>;
        }
        if (/^\d/.test(part)) {
          return <span className="terminal-token-number" key={index}>{part}</span>;
        }
        return part;
      })}
    </>
  );
}
