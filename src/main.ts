import { tool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { webSearchTool } from "@openai/agents-openai";
import { z } from "zod";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";

// ---------- Config ----------
const ALLOWED_DOMAINS = (process.env.ALLOWED_LISTING_DOMAINS ??
  "centris.ca,realtor.ca,royallepage.ca,remax-quebec.com,duproprio.com")
  .split(",")
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? "10000");

// ---------- Shared client for guardrails ----------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Guardrails ----------
const guardrailsConfig = {
  guardrails: [
    {
      name: "Moderation",
      config: {
        categories: [
          "sexual/minors",
          "hate/threatening",
          "harassment/threatening",
          "self-harm/instructions",
          "violence/graphic",
          "illicit/violent",
        ],
      },
    },
    {
      name: "Contains PII",
      config: {
        block: true,
        entities: ["CREDIT_CARD", "US_BANK_NUMBER", "US_PASSPORT", "US_SSN"],
      },
    },
  ],
};
const context = { guardrailLlm: client };

function guardrailsHasTripwire(results: any[]) {
  return (results ?? []).some((r) => r?.tripwireTriggered === true);
}
function getGuardrailSafeText(results: any[], fallbackText: string) {
  for (const r of results ?? []) {
    if (r?.info && "checked_text" in r.info) return r.info.checked_text ?? fallbackText;
  }
  const pii = (results ?? []).find((r) => r?.info && "anonymized_text" in r.info);
  return pii?.info?.anonymized_text ?? fallbackText;
}
function buildGuardrailFailOutput(results: any[]) {
  const get = (name: string) =>
    (results ?? []).find((r) => {
      const info = r?.info ?? {};
      const n = info?.guardrail_name ?? info?.guardrailName;
      return n === name;
    });
  const pii = get("Contains PII");
  const mod = get("Moderation");
  const jb = get("Jailbreak");
  const hal = get("Hallucination Detection");
  const piiCounts = Object.entries(pii?.info?.detected_entities ?? {})
    .filter(([, v]) => Array.isArray(v))
    .map(([k, v]: [string, any[]]) => k + ":" + v.length);
  return {
    pii: {
      failed: piiCounts.length > 0 || pii?.tripwireTriggered === true,
      ...(piiCounts.length ? { detected_counts: piiCounts } : {}),
      ...(pii?.executionFailed && pii?.info?.error ? { error: pii.info.error } : {}),
    },
    moderation: {
      failed: mod?.tripwireTriggered === true || (mod?.info?.flagged_categories ?? []).length > 0,
      ...(mod?.info?.flagged_categories ? { flagged_categories: mod.info.flagged_categories } : {}),
      ...(mod?.executionFailed && mod?.info?.error ? { error: mod.info.error } : {}),
    },
    jailbreak: {
      failed: jb?.tripwireTriggered === true,
      ...(jb?.executionFailed && jb?.info?.error ? { error: jb.info.error } : {}),
    },
    hallucination: {
      failed: hal?.tripwireTriggered === true,
      ...(hal?.info?.reasoning ? { reasoning: hal.info.reasoning } : {}),
      ...(hal?.info?.hallucination_type ? { hallucination_type: hal.info.hallucination_type } : {}),
      ...(hal?.info?.hallucinated_statements ? { hallucinated_statements: hal.info.hallucinated_statements } : {}),
      ...(hal?.info?.verified_statements ? { verified_statements: hal.info.verified_statements } : {}),
      ...(hal?.executionFailed && hal?.info?.error ? { error: hal.info.error } : {}),
    },
  };
}

