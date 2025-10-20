import { runGuardrails } from "./guardrails.js";

// ---------- Config ----------
const DEFAULT_LOCATION = "Laval, QC";
const MAX_LISTINGS = 12;

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
const context = {};

function guardrailsHasTripwire(results: any[]) {
  return (results ?? []).some((r) => r?.tripwireTriggered === true);
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

function toCleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

type NormalizedListing = {
  mls: string;
  url: string | null;
  address: string | null;
  price: number | null;
  beds: number | null;
  baths: number | null;
  type: string | null;
  note_fr: string | null;
  note_en: string | null;
};

function normalizeAndDedupeListings(items: unknown[]): NormalizedListing[] {
  const seen = new Map<string, number>();
  const out: NormalizedListing[] = [];

  for (const item of items ?? []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, any>;

    const mlsRaw =
      first(record.mls, record.MLS, record.listingId, record.listing_id, record["MLS®"]) ?? null;
    const mls = mlsRaw ? String(mlsRaw).trim() : null;

    const url = record.url ? String(record.url).trim() : null;
    const address = record.address ? String(record.address).trim() : null;
    const beds =
      record.beds != null ? Number(String(record.beds).replace(/[^\d]/g, "")) : null;
    const baths =
      record.baths != null ? Number(String(record.baths).replace(/[^\d.]/g, "")) : null;
    const type = record.type ? String(record.type).trim() : null;
    const note_fr = record.note_fr ? String(record.note_fr).trim() : null;
    const note_en = record.note_en ? String(record.note_en).trim() : null;

    const price =
      record.price != null
        ? Number(record.price)
        : numberFromPriceLike(first(record.priceText, record.price_str, record.askingPrice));

    const normalized: NormalizedListing = {
      mls: mls ?? "MLS non trouvé / MLS not found",
      url,
      address,
      price: price ?? null,
      beds,
      baths,
      type,
      note_fr: note_fr ?? null,
      note_en: note_en ?? null,
    };

    const key = mls ? `MLS:${mls.toUpperCase()}` : url ? `URL:${url}` : `IDX:${out.length}`;
    if (!seen.has(key)) {
      seen.set(key, out.length);
      out.push(normalized);
    } else {
      const idx = seen.get(key)!;
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

    if (out.length >= MAX_LISTINGS) break;
  }

  return out.slice(0, MAX_LISTINGS);
}

function buildResultsJson(listings: NormalizedListing[]) {
  const payload = {
    listings,
    schema: {
      mls: "string",
      url: "string",
      price: "number (CAD)",
      note_en: "string",
      note_fr: "string",
    },
  };
  const body = JSON.stringify(payload, null, 2);
  return "'" + "```json\n" + body + "\n```'";
}

const TYPE_OPTIONS = [
  { value: "", label: "Any type / Tout type" },
  { value: "house", label: "House / Maison" },
  { value: "condo", label: "Condo / Copropriété" },
  { value: "multiplex", label: "Multiplex / Plex" },
  { value: "land", label: "Land / Terrain" },
  { value: "commercial", label: "Commercial" },
];

const BEDS_OPTIONS = [
  { value: "", label: "Beds: Any / Chambres: Peu importe" },
  { value: "1", label: "1+" },
  { value: "2", label: "2+" },
  { value: "3", label: "3+" },
  { value: "4", label: "4+" },
  { value: "5", label: "5+" },
];

const BATHS_OPTIONS = [
  { value: "", label: "Baths: Any / Salles de bain: Peu importe" },
  { value: "1", label: "1+" },
  { value: "2", label: "2+" },
  { value: "3", label: "3+" },
];

// ---------- Workflow ----------
type WorkflowInput = {
  input_as_text: string;
  input_variables?: Record<string, unknown>;
};

export const runWorkflow = async (workflow: WorkflowInput) => {
  const guardrailsInputtext = workflow.input_as_text ?? "";
  const guardrailsResult = await runGuardrails(guardrailsInputtext, guardrailsConfig as any, context as any);
  if (guardrailsHasTripwire(guardrailsResult as any[])) {
    return buildGuardrailFailOutput(guardrailsResult as any[]);
  }

  const variables = workflow.input_variables ?? {};
  const criteria = {
    location: toCleanString(variables.location) || DEFAULT_LOCATION,
    priceMin: toCleanString(variables.priceMin),
    priceMax: toCleanString(variables.priceMax),
    beds: toCleanString(variables.beds),
    baths: toCleanString(variables.baths),
    type: toCleanString(variables.type),
    keywords: toCleanString(variables.keywords || workflow.input_as_text),
  };

  const listingsInput = Array.isArray((variables as any).listings) ? (variables as any).listings : [];
  const listings = normalizeAndDedupeListings(listingsInput);

  const output = {
    title: "Québec Listings • Annonces Québec",
    criteria,
    typeOptions: TYPE_OPTIONS,
    bedsOptions: BEDS_OPTIONS,
    bathsOptions: BATHS_OPTIONS,
    hasResults: listings.length > 0,
    resultsJson: buildResultsJson(listings),
  };

  return {
    output_text: JSON.stringify(output),
    output_parsed: output,
  };
};
