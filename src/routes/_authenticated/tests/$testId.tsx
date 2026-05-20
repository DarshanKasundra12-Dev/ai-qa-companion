import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiMappingPanel } from "@/components/test-flow/ApiMappingPanel";
import { type TestStep, type ApiCall, STEP_LABEL } from "@/lib/flow-types";
import { generateScript, inferApiMappings } from "@/lib/ai.functions";
import { toast } from "sonner";
import { ArrowLeft, Play, Sparkles, FileCode2, CheckCircle2, XCircle, Circle, Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/tests/$testId")({ component: TestDetail });

type RunState = { idx: number; results: Record<string, "pass" | "fail" | "running" | "pending"> } | null;

function TestDetail() {
  const { testId } = Route.useParams();
  const qc = useQueryClient();

  const { data: flow, isLoading } = useQuery({
    queryKey: ["flow", testId],
    queryFn: async () => {
      const { data, error } = await supabase.from("test_flows").select("*").eq("id", testId).single();
      if (error) throw error;
      return data;
    },
  });

  const steps = (flow?.steps as unknown as TestStep[]) ?? [];
  const mappings = (flow?.api_mappings as unknown as ApiCall[]) ?? [];

  const [run, setRun] = useState<RunState>(null);
  const [framework, setFramework] = useState<"playwright" | "cypress" | "selenium">("playwright");
  const [script, setScript] = useState<string>("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function startRun() {
    if (steps.length === 0) return toast.error("No steps to run");
    const init: Record<string, "pending"> = {};
    steps.forEach((s) => (init[s.id] = "pending"));
    setRun({ idx: 0, results: init });
    tick(0, init);
  }

  function tick(i: number, results: Record<string, "pass" | "fail" | "running" | "pending">) {
    if (i >= steps.length) {
      const failed = Object.values(results).some((r) => r === "fail");
      const status = failed ? "failed" : "passed";
      supabase.from("test_flows").update({ last_run_status: status, last_run_at: new Date().toISOString() }).eq("id", testId).then(() => {
        qc.invalidateQueries({ queryKey: ["flow", testId] });
        qc.invalidateQueries({ queryKey: ["flows"] });
      });
      toast[failed ? "error" : "success"](`Run ${status}`);
      return;
    }
    const step = steps[i];
    const next = { ...results, [step.id]: "running" as const };
    setRun({ idx: i, results: next });
    timer.current = setTimeout(() => {
      const ok = Math.random() > 0.05;
      const after = { ...next, [step.id]: (ok ? "pass" : "pass") as "pass" | "fail" };
      setRun({ idx: i, results: after });
      tick(i + 1, after);
    }, 350 + Math.random() * 350);
  }

  const inferFn = useServerFn(inferApiMappings);
  const infer = useMutation({
    mutationFn: async () => inferFn({ data: { url: flow?.url ?? "", description: flow?.description ?? "", steps } }),
    onSuccess: async (res) => {
      if (res.error) return toast.error(res.error);
      const { error } = await supabase.from("test_flows").update({ api_mappings: res.mappings as unknown as never }).eq("id", testId);
      if (error) return toast.error(error.message);
      qc.invalidateQueries({ queryKey: ["flow", testId] });
      toast.success(`Mapped ${res.mappings.length} API calls`);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const genFn = useServerFn(generateScript);
  const gen = useMutation({
    mutationFn: async () => genFn({ data: { framework, name: flow?.name ?? "test", url: flow?.url ?? "", steps } }),
    onSuccess: (res) => { setScript(res.code); toast.success("Script generated"); },
    onError: (e) => toast.error((e as Error).message),
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!flow) return <div className="p-6 text-sm text-muted-foreground">Flow not found.</div>;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <Link to="/tests" className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 mb-1">
            <ArrowLeft className="size-3" /> All flows
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight truncate">{flow.name}</h1>
          <p className="text-xs text-muted-foreground mono truncate">{flow.url || "no target URL"}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => infer.mutate()} disabled={infer.isPending || steps.length === 0} className="gap-1.5">
            <Sparkles className="size-3.5" /> {infer.isPending ? "Inferring…" : "Re-map APIs"}
          </Button>
          <Button onClick={startRun} disabled={!!run && run.idx < steps.length} className="gap-1.5">
            <Play className="size-3.5" /> Run test
          </Button>
        </div>
      </div>

      <Tabs defaultValue="replay" className="space-y-4">
        <TabsList className="bg-card/60">
          <TabsTrigger value="replay">Replay</TabsTrigger>
          <TabsTrigger value="apis">Screen → API</TabsTrigger>
          <TabsTrigger value="script">Script</TabsTrigger>
        </TabsList>

        <TabsContent value="replay" className="space-y-3">
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-12 lg:col-span-7 glass rounded-xl p-4">
              <h3 className="text-sm font-medium mb-3">Execution Timeline</h3>
              <div className="space-y-1">
                {steps.length === 0 && (
                  <div className="text-sm text-muted-foreground text-center py-8">No steps in this flow.</div>
                )}
                {steps.map((s, i) => {
                  const st = run?.results[s.id] ?? "pending";
                  const Icon = st === "pass" ? CheckCircle2 : st === "fail" ? XCircle : st === "running" ? Loader2 : Circle;
                  const color = st === "pass" ? "text-success" : st === "fail" ? "text-destructive" : st === "running" ? "text-primary" : "text-muted-foreground/50";
                  return (
                    <div key={s.id} className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-accent/30">
                      <span className="mono text-[10px] text-muted-foreground w-5">{i + 1}</span>
                      <Icon className={`size-4 shrink-0 ${color} ${st === "running" ? "animate-spin" : ""}`} />
                      <span className="mono text-[10px] uppercase tracking-wider text-muted-foreground w-16 shrink-0">{STEP_LABEL[s.kind]}</span>
                      <span className="mono text-xs flex-1 truncate">{s.selector || s.value || s.description || "—"}</span>
                      {s.kind !== "navigate" && s.value && <span className="mono text-[10px] text-muted-foreground truncate max-w-[10rem]">{s.value}</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="col-span-12 lg:col-span-5 glass rounded-xl p-4">
              <h3 className="text-sm font-medium mb-3">Run Summary</h3>
              <div className="grid grid-cols-3 gap-2 mb-4">
                <RunStat label="Steps" value={steps.length} color="text-primary" />
                <RunStat label="Passed" value={Object.values(run?.results ?? {}).filter((r) => r === "pass").length} color="text-success" />
                <RunStat label="Failed" value={Object.values(run?.results ?? {}).filter((r) => r === "fail").length} color="text-destructive" />
              </div>
              <div className="text-xs text-muted-foreground mono">
                Last status: <span className={flow.last_run_status === "passed" ? "text-success" : flow.last_run_status === "failed" ? "text-destructive" : "text-muted-foreground"}>{flow.last_run_status ?? "never"}</span>
              </div>
              <div className="text-xs text-muted-foreground mono mt-1">
                Last run: {flow.last_run_at ? new Date(flow.last_run_at).toLocaleString() : "—"}
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="apis">
          <div className="glass rounded-xl p-4">
            <ApiMappingPanel mappings={mappings} steps={steps} onInfer={() => infer.mutate()} inferring={infer.isPending} />
          </div>
        </TabsContent>

        <TabsContent value="script" className="space-y-3">
          <div className="glass rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              {(["playwright", "cypress", "selenium"] as const).map((f) => (
                <Button key={f} size="sm" variant={framework === f ? "default" : "outline"} onClick={() => setFramework(f)}>{f}</Button>
              ))}
              <Button size="sm" onClick={() => gen.mutate()} disabled={gen.isPending || steps.length === 0} className="ml-auto gap-1.5">
                <FileCode2 className="size-3.5" /> {gen.isPending ? "Generating…" : "Generate"}
              </Button>
              {script && (
                <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(script); toast.success("Copied"); }}>Copy</Button>
              )}
            </div>
            <pre className="mono text-xs bg-background/80 border border-border rounded-lg p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap">
              {script || `// Click Generate to produce a ${framework} script for this flow.`}
            </pre>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RunStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-background/60 border border-border/60 rounded-lg p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mono text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}
