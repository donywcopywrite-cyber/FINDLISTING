const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";
const MAX_AGENT_STEPS = 6;

export type ListingCriteria = {
  location: string;
  priceMin: string;
  priceMax: string;
  beds: string;
  baths: string;
  type: string;
  keywords: string;
};

export type AgentListing = {
  mls?: string | null;
  url?: string | null;
  address?: string | null;
  price?: number | null;
  beds?: number | null;
  baths?: number | null;
  type?: string | null;
  note_en?: string | null;
  note_fr?: string | null;
  source?: string | null;
};

export type AgentSource = {
  title: string | null;
  url: string;
  details: string | null;
};

export type AgentRunResult = {
  listings: NormalizedListingInput[];
  sources: AgentSource[];
  notes_en: string | null;
  notes_fr: string | null;
  warnings: string[];
  rawResponse: string | null;
};

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

type ToolCall = {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
};

type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: any[];
  temperature?: number;
};

type ChatCompletionResponse = {
  choices: Array<{
    finish_reason: string;
    message: ChatMessage & { tool_calls?: ToolCall[] };
  }>;
};

export type NormalizedListingInput = AgentListing | Record<string, unknown>;

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    return fallback;
  }
}

function extractTextFromHtml(html: string) {
  const withoutScripts = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
  const withoutStyles = withoutScripts.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutStyles.replace(/<[^>]+>/g, " ");
  return withoutTags.replace(/\s+/g, " ").trim();
}

async function callOpenAI(request: ChatCompletionRequest, apiKey: string): Promise<ChatCompletionResponse> {
  const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      ...request,
      tool_choice: "auto",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  return data;
}

async function runTavilySearch(query: string, apiKey: string, maxResults: number) {
  const body = {
    api_key: apiKey,
    query,
    search_depth: "advanced",
    max_results: Math.min(Math.max(maxResults, 1), 10),
    include_images: false,
    include_answer: false,
  };

  const response = await fetch(process.env.TAVILY_API_URL || "https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tavily API error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((result: any) => ({
    title: result?.title || null,
    url: result?.url || null,
    snippet: result?.content || result?.snippet || null,
  }));
}

async function performWebSearch(args: Record<string, unknown>) {
  const query = typeof args?.query === "string" && args.query.trim() ? args.query.trim() : null;
  const maxResultsRaw = Number(args?.max_results ?? 6);
  const maxResults = Number.isFinite(maxResultsRaw) ? maxResultsRaw : 6;

  if (!query) {
    return { error: "query is required" };
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return { error: "TAVILY_API_KEY is not configured" };
  }

  try {
    const results = await runTavilySearch(query, apiKey, maxResults);
    return { query, results };
  } catch (error: any) {
    return { error: String(error?.message || error) };
  }
}

async function fetchListingPage(args: Record<string, unknown>) {
  const url = typeof args?.url === "string" ? args.url : null;
  if (!url) {
    return { error: "url is required" };
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          process.env.LISTING_AGENT_USER_AGENT ||
          "Mozilla/5.0 (compatible; ListingFinderBot/1.0; +https://example.com/bot)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      return { error: `Failed to fetch page (${response.status})` };
    }

    const html = await response.text();
    const text = extractTextFromHtml(html).slice(0, 9000);

    return {
      url,
      text,
      length: text.length,
    };
  } catch (error: any) {
    return { error: String(error?.message || error) };
  }
}

