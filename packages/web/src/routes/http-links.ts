export function tokenizeLinks(value: string | null): string[] {
  return value?.split(/\s+/).filter(Boolean) ?? [];
}

export function normalizedHttpUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // WHATWG serialization deliberately normalizes accepted URLs before they
    // cross either public boundary (for example, adding a trailing slash).
    return url.toString();
  } catch {
    return null;
  }
}
