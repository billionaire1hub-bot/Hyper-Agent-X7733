const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(value) {
  return String(value ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const stripCdata = (value) =>
  String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .trim();

export function stripHtml(value) {
  return decodeEntities(
    stripCdata(value)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

const tagValue = (block, tag) => {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return null;
  return stripHtmlish(match[1]);
};

const stripHtmlish = (value) => stripCdata(value);

const attrValue = (block, tag, attribute) => {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["'][^>]*>`, "i"));
  return match ? decodeEntities(match[1]).trim() : null;
};

const toIso = (value) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

/**
 * Minimal, dependency-free RSS 2.0 / Atom parser. Extracts the fields this
 * agent needs (title, link, timestamp, summary, categories) from live feeds.
 */
export function parseFeed(xml) {
  const source = String(xml ?? "");
  const blocks = source.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  return blocks
    .map((block) => {
      const title = stripHtmlish(tagValue(block, "title") || "");
      const link =
        tagValue(block, "link") ||
        attrValue(block, "link", "href") ||
        tagValue(block, "guid") ||
        attrValue(block, "guid", "isPermaLink");
      const publishedAt = toIso(
        tagValue(block, "pubDate") ||
          tagValue(block, "published") ||
          tagValue(block, "updated") ||
          tagValue(block, "dc:date")
      );
      const summarySource =
        tagValue(block, "description") ||
        tagValue(block, "summary") ||
        tagValue(block, "content:encoded") ||
        tagValue(block, "content") ||
        "";
      const summary = stripHtml(summarySource).slice(0, 600);
      const categories = Array.from(block.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi))
        .map((match) => stripHtml(match[1]))
        .filter(Boolean)
        .slice(0, 5);

      return {
        title: stripHtml(title),
        url: link ? decodeEntities(link).trim() : null,
        publishedAt,
        summary,
        categories,
      };
    })
    .filter((item) => item.title && item.url);
}