// ---------- Utility helpers ----------
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
function numberFromPriceLike(s?: string | null) {
  if (!s) return null;
  const raw = s.replace(/[^\d]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function first<T>(...vals: Array<T | null | undefined>) {
  return vals.find((v) => v != null) ?? null;
}
function domainAllowed(url: string) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

// ---------- Tools ----------
const normalizeAndDedupeListings = tool({
  name: "normalizeAndDedupeListings",
  description:
    "Normalize listings, deduplicate by MLS, trim text fields, normalize prices to numbers, and cap results to 12.",
  parameters: z.object({
    listings: z.array(z.record(z.any())),
  }),
  execute: async (input: { listings: Record<string, any>[] }) => {
    const seen: Record<string, number> = {};
    const out: any[] = [];

    for (const item of input.listings ?? []) {
      const mlsRaw =
        first(item.mls, item.MLS, item.listingId, item.listing_id, item["MLS®"]) ?? null;
      const mls = mlsRaw ? String(mlsRaw).trim() : null;

      const url: string | null = item.url ? String(item.url).trim() : null;
      const address: string | null = item.address ? String(item.address).trim() : null;
      const beds: number | null =
        item.beds != null ? Number(String(item.beds).replace(/[^\d]/g, "")) : null;
      const baths: number | null =
        item.baths != null ? Number(String(item.baths).replace(/[^\d.]/g, "")) : null;
      const type: string | null = item.type ? String(item.type).trim() : null;
      const note_fr: string | null = item.note_fr ? String(item.note_fr).trim() : null;
      const note_en: string | null = item.note_en ? String(item.note_en).trim() : null;

      const price =
        item.price != null
          ? Number(item.price)
          : numberFromPriceLike(first(item.priceText, item.price_str, item.askingPrice));

      const normalized = {
        mls: mls ?? "MLS non trouvé / MLS not found",
        url,
        address,
        price,
        beds,
        baths,
        type,
        note_fr: note_fr ?? null,
        note_en: note_en ?? null,
      };

      const key = mls ? `MLS:${mls.toUpperCase()}` : url ? `URL:${url}` : `IDX:${out.length}`;
      if (seen[key] == null) {
        seen[key] = out.length;
        out.push(normalized);
      } else {
        const idx = seen[key];
        const prior = out[idx];
        out[idx] = {
          ...prior,
          address: prior.address ?? normalized.address,
          price: prior.price ?? normalized.price,
          beds: prior.beds ?? normalized.beds,
          baths: prior.baths ?? normalized.baths,
          type: prior.type ?? normalized.type,
          note_fr: prior.note_fr ?? normalized.note_fr,
          note_en: prior.note_en ?? normalized.note_en,
        };
      }

      if (out.length >= 12) break;
    }

    return { listings: out.slice(0, 12) };
  },
});

const fetchHtmlPage = tool({
  name: "fetchHtmlPage",
  description: "Fetch an HTML listing page with desktop User-Agent, timeout, and retries",
  parameters: z.object({ url: z.string().url() }),
  execute: async ({ url }: { url: string }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { headers, signal: controller.signal as any });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        return { url, html };
      } catch (e) {
        lastErr = e;
        await sleep(300 + attempt * 500);
      }
    }
    throw new Error(`fetchHtmlPage failed for ${url}: ${String(lastErr)}`);
  },
});

