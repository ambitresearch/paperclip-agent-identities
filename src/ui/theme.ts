import { useEffect, useState, type CSSProperties } from "react";

export type PaperclipThemeMode = "light" | "dark";

type AgentIdentitiesThemeVars = CSSProperties & Record<`--agent-identities-${string}`, string>;

export const uiSurface = "var(--agent-identities-surface)";
export const uiCanvas = "var(--agent-identities-canvas)";
export const uiPanel = "var(--agent-identities-panel)";
export const uiMutedPanel = "var(--agent-identities-muted-panel)";
export const uiInput = "var(--agent-identities-input)";
export const uiBorder = "var(--agent-identities-border)";
export const uiBorderStrong = "var(--agent-identities-border-strong)";
export const uiText = "var(--agent-identities-text)";
export const uiMutedText = "var(--agent-identities-muted-text)";
export const uiPrimary = "var(--agent-identities-primary)";
export const uiPrimaryText = "var(--agent-identities-primary-text)";
export const uiLink = "var(--agent-identities-link)";
export const uiSuccess = "var(--agent-identities-success)";
export const uiWarning = "var(--agent-identities-warning)";
export const uiDanger = "var(--agent-identities-danger)";
export const uiOverlay = "var(--agent-identities-overlay)";
export const uiShadow = "var(--agent-identities-shadow)";

export function createPaperclipThemeStyle(mode: PaperclipThemeMode): AgentIdentitiesThemeVars {
  return mode === "dark" ? darkThemeVars : lightThemeVars;
}

export function usePaperclipThemeMode(): PaperclipThemeMode {
  const [mode, setMode] = useState<PaperclipThemeMode>(() => detectPaperclipThemeMode());

  useEffect(() => {
    const updateMode = () => setMode(detectPaperclipThemeMode());
    const observedDocuments = [document, getSameOriginParentDocument()].filter((doc): doc is Document => Boolean(doc));
    const observers = observedDocuments.flatMap((doc) => {
      const targets = [doc.documentElement, doc.body].filter((target): target is HTMLElement => Boolean(target));
      return targets.map((target) => {
        const observer = new MutationObserver(updateMode);
        observer.observe(target, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
        return observer;
      });
    });
    const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");

    mediaQuery?.addEventListener?.("change", updateMode);
    updateMode();

    return () => {
      observers.forEach((observer) => observer.disconnect());
      mediaQuery?.removeEventListener?.("change", updateMode);
    };
  }, []);

  return mode;
}

function detectPaperclipThemeMode(): PaperclipThemeMode {
  if (typeof document === "undefined") return "light";

  const documents = [document, getSameOriginParentDocument()].filter((doc): doc is Document => Boolean(doc));
  for (const doc of documents) {
    const explicitMode = getExplicitThemeMode(doc.documentElement) ?? getExplicitThemeMode(doc.body);
    if (explicitMode) return explicitMode;
  }

  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

function getExplicitThemeMode(element: HTMLElement | null): PaperclipThemeMode | null {
  if (!element) return null;
  const theme = element.dataset.theme?.toLowerCase();
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  if (element.classList.contains("dark") || element.classList.contains("dark-theme")) return "dark";
  if (element.classList.contains("light") || element.classList.contains("light-theme")) return "light";
  if (element.style.colorScheme === "dark") return "dark";
  if (element.style.colorScheme === "light") return "light";
  return null;
}

function getSameOriginParentDocument(): Document | null {
  if (typeof window === "undefined" || window.parent === window) return null;
  try {
    return window.parent.document;
  } catch {
    return null;
  }
}

const lightThemeVars: AgentIdentitiesThemeVars = {
  colorScheme: "light",
  "--agent-identities-surface": "oklch(100% 0 0)",
  "--agent-identities-canvas": "oklch(100% 0 0)",
  "--agent-identities-panel": "oklch(97% 0 0)",
  "--agent-identities-muted-panel": "oklch(92.2% 0 0)",
  "--agent-identities-input": "oklch(100% 0 0)",
  "--agent-identities-border": "oklch(92.2% 0 0)",
  "--agent-identities-border-strong": "oklch(70.8% 0 0)",
  "--agent-identities-text": "oklch(14.5% 0 0)",
  "--agent-identities-muted-text": "oklch(55.6% 0 0)",
  "--agent-identities-primary": "oklch(20.5% 0 0)",
  "--agent-identities-primary-text": "oklch(98.5% 0 0)",
  "--agent-identities-link": "oklch(42% 0.16 264)",
  "--agent-identities-success": "oklch(52.7% 0.154 150.069)",
  "--agent-identities-warning": "oklch(55.5% 0.163 48.998)",
  "--agent-identities-danger": "oklch(57.7% 0.245 27.325)",
  "--agent-identities-overlay": "oklch(0% 0 0 / 42%)",
  "--agent-identities-shadow": "oklch(0% 0 0 / 18%)",
};

const darkThemeVars: AgentIdentitiesThemeVars = {
  colorScheme: "dark",
  "--agent-identities-surface": "oklch(20.5% 0 0)",
  "--agent-identities-canvas": "oklch(20.5% 0 0)",
  "--agent-identities-panel": "oklch(26.9% 0 0)",
  "--agent-identities-muted-panel": "oklch(35% 0 0)",
  "--agent-identities-input": "oklch(26.9% 0 0)",
  "--agent-identities-border": "oklch(35% 0 0)",
  "--agent-identities-border-strong": "oklch(43.9% 0 0)",
  "--agent-identities-text": "oklch(98.5% 0 0)",
  "--agent-identities-muted-text": "oklch(70.8% 0 0)",
  "--agent-identities-primary": "oklch(98.5% 0 0)",
  "--agent-identities-primary-text": "oklch(20.5% 0 0)",
  "--agent-identities-link": "oklch(78% 0.12 264)",
  "--agent-identities-success": "oklch(72.3% 0.219 149.579)",
  "--agent-identities-warning": "oklch(85.2% 0.199 91.936)",
  "--agent-identities-danger": "oklch(70.4% 0.191 22.216)",
  "--agent-identities-overlay": "oklch(0% 0 0 / 58%)",
  "--agent-identities-shadow": "oklch(0% 0 0 / 45%)",
};
