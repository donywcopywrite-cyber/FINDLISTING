# Listing Finder Agent

A lightweight Node.js service that exposes a workflow endpoint for researching
Greater Montreal real estate listings. The service runs an OpenAI-powered agent
that performs web searches, fetches individual listing pages, and returns
structured data including MLS numbers, bilingual summaries, and source links.

## Requirements

- Node.js 20+
- Environment variables:
  - `OPENAI_API_KEY` – required for all agent runs
  - `TAVILY_API_KEY` – required for web search via Tavily
  - `OPENAI_MODEL` (optional) – defaults to `gpt-4o-mini`
  - `OPENAI_API_BASE` (optional) – override the OpenAI REST endpoint
  - `TAVILY_API_URL` (optional) – override the Tavily REST endpoint
  - `LISTING_AGENT_USER_AGENT` (optional) – custom User-Agent when fetching pages

## Development

```bash
npm run build
npm start
```

This compiles the TypeScript sources and starts an HTTP server (defaults to
`PORT=3000`). The server exposes:

- `GET /` – health check
- `POST /runWorkflow` – runs the listing finder agent

Example request:

```bash
curl -X POST http://localhost:3000/runWorkflow \
  -H "Content-Type: application/json" \
  -d '{
        "input_as_text": "condos with river view",
        "input_variables": {
          "location": "Montreal, QC",
          "priceMax": "750000",
          "beds": "2"
        }
      }'
```

The response contains:

- `output_text` – serialized JSON string
- `output_parsed` – parsed object with listings, bilingual notes, sources, and
  guardrail status

## Deploying to Render

1. Create a new **Web Service** from your repository.
2. Use the following build & start commands:
   - Build: `npm run build`
   - Start: `npm start`
3. Set the required environment variables (`OPENAI_API_KEY`, `TAVILY_API_KEY`,
   and optional overrides) in the Render dashboard.
4. Ensure the service listens on the provided `PORT` (already handled by the
   included HTTP server).

Once deployed, POST requests to `/runWorkflow` will trigger the agent to search
for current Greater Montreal listings and return detailed MLS information.