function buildSystemPrompt(criteria: ListingCriteria) {
  const criteriaSummary = [
    criteria.location ? `• Location: ${criteria.location}` : null,
    criteria.type ? `• Property type: ${criteria.type}` : null,
    criteria.priceMin || criteria.priceMax
      ? `• Budget: ${criteria.priceMin || "Any"} - ${criteria.priceMax || "Any"} CAD`
      : null,
    criteria.beds ? `• Bedrooms: ${criteria.beds}+` : null,
    criteria.baths ? `• Bathrooms: ${criteria.baths}+` : null,
    criteria.keywords ? `• Keywords: ${criteria.keywords}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `You are an expert bilingual (English and French) real estate research agent focused on the Greater Montreal Area (including Montreal, Laval, Longueuil, South Shore, and North Shore).
Your job is to find active residential real estate listings that match the user's request.
Use the available tools to search the public web, open promising results, and extract structured data.

When evaluating results:
- Prioritize reputable Canadian real estate sources (Realtor.ca, Centris.ca, Royal LePage, Sutton, etc.).
- Only report listings that are clearly located in Quebec within the Greater Montreal Area.
- Prefer the newest or most recently updated listings when multiple matches exist.
- Ensure that each listing includes its official MLS number (MLS®, Centris #, or listing ID) if available. If unavailable after verification, set the value to "MLS non trouvé / MLS not found".

When you have enough information, respond with **only** valid JSON using this structure:
{
  "listings": [
    {
      "mls": "string",
      "url": "https://...",
      "address": "Full street address, city",
      "price": 0,
      "beds": 0,
      "baths": 0,
      "type": "Property type",
      "note_en": "Short English summary highlighting key facts",
      "note_fr": "Courte description en français",
      "source": "Source name"
    }
  ],
  "notes_en": "Any important caveats or reminders in English",
  "notes_fr": "Notes importantes en français",
  "sources": [
    { "title": "Result title", "url": "https://..." }
  ]
}

If you cannot find any suitable listings, return empty arrays but still respect the JSON schema.
Criteria provided by the user:
${criteriaSummary || "• No additional filters provided"}`;
}

export async function runListingAgent(prompt: string, criteria: ListingCriteria): Promise<AgentRunResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      listings: [],
      sources: [],
      notes_en: null,
      notes_fr: null,
      warnings: ["OPENAI_API_KEY is not configured"],
      rawResponse: null,
    };
  }

  const systemPrompt = buildSystemPrompt(criteria);
  const tools = [
    {
      type: "function",
      function: {
        name: "search_listings",
        description:
          "Search the public web for Greater Montreal area real estate listings. Returns links, titles, and snippets for further review.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            max_results: {
              type: "integer",
              minimum: 1,
              maximum: 10,
              default: 6,
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fetch_listing_page",
        description:
          "Download a web page for a specific listing and return the cleaned text so you can extract MLS numbers, prices, and other facts.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
          },
          required: ["url"],
        },
      },
    },
  ];

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `User request: ${prompt}\nRemember to return only JSON.`,
    },
  ];

  const warnings: string[] = [];
  let iterations = 0;

  const toolExecutors: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
    search_listings: performWebSearch,
    fetch_listing_page: fetchListingPage,
  };

  while (iterations < MAX_AGENT_STEPS) {
    iterations += 1;

    let completion: ChatCompletionResponse;
    try {
      completion = await callOpenAI({
        model: DEFAULT_OPENAI_MODEL,
        messages,
        tools,
        temperature: 0.2,
      }, apiKey);
    } catch (error: any) {
      warnings.push(String(error?.message || error));
      break;
    }

    const choice = completion.choices?.[0];
    if (!choice) {
      warnings.push("OpenAI API returned no choices");
      break;
    }

    const message = choice.message || { role: "assistant", content: "" };
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: message.content || "",
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        const executor = toolExecutors[toolCall.function.name];
        let toolResult: Record<string, unknown> = { error: `Unknown tool ${toolCall.function.name}` };
        if (executor) {
          const args = safeJsonParse<Record<string, unknown>>(toolCall.function.arguments || "{}", {});
          toolResult = await executor(args);
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        });
      }
      continue;
    }

    if (choice.finish_reason === "stop" || choice.finish_reason === "length") {
      const rawContent = message.content || "";
      const parsed = safeJsonParse<Record<string, unknown>>(rawContent, {});
      const listingsRaw = Array.isArray(parsed.listings) ? parsed.listings : [];
      const sourcesRaw = Array.isArray(parsed.sources) ? parsed.sources : [];
      const listings = listingsRaw as NormalizedListingInput[];
      const sources = sourcesRaw
        .map((source) => {
          if (!source || typeof source !== "object") return null;
          const record = source as Record<string, unknown>;
          if (typeof record.url !== "string") return null;
          return {
            title: typeof record.title === "string" ? record.title : null,
            url: record.url,
            details: typeof record.details === "string" ? record.details : null,
          };
        })
        .filter((item): item is AgentSource => Boolean(item && item.url));

      return {
        listings,
        sources,
        notes_en: typeof parsed.notes_en === "string" ? parsed.notes_en : null,
        notes_fr: typeof parsed.notes_fr === "string" ? parsed.notes_fr : null,
        warnings,
        rawResponse: rawContent,
      };
    }

    if (choice.finish_reason === "content_filter") {
      warnings.push("OpenAI content filter blocked the response");
      break;
    }

    warnings.push(`Unexpected finish reason: ${choice.finish_reason}`);
    break;
  }

  return {
    listings: [],
    sources: [],
    notes_en: null,
    notes_fr: null,
    warnings,
    rawResponse: null,
  };
}
