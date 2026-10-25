import type { ReviewData, ReviewEntry } from "../shared/trust";

/**
 * Reads only what the review checks need: review text, rating, date, a masked pseudonym and the
 * "verified" label. Never reviewer profiles, never anything behind a login.
 */

function maskName(name: string | undefined): string | undefined {
  const clean = name?.replace(/\s+/g, " ").trim();
  return clean ? `${clean[0].toUpperCase()}•••` : undefined;
}

function numberFrom(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface JsonProduct { name?: string; aggregateRating?: Record<string, unknown>; review?: unknown }

function jsonLdProducts(): JsonProduct[] {
  const products: JsonProduct[] = [];
  for (const script of Array.from(document.querySelectorAll("script[type='application/ld+json']")).slice(0, 20)) {
    try {
      const data: unknown = JSON.parse(script.textContent ?? "");
      const queue: unknown[] = Array.isArray(data) ? [...data] : [data];
      while (queue.length) {
        const item = queue.shift() as Record<string, unknown> | null;
        if (!item || typeof item !== "object") continue;
        if (Array.isArray(item["@graph"])) queue.push(...item["@graph"]);
        if (/Product|Book|SoftwareApplication|Course|LocalBusiness|Organization/i.test(String(item["@type"] ?? "")) && (item.aggregateRating || item.review)) {
          products.push(item as JsonProduct);
        }
      }
    } catch {
      // Malformed JSON-LD is ignored.
    }
  }
  return products;
}

function ratingFrom(element: Element): number | undefined {
  const explicit = element.querySelector("[itemprop=ratingValue]");
  if (explicit) return numberFrom(explicit.getAttribute("content") ?? explicit.textContent);
  const labelled = Array.from(element.querySelectorAll("[aria-label],[title],[class*=star i],[class*=rating i]"))
    .map((node) => `${node.getAttribute("aria-label") ?? ""} ${node.getAttribute("title") ?? ""} ${node.textContent ?? ""}`)
    .join(" ");
  const match = labelled.match(/(\d(?:\.\d)?)\s*(?:out of|\/|of)\s*5/i);
  return match ? Number(match[1]) : undefined;
}

function dateFrom(element: Element): string | undefined {
  const time = element.querySelector("time[datetime],[itemprop=datePublished]");
  if (time) return time.getAttribute("datetime") ?? time.getAttribute("content") ?? time.textContent ?? undefined;
  const text = (element as HTMLElement).innerText ?? "";
  return text.match(/\b(?:\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{4})\b/i)?.[0];
}

function pageReviews(): ReviewEntry[] {
  const candidates = Array.from(document.querySelectorAll("[itemprop=review],[data-hook=review],[data-testid*=review i],[class*=review i],[id*=review i]"))
    .filter((element) => {
      const text = (element as HTMLElement).innerText?.trim() ?? "";
      return text.length >= 20 && text.length <= 4000 && !/review-?(summary|histogram|stats|form)/i.test(element.className.toString());
    });
  // Keep the innermost element of nested matches so each review is counted once.
  const leaves = candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
  return leaves.slice(0, 300).map((element) => {
    const body = element.querySelector("[itemprop=reviewBody],[data-hook=review-body],[class*=body i],[class*=content i],[class*=text i]");
    const text = ((body as HTMLElement | null)?.innerText ?? (element as HTMLElement).innerText).replace(/\s+/g, " ").trim().slice(0, 1500);
    const author = element.querySelector("[itemprop=author],[class*=author i],[class*=reviewer i],[class*=profile-name i]")?.textContent ?? undefined;
    return {
      text,
      rating: ratingFrom(element),
      date: dateFrom(element),
      author: maskName(author),
      verifiedLabel: /verified (?:purchase|buyer|owner)|certified buyer/i.test((element as HTMLElement).innerText),
      source: element.matches("[itemprop=review]") ? "microdata" as const : "page" as const
    };
  }).filter((review) => review.text.length >= 10);
}

export function extractReviews(): ReviewData {
  const products = jsonLdProducts();
  const product = products[0];
  const aggregate = product?.aggregateRating ?? {};
  const structuredReviews = (Array.isArray(product?.review) ? product!.review : product?.review ? [product.review] : []) as Record<string, unknown>[];
  const fromJson: ReviewEntry[] = structuredReviews.slice(0, 200).flatMap((review) => {
    const text = String(review.reviewBody ?? review.description ?? "").trim();
    if (text.length < 10) return [];
    const author = review.author as Record<string, unknown> | string | undefined;
    return [{
      text: text.slice(0, 1500),
      rating: numberFrom((review.reviewRating as Record<string, unknown> | undefined)?.ratingValue),
      date: typeof review.datePublished === "string" ? review.datePublished : undefined,
      author: maskName(typeof author === "string" ? author : typeof author?.name === "string" ? author.name : undefined),
      verifiedLabel: false,
      source: "json-ld" as const
    }];
  });
  const text = document.body?.innerText ?? "";
  const countMatch = text.match(/([\d,.]+)\s*(?:k\s+)?(?:global\s+)?(?:ratings?|reviews?|customer reviews)\b/i);
  const averageMatch = text.match(/\b([1-5](?:\.\d)?)\s*(?:out of|\/)\s*5\b/i);
  const microCount = document.querySelector("[itemprop=reviewCount],[itemprop=ratingCount]");
  const microAverage = document.querySelector("[itemprop=aggregateRating] [itemprop=ratingValue]");
  const ogType = document.querySelector("meta[property='og:type']")?.getAttribute("content") ?? "";
  return {
    domain: location.hostname,
    url: `${location.origin}${location.pathname}`,
    productName: product?.name ?? document.querySelector("meta[property='og:title']")?.getAttribute("content") ?? document.querySelector("h1")?.textContent?.trim() ?? undefined,
    isProductPage: Boolean(product) || /product/i.test(ogType) || /add to (?:cart|bag|basket)|buy now/i.test(text),
    displayed: { count: countMatch ? numberFrom(countMatch[1]) : undefined, average: averageMatch ? Number(averageMatch[1]) : undefined },
    structured: {
      count: numberFrom(aggregate.reviewCount ?? aggregate.ratingCount) ?? numberFrom(microCount?.getAttribute("content") ?? microCount?.textContent),
      average: numberFrom(aggregate.ratingValue) ?? numberFrom(microAverage?.getAttribute("content") ?? microAverage?.textContent),
      reviews: fromJson.length
    },
    reviews: [...fromJson, ...pageReviews()]
  };
}