const extractListingInfo = tool({
  name: "extractListingInfo",
  description:
    "Extract MLS or listing ID, address, price, beds, baths, and property type from supplied HTML or a URL for a real estate listing.",
  parameters: z.object({
    url: z.string().url().optional().default(""),
    html: z.string(),
  }),
  execute: async ({ url = "", html }: { url?: string; html: string }) => {
    const mlsPatterns = [
      /MLS[®™]?\s*#?\s*[:\-]?\s*([A-Z0-9\-]+)/i,
      /Num(é|e)ro\s+Centris\s*[:\-]?\s*([0-9\-]+)/i,
      /Centris\s*#\s*([0-9\-]+)/i,
      /Listing\s*ID\s*[:\-]?\s*([A-Z0-9\-]+)/i,
      /ID\s*[:\-]?\s*([A-Z0-9\-]{5,})/i,
    ];
    const pricePatterns = [
      /\$[\s]*[0-9][0-9,.\s]*/g,
      /Prix\s*[:\-]?\s*\$[\s]*[0-9][0-9,.\s]*/gi,
      /Asking\s*Price\s*[:\-]?\s*\$[\s]*[0-9][0-9,.\s]*/gi,
    ];
    const addressPatterns = [
      /property-address[^>]*>\s*([^<]+)</i,
      /"address"\s*:\s*"([^"]+)"/i,
      /<meta[^>]+property="og:street-address"[^>]+content="([^"]+)"/i,
      /itemprop="streetAddress"[^>]*>\s*([^<]+)</i,
      /<h1[^>]*class="[^"]*(address|street)[^"]*"[^>]*>\s*([^<]+)</i,
    ];
    const bedsPatterns = [/(\d+)\s*(?:ch|chambres|beds|bedrooms)\b/i, /"bedrooms"\s*:\s*(\d+)/i];
    const bathsPatterns = [
      /(\d+(\.\d+)?)\s*(?:sdb|salles?\s*de\s*bain|baths?)\b/i,
      /"bathrooms"\s*:\s*(\d+(\.\d+)?)/i,
    ];
    const typePatterns = [
      /(maison|house|condo|copropri(é|e)t(é|e)|multiplex|plex|terrain|land|commercial)/i,
      /"propertyType"\s*:\s*"([^"]+)"/i,
    ];
    const findFirst = (patterns: RegExp[], text: string) => {
      for (const re of patterns) {
        const m = re.exec(text);
        if (m) return m[1] ?? m[0];
      }
      return null;
    };
    const findAll = (re: RegExp, text: string) => {
      const out: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) out.push(m[0]);
      return out;
    };

    const mls = findFirst(mlsPatterns, html) ?? null;
    let price: number | null = null;
    for (const pat of pricePatterns) {
      const hits = findAll(pat, html);
      if (hits.length) {
        price = numberFromPriceLike(hits[0]);
        if (price != null) break;
      }
    }

    const address = findFirst(addressPatterns, html) ?? null;
    const bedsRaw = findFirst(bedsPatterns, html);
    const bathsRaw = findFirst(bathsPatterns, html);
    const typeRaw = findFirst(typePatterns, html);

    const beds = bedsRaw ? Number(String(bedsRaw).replace(/[^\d]/g, "")) : null;
    const baths = bathsRaw ? Number(String(bathsRaw).replace(/[^\d.]/g, "")) : null;
    const type = typeRaw ? String(typeRaw).toLowerCase() : null;

    return {
      mls: mls ?? "MLS non trouvé / MLS not found",
      url: url || null,
      address,
      price,
      beds,
      baths,
      type,
    };
  },
});

const searchRealEstateListings = tool({
  name: "searchRealEstateListings",
  description:
    "Search for real estate listing URLs from major Canadian platforms using SerpAPI and filter results to allowed domains.",
  parameters: z.object({
    q: z.string(),
    num: z.number().int().min(1).max(20).default(10),
  }),
  execute: async ({ q, num }: { q: string; num: number }) => {
    const key = process.env.SERPAPI_KEY;
    if (!key) throw new Error("SERPAPI_KEY env var is required for searchRealEstateListings.");
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", q);
    url.searchParams.set("num", String(num));
    url.searchParams.set("hl", "fr");
    url.searchParams.set("gl", "ca");
    url.searchParams.set("api_key", key);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
    const data = await res.json();

    const results: string[] = [];
    const candidates = [
      ...(data.organic_results ?? []),
      ...(data.inline_shopping_results ?? []),
      ...(data.shopping_results ?? []),
    ];
    for (const r of candidates) {
      const u = r.link ?? r.product_link ?? r.source ?? null;
      if (!u) continue;
      if (domainAllowed(u)) results.push(u);
      if (results.length >= num) break;
    }
    return { q, num, results };
  },
});

const webSearchPreview = webSearchTool({
  searchContextSize: "medium",
  userLocation: { country: "CA", type: "approximate" },
});

// ---------- Output schema ----------
const ListingFinderSchema = z.object({
  title: z.string(),
  criteria: z.object({
    location: z.string(),
    priceMin: z.string(),
    priceMax: z.string(),
    beds: z.string(),
    baths: z.string(),
    type: z.string(),
    keywords: z.string(),
  }),
  typeOptions: z.array(z.object({ value: z.string(), label: z.string() })),
  bedsOptions: z.array(z.object({ value: z.string(), label: z.string() })),
  bathsOptions: z.array(z.object({ value: z.string(), label: z.string() })),
  hasResults: z.boolean(),
  resultsJson: z.string(),
});

