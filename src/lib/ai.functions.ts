import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const StepSchema = z.object({
  id: z.string(),
  kind: z.enum(["navigate", "click", "input", "wait", "assert", "scroll"]),
  selector: z.string().optional(),
  value: z.string().optional(),
  description: z.string().optional(),
});

const InferSchema = z.object({
  url: z.string().max(2000).optional().default(""),
  description: z.string().max(2000).optional().default(""),
  steps: z.array(StepSchema).max(100),
});

async function callGateway(messages: Array<{ role: string; content: string }>, opts?: { json?: boolean }) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("AI gateway not configured (LOVABLE_API_KEY missing)");
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (res.status === 429) throw new Error("AI rate limit exceeded. Try again shortly.");
  if (res.status === 402) throw new Error("AI credits exhausted. Add credits in workspace settings.");
  if (!res.ok) throw new Error(`AI error ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

export const inferApiMappings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InferSchema.parse(input))
  .handler(async ({ data }) => {
    const sys = `You are a senior QA engineer. Given a user-recorded UI test flow against a website, infer the most likely backend API calls that each step would trigger. Return STRICT JSON only.`;
    const user = `Website URL: ${data.url || "(unspecified)"}\nDescription: ${data.description || "(none)"}\nSteps:\n${data.steps
      .map((s, i) => `${i + 1}. [${s.kind}] selector=${s.selector ?? "—"} value=${s.value ?? "—"} ${s.description ? `// ${s.description}` : ""}`)
      .join("\n")}

Return JSON exactly like:
{"mappings":[{"id":"a1","method":"POST","url":"/api/v1/auth/login","status":200,"durationMs":210,"triggeredByStepId":"<step-id-or-null>","payload":"{\\"email\\":\\"...\\"}","response":"{\\"token\\":\\"...\\"}"}]}

Rules: Only include APIs you're confident about. Use realistic paths matching the domain context. Reference triggeredByStepId using the step's id. Keep payloads compact. Max 12 mappings.`;

    const raw = await callGateway(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { json: true },
    );

    try {
      const parsed = JSON.parse(raw) as { mappings?: unknown[] };
      const ids = new Set(data.steps.map((s) => s.id));
      const Out = z.array(
        z.object({
          id: z.string(),
          method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
          url: z.string(),
          status: z.number().int().optional(),
          durationMs: z.number().int().optional(),
          triggeredByStepId: z.string().nullable().optional(),
          payload: z.string().optional(),
          response: z.string().optional(),
        }),
      );
      const cleaned = Out.parse(parsed.mappings ?? []).map((m) => ({
        ...m,
        triggeredByStepId: m.triggeredByStepId && ids.has(m.triggeredByStepId) ? m.triggeredByStepId : null,
      }));
      return { mappings: cleaned, error: null as string | null };
    } catch (e) {
      return { mappings: [], error: `AI returned malformed output: ${(e as Error).message}` };
    }
  });

const GenSchema = z.object({
  framework: z.enum(["playwright", "cypress", "selenium"]),
  url: z.string().max(2000).optional().default(""),
  name: z.string().max(200),
  steps: z.array(StepSchema).max(100),
});

export const generateScript = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => GenSchema.parse(input))
  .handler(async ({ data }) => {
    const sys = `You are a senior QA automation engineer. Generate a production-ready ${data.framework} test in JavaScript. Use stable selectors, explicit waits, assertions, and clear comments. Return ONLY the code, no markdown fences, no prose.`;
    const user = `Test name: ${data.name}\nTarget URL: ${data.url || "(none)"}\nSteps:\n${data.steps
      .map((s, i) => `${i + 1}. [${s.kind}] selector=${s.selector ?? "—"} value=${s.value ?? "—"} ${s.description ? `// ${s.description}` : ""}`)
      .join("\n")}`;
    const code = await callGateway([
      { role: "system", content: sys },
      { role: "user", content: user },
    ]);
    return { code: code.replace(/^```[a-z]*\n?|\n?```$/g, "").trim() };
  });
