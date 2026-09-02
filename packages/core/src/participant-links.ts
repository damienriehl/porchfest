export interface ExtractedParticipantLinks {
  readonly links: readonly string[];
  readonly residue: readonly string[];
  readonly invalidUrls: readonly string[];
  readonly nonHttpSchemes: readonly string[];
}

/**
 * Turns the free-text link answers used by both imports and public signups into
 * normalized HTTP(S) URLs plus useful prose. Callers at an interactive boundary
 * may refuse invalid/non-HTTP schemes; imports retain those values as residue.
 */
export function extractParticipantLinks(
  ...values: readonly unknown[]
): ExtractedParticipantLinks {
  const links = new Set<string>();
  const residue: string[] = [];
  const invalidUrls = new Set<string>();
  const nonHttpSchemes = new Set<string>();
  for (const raw of values) {
    const value = optionalString(raw);
    if (!value || isLinkPlaceholder(value)) continue;
    const remainder = value.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
      const candidate = match.replace(/[,.;)]+$/g, "");
      try {
        const url = new URL(candidate);
        links.add(url.toString());
        return " ";
      } catch {
        invalidUrls.add(candidate);
        return match;
      }
    });
    for (const match of remainder.matchAll(
      /(?:^|[\s(])([a-z][a-z0-9+.-]*:)(?=\S)/gi,
    )) {
      const scheme = match[1]?.toLowerCase();
      if (scheme !== undefined && scheme !== "http:" && scheme !== "https:") {
        nonHttpSchemes.add(scheme);
      }
    }
    const useful = remainder
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-,;:]+|[-,;:]+$/g, "");
    if (useful && !isLinkPlaceholder(useful)) residue.push(useful);
  }
  return {
    links: [...links],
    residue,
    invalidUrls: [...invalidUrls],
    nonHttpSchemes: [...nonHttpSchemes],
  };
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isLinkPlaceholder(value: string): boolean {
  return /^(?:n\/?a|none|-|no)$/i.test(value.trim());
}