// ---------- Agent ----------
const listingFinder = new Agent({
  name: "LISTING FINDER",
  instructions: `You are “Listings Finder”, a bilingual (FR first, then EN) real-estate agent assistant for Québec.

GOAL
- Given search criteria (location, budget, beds/baths, property type, keywords), browse public sites (Centris, Realtor.ca, Royal LePage, RE/MAX Québec, DuProprio) and return 5–12 currently-listed properties.
- For each property, include: MLS/Listing number (if present), URL, address (or building/area label), asking price (CAD), beds, baths, property type, and a one-line note.
- When multiple pages point to the same MLS, **dedupe** by MLS (keep the most complete record).

SAFETY & SOURCES
- Use only public information (no paywalled/forbidden content). Respect site TOS and robots (fetch gently).
- If MLS is not visible on a page, say “MLS non trouvé / MLS not found” instead of hallucinating.
- Never imply MLS/Centris insider access—these are public storefront pages.

STYLE
- Output FR first, then EN. Keep it concise and client-ready.
- If fewer than 3 matches, say so and offer a next step (expand area/price/filters).

The widget is expecting this data format:
{
  title: 'Québec Listings • Annonces Québec',
  criteria: { location: 'Montréal, QC', priceMin: '', priceMax: '', beds: '', baths: '', type: '', keywords: '' },
  typeOptions: [
    { value: '', label: 'Any type / Tout type' },
    { value: 'house', label: 'House / Maison' },
    { value: 'condo', label: 'Condo / Copropriété' },
    { value: 'multiplex', label: 'Multiplex / Plex' },
    { value: 'land', label: 'Land / Terrain' },
    { value: 'commercial', label: 'Commercial' }
  ],
  bedsOptions: [
    { value: '', label: 'Beds: Any / Chambres: Peu importe' },
    { value: '1', label: '1+' }, { value: '2', label: '2+' }, { value: '3', label: '3+' },
    { value: '4', label: '4+' }, { value: '5', label: '5+' }
  ],
  bathsOptions: [
    { value: '', label: 'Baths: Any / Salles de bain: Peu importe' },
    { value: '1', label: '1+' }, { value: '2', label: '2+' }, { value: '3', label: '3+' }
  ],
  hasResults: false,
  resultsJson: '```json\\n{\\n  "listings": [],\\n  "schema": { "mls": "string", "url": "string", "price": "number (CAD)", "note_en": "string", "note_fr": "string" }\\n}\\n```'
}

RULES
- Normalize incoming criteria; fill sensible defaults (ex: Laval, QC if missing).
- Prefer pages that (a) look like a listing detail and (b) show an MLS or listing ID.
- Don’t invent prices/addresses—leave null if not visible.
- Never exceed 12 listings unless asked.
`,
  model: "gpt-5",
  tools: [
    normalizeAndDedupeListings,
    extractListingInfo,
    fetchHtmlPage,
    searchRealEstateListings,
    webSearchPreview,
  ],
  outputType: ListingFinderSchema,
  modelSettings: {
    parallelToolCalls: true,
    reasoning: { effort: "low", summary: "auto" },
    store: true,
  },
});

// ---------- Workflow ----------
type WorkflowInput = {
  input_as_text: string;
  input_variables?: Record<string, string>;
};

export const runWorkflow = async (workflow: WorkflowInput) => {
  return await withTrace("Property matcher", async () => {
    // Merge variables into a helper preface so the agent can use them deterministically
    const variablesPreface =
      workflow.input_variables && Object.keys(workflow.input_variables).length
        ? `\n\n[VARIABLES]\n${JSON.stringify(workflow.input_variables)}`
        : "";

    const conversationHistory: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: (workflow.input_as_text ?? "") + variablesPreface }] },
    ];

    // Guardrails
    const guardrailsInputtext = workflow.input_as_text;
    const guardrailsResult = await runGuardrails(guardrailsInputtext, guardrailsConfig as any, context as any);
    const guardrailsHastripwire = guardrailsHasTripwire(guardrailsResult as any[]);
    if (guardrailsHastripwire) return buildGuardrailFailOutput(guardrailsResult as any[]);

    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_self_hosted_listing_finder",
      },
    });

    const resultTemp = await runner.run(listingFinder, [...conversationHistory]);
    if (!resultTemp.finalOutput) throw new Error("Agent result is undefined");

    return {
      output_text: JSON.stringify(resultTemp.finalOutput),
      output_parsed: resultTemp.finalOutput,
      // convenience: try to expose listings if your agent puts them inside resultsJson
    };
  });
};
