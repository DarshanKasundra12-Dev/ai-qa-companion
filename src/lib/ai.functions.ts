import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { Groq } from "groq-sdk";

import fs from "node:fs";
import path from "node:path";

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
  let key = process.env.GEMINI_API_KEY || process.env.LOVABLE_API_KEY;

  // Try to load dynamically from .env to avoid needing a server restart
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        const parts = line.split("=");
        if (parts.length >= 2) {
          const name = parts[0].trim();
          let val = parts.slice(1).join("=").trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (name === "GEMINI_API_KEY" && val) {
            key = val;
            break;
          }
        }
      }
    }
  } catch (e) {
    // ignore
  }

  // Fallback to meta env if still not found or not starting with gsk_
  if ((!key || !key.startsWith("gsk_")) && (import.meta as any).env?.VITE_GEMINI_API_KEY) {
    key = (import.meta as any).env.VITE_GEMINI_API_KEY;
  }

  if (!key) throw new Error("GEMINI_API_KEY not configured in .env");

  // Groq API Key handler
  if (key.startsWith("gsk_")) {
    const groq = new Groq({ apiKey: key });
    const chatCompletion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: messages as any,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    });
    return chatCompletion.choices?.[0]?.message?.content ?? "";
  }

  // If using a Lovable/OpenAI compatible key, fallback to that endpoint
  if (key.startsWith("sk-")) {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages,
        ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`AI error ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  }

  /* GEMINI CODE (Commented Out)
  // Otherwise, use native Google Gemini API directly
  const geminiMessages = messages.map(m => ({
    role: m.role === "system" ? "user" : m.role, // Gemini system instructions work differently, simplest is treating all as user/model. For simplicity, we just format as user.
    parts: [{ text: m.content }]
  }));
  
  // To simulate 'system' messages in Gemini REST, we can just prepend it or combine it if needed, but for our simple prompt, mapping works.
  const combinedText = messages.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join("\n\n");

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: combinedText }] }],
      ...(opts?.json ? { generationConfig: { responseMimeType: "application/json" } } : {})
    })
  });

  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  */
  throw new Error("No Groq key configured");
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

const AskAiSchema = z.object({
  query: z.string().max(4000),
  targetUrl: z.string().max(2000).optional(),
  selectedElement: z.object({
    tagName: z.string().optional().nullable(),
    id: z.string().optional().nullable(),
    className: z.string().optional().nullable(),
    text: z.string().optional().nullable(),
  }).optional().nullable(),
});

export const askAiAssistant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => AskAiSchema.parse(input))
  .handler(async ({ data }) => {
    const elPrompt = data.selectedElement
      ? `Currently selected element: <${data.selectedElement.tagName?.toLowerCase()}> id="${data.selectedElement.id || ''}" class="${data.selectedElement.className || ''}" text="${data.selectedElement.text || ''}"`
      : '';
    const userPrompt = `You are a QA automation expert. The user is inspecting a webpage at "${data.targetUrl || '(unknown)'}". Answer concisely:\n\n${data.query}\n\n${elPrompt}`;
    const response = await callGateway([
      { role: "user", content: userPrompt }
    ]);
    return { response };
  });
