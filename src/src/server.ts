import express from "express";
import { runWorkflow } from "./main.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.json({ ok: true, service: "listing-finder-agent" }));

app.post("/runWorkflow", async (req, res) => {
  try {
    const { input_as_text, input_variables } = req.body ?? {};
    if (typeof input_as_text !== "string" || !input_as_text.trim()) {
      return res.status(400).json({ error: "input_as_text (string) is required" });
    }
    const data = await runWorkflow({ input_as_text, input_variables });
    return res.json(data);
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`Listing Finder listening on :${PORT}`);
});
