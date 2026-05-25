import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { io, Socket } from "socket.io-client";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiMappingPanel } from "@/components/test-flow/ApiMappingPanel";
import { type TestStep, type ApiCall, STEP_LABEL } from "@/lib/flow-types";
import { generateScript, inferApiMappings } from "@/lib/ai.functions";
import { toast } from "sonner";
import {
  ArrowLeft, Play, Square, Sparkles, FileCode2, CheckCircle2, XCircle,
  Circle, Loader2, Monitor, Terminal, Zap, Check, Info, Gauge
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/tests/$testId")({ component: TestDetail });

type LogEntry = { timestamp: string; level: "info" | "warn" | "pass" | "fail"; message: string };

function TestDetail() {
  const { testId } = Route.useParams();
  const qc = useQueryClient();
  const socketRef = useRef<Socket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

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

  const [stepResults, setStepResults] = useState<Record<string, "pass" | "fail" | "running" | "pending" | "healing">>({});
  const [isRunning, setIsRunning] = useState(false);
  const [slowMo, setSlowMo] = useState(800);
  const [screencastFrame, setScreencastFrame] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [framework, setFramework] = useState<"playwright" | "cypress" | "selenium">("playwright");
  const [script, setScript] = useState<string>("");
  const [capturedApis, setCapturedApis] = useState<ApiCall[]>([]);
  const [hasNewCaptures, setHasNewCaptures] = useState(false);
  const [viewingCaptured, setViewingCaptured] = useState(false);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Cleanup socket on unmount
  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, []);

  const startRun = useCallback(() => {
    if (steps.length === 0) return toast.error("No steps to run");
    if (!flow?.url) return toast.error("No target URL set for this flow");

    // Reset state
    const init: Record<string, "pending"> = {};
    steps.forEach((s) => (init[s.id] = "pending"));
    setStepResults(init);
    setIsRunning(true);
    setScreencastFrame(null);
    setLogs([]);
    setCapturedApis([]);
    setHasNewCaptures(false);
    setViewingCaptured(false);

    // Connect to automation server
    const socket = io("http://localhost:4000");
    socketRef.current = socket;

    socket.on("connect", () => {
      setLogs((prev) => [...prev, { timestamp: new Date().toISOString(), level: "info", message: "Connected to automation server" }]);
      socket.emit("run_flow", { url: flow.url, steps, slowMo });
    });

    socket.on("connect_error", () => {
      setLogs((prev) => [...prev, { timestamp: new Date().toISOString(), level: "fail", message: "Cannot connect to automation server at localhost:4000. Is it running?" }]);
      toast.error("Cannot connect to automation server");
      setIsRunning(false);
    });

    socket.on("run_log", (entry: LogEntry) => {
      setLogs((prev) => [...prev, entry]);
    });

    socket.on("screencast_frame", ({ data }: { data: string }) => {
      setScreencastFrame(data);
    });

    socket.on("api_call_captured", (apiCall: ApiCall) => {
      setCapturedApis((prev) => [...prev, apiCall]);
    });

    socket.on("step_running", ({ stepId }: { stepId: string }) => {
      setStepResults((prev) => ({ ...prev, [stepId]: "running" }));
    });

    socket.on("step_healing", ({ stepId }: { stepId: string }) => {
      setStepResults((prev) => ({ ...prev, [stepId]: "healing" }));
    });

    socket.on("step_healed", ({ stepId }: { stepId: string; oldSelector: string; newSelector: string }) => {
      setStepResults((prev) => ({ ...prev, [stepId]: "running" }));
    });

    socket.on("step_completed", ({ stepId, status }: { stepId: string; status: "pass" | "fail" }) => {
      setStepResults((prev) => ({ ...prev, [stepId]: status }));
    });

    socket.on("run_finished", async ({ success, error: errMsg }: { success: boolean; error?: string }) => {
      setIsRunning(false);
      const status = success ? "passed" : "failed";
      if (errMsg) {
        setLogs((prev) => [...prev, { timestamp: new Date().toISOString(), level: "fail", message: errMsg }]);
      }
      toast[success ? "success" : "error"](`Run ${status}`);

      // Update Supabase
      await supabase.from("test_flows").update({
        last_run_status: status,
        last_run_at: new Date().toISOString()
      }).eq("id", testId);
      qc.invalidateQueries({ queryKey: ["flow", testId] });
      qc.invalidateQueries({ queryKey: ["flows"] });

      // Check if we captured APIs
      setCapturedApis((latest) => {
        if (latest.length > 0) {
          setHasNewCaptures(true);
          setViewingCaptured(true);
        }
        return latest;
      });

      // Disconnect after a short delay to allow final frames
      setTimeout(() => {
        socket.disconnect();
        socketRef.current = null;
      }, 1000);
    });
  }, [steps, flow, testId, qc, slowMo]);

  const stopRun = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setIsRunning(false);
    setLogs((prev) => [...prev, { timestamp: new Date().toISOString(), level: "warn", message: "Run stopped by user" }]);
    toast.info("Run stopped");
  }, []);

  const applyCapturedApis = async () => {
    if (capturedApis.length === 0) return;
    const { error } = await supabase.from("test_flows").update({ api_mappings: capturedApis as unknown as never }).eq("id", testId);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success(`Successfully saved ${capturedApis.length} real API mappings!`);
      setHasNewCaptures(false);
      setViewingCaptured(false);
      qc.invalidateQueries({ queryKey: ["flow", testId] });
    }
  };

  const discardCapturedApis = () => {
    setCapturedApis([]);
    setHasNewCaptures(false);
    setViewingCaptured(false);
    toast.info("Captured API mappings discarded");
  };

  const removeSavedMapping = async (id: string) => {
    const next = mappings.filter((m) => m.id !== id);
    const { error } = await supabase.from("test_flows").update({ api_mappings: next as unknown as never }).eq("id", testId);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["flow", testId] });
    toast.success("Mapping removed");
  };

  const removeCapturedMapping = (id: string) => {
    setCapturedApis((prev) => prev.filter((m) => m.id !== id));
    toast.success("Captured mapping removed");
  };

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

  const passCount = Object.values(stepResults).filter((r) => r === "pass").length;
  const failCount = Object.values(stepResults).filter((r) => r === "fail").length;

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
          <Select
            value={slowMo.toString()}
            onValueChange={(val) => setSlowMo(parseInt(val))}
            disabled={isRunning}
          >
            <SelectTrigger className="w-[145px] h-9 gap-1.5 bg-background border-border/80 text-xs font-medium cursor-pointer">
              <Gauge className="size-3.5 text-muted-foreground" />
              <SelectValue placeholder="Execution Speed" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0" className="text-xs">Fast (0ms)</SelectItem>
              <SelectItem value="800" className="text-xs">Normal (800ms)</SelectItem>
              <SelectItem value="1500" className="text-xs">Slow (1.5s)</SelectItem>
              <SelectItem value="3000" className="text-xs">Stepped (3.0s)</SelectItem>
            </SelectContent>
          </Select>
          {isRunning ? (
            <Button variant="destructive" onClick={stopRun} className="gap-1.5">
              <Square className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button onClick={startRun} disabled={steps.length === 0} className="gap-1.5">
              <Play className="size-3.5" /> Run test
            </Button>
          )}
        </div>
      </div>

      <Tabs defaultValue="replay" className="space-y-4">
        <TabsList className="bg-card/60">
          <TabsTrigger value="replay"><Monitor className="size-3.5 mr-1.5" /> Replay</TabsTrigger>
          <TabsTrigger value="apis">Screen → API</TabsTrigger>
          <TabsTrigger value="script">Script</TabsTrigger>
        </TabsList>

        <TabsContent value="replay" className="space-y-3">
          <div className="grid grid-cols-12 gap-4">
            {/* Live browser screen */}
            <div className="col-span-12 lg:col-span-7 glass rounded-xl p-3 flex flex-col">
              <div className="flex items-center gap-2 mb-2">
                <Monitor className="size-4 text-primary" />
                <h3 className="text-sm font-medium">Live Browser</h3>
                {isRunning && (
                  <span className="ml-auto flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-emerald-400 font-medium">
                    <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Live
                  </span>
                )}
              </div>
              <div className="relative flex-1 min-h-[350px] bg-black/40 rounded-lg overflow-hidden border border-border/30">
                {screencastFrame ? (
                  <img
                    src={`data:image/jpeg;base64,${screencastFrame}`}
                    alt="Live browser"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-2">
                    <Monitor className="size-10 opacity-30" />
                    <span className="text-xs">
                      {isRunning ? "Waiting for screencast…" : "Click \"Run test\" to see the live browser"}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Execution timeline + logs */}
            <div className="col-span-12 lg:col-span-5 flex flex-col gap-4">
              {/* Timeline */}
              <div className="glass rounded-xl p-4 flex-1">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium">Execution Timeline</h3>
                  <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span className="text-success">{passCount} pass</span>
                    <span className="text-destructive">{failCount} fail</span>
                    <span>{steps.length} total</span>
                  </div>
                </div>
                <div className="space-y-0.5 max-h-[250px] overflow-y-auto pr-1">
                  {steps.length === 0 && (
                    <div className="text-sm text-muted-foreground text-center py-8">No steps in this flow.</div>
                  )}
                  {steps.map((s, i) => {
                    const st = stepResults[s.id] ?? "pending";
                    const Icon = st === "pass" ? CheckCircle2 : st === "fail" ? XCircle : st === "running" ? Loader2 : st === "healing" ? Zap : Circle;
                    const color = st === "pass" ? "text-success"
                      : st === "fail" ? "text-destructive"
                      : st === "running" ? "text-primary"
                      : st === "healing" ? "text-amber-400"
                      : "text-muted-foreground/50";
                    return (
                      <div key={s.id} className={`flex items-center gap-2.5 px-2 py-1.5 rounded transition-colors ${st === "running" || st === "healing" ? "bg-primary/5" : "hover:bg-accent/30"}`}>
                        <span className="mono text-[10px] text-muted-foreground w-5">{i + 1}</span>
                        <Icon className={`size-3.5 shrink-0 ${color} ${st === "running" ? "animate-spin" : ""} ${st === "healing" ? "animate-pulse" : ""}`} />
                        <span className="mono text-[10px] uppercase tracking-wider text-muted-foreground w-14 shrink-0">{STEP_LABEL[s.kind]}</span>
                        <span className="mono text-xs flex-1 truncate">{s.selector || s.value || s.description || "—"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Run Summary */}
              <div className="glass rounded-xl p-4">
                <h3 className="text-sm font-medium mb-2">Run Summary</h3>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <RunStat label="Steps" value={steps.length} color="text-primary" />
                  <RunStat label="Passed" value={passCount} color="text-success" />
                  <RunStat label="Failed" value={failCount} color="text-destructive" />
                </div>
                <div className="text-xs text-muted-foreground mono">
                  Last status: <span className={flow.last_run_status === "passed" ? "text-success" : flow.last_run_status === "failed" ? "text-destructive" : "text-muted-foreground"}>{flow.last_run_status ?? "never"}</span>
                </div>
                <div className="text-xs text-muted-foreground mono mt-0.5">
                  Last run: {flow.last_run_at ? new Date(flow.last_run_at).toLocaleString() : "—"}
                </div>
              </div>

              {/* Log Console */}
              <div className="glass rounded-xl p-4 flex flex-col">
                <div className="flex items-center gap-2 mb-2">
                  <Terminal className="size-4 text-primary" />
                  <h3 className="text-sm font-medium">Execution Log</h3>
                  {logs.length > 0 && (
                    <button
                      onClick={() => setLogs([])}
                      className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="bg-black/50 rounded-lg border border-border/30 p-2 max-h-[200px] overflow-y-auto font-mono text-[11px] leading-relaxed">
                  {logs.length === 0 ? (
                    <div className="text-muted-foreground/50 text-center py-4">No logs yet</div>
                  ) : (
                    logs.map((entry, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="text-muted-foreground/60 shrink-0">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </span>
                        <span className={
                          entry.level === "fail" ? "text-red-400"
                          : entry.level === "pass" ? "text-emerald-400"
                          : entry.level === "warn" ? "text-amber-400"
                          : "text-muted-foreground"
                        }>
                          {entry.message}
                        </span>
                      </div>
                    ))
                  )}
                  <div ref={logEndRef} />
                </div>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="apis">
          <div className="space-y-4 animate-fade-in">
            {hasNewCaptures && (
              <div className="glass border-emerald-500/30 bg-emerald-500/5 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-[0_4px_20px_rgba(16,185,129,0.05)] border-l-4 border-l-emerald-500">
                <div className="flex gap-3">
                  <div className="size-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center shrink-0">
                    <Zap className="size-4 text-emerald-400" />
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-emerald-400">Real API Calls Intercepted!</h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      We captured {capturedApis.length} real network requests during the last test execution. Apply them to save them as the actual truth.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button size="sm" variant="outline" onClick={discardCapturedApis} className="text-muted-foreground border-border/80 hover:bg-card">
                    Discard
                  </Button>
                  <Button size="sm" onClick={applyCapturedApis} className="bg-emerald-600 hover:bg-emerald-500 text-white border-0 gap-1.5 shadow-[0_0_15px_rgba(16,185,129,0.25)]">
                    <Check className="size-3.5" /> Apply Mappings
                  </Button>
                </div>
              </div>
            )}

            <div className="glass rounded-xl p-4 space-y-4">
              {capturedApis.length > 0 && (
                <div className="flex items-center gap-1.5 p-0.5 bg-background/50 border border-border/60 rounded-lg w-fit">
                  <button
                    onClick={() => setViewingCaptured(false)}
                    className={`text-xs px-3 py-1.5 rounded-md font-medium transition-all ${
                      !viewingCaptured
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Saved Mappings ({mappings.length})
                  </button>
                  <button
                    onClick={() => setViewingCaptured(true)}
                    className={`text-xs px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5 ${
                      viewingCaptured
                        ? "bg-card text-emerald-400 shadow-sm"
                        : "text-muted-foreground hover:text-emerald-400"
                    }`}
                  >
                    Captured Real ({capturedApis.length})
                    <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  </button>
                </div>
              )}

              <ApiMappingPanel
                mappings={viewingCaptured ? capturedApis : mappings}
                steps={steps}
                onRemove={viewingCaptured ? removeCapturedMapping : removeSavedMapping}
                onInfer={viewingCaptured ? undefined : () => infer.mutate()}
                inferring={infer.isPending}
              />
            </div>
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

