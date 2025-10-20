import { createServer } from "http";
import { runWorkflow } from "../main.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type RequestBody = {
  input_as_text?: JsonValue;
  input_variables?: Record<string, JsonValue>;
};

const server = createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid request" }));
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "listing-finder-agent" }));
    return;
  }

  if (req.method === "POST" && req.url === "/runWorkflow") {
    const chunks: string[] = [];
    let total = 0;
    req
      .on("data", (chunk: any) => {
        const piece = typeof chunk === "string" ? chunk : String(chunk ?? "");
        total += piece.length;
        if (total > 2 * 1024 * 1024) {
          req.destroy();
        } else {
          chunks.push(piece);
        }
      })
      .on("end", async () => {
        try {
          const bodyRaw = chunks.join("") || "{}";
          const body = JSON.parse(bodyRaw) as RequestBody;
          if (typeof body.input_as_text !== "string" || !body.input_as_text.trim()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "input_as_text (string) is required" }));
            return;
          }

          const data = await runWorkflow({
            input_as_text: body.input_as_text,
            input_variables: body.input_variables as Record<string, unknown> | undefined,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        } catch (error: any) {
          console.error(error);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error?.message ?? error) }));
        }
      });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const PORT = Number(process.env.PORT ?? 3000);
server.listen(PORT, () => {
  console.log(`Listing Finder listening on :${PORT}`);
});
