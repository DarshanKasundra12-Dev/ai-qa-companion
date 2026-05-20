import { type ApiCall, type TestStep } from "@/lib/flow-types";
import { Network, Sparkles, ArrowRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

const METHOD_COLOR: Record<string, string> = {
  GET: "text-info border-info/40 bg-info/10",
  POST: "text-success border-success/40 bg-success/10",
  PUT: "text-warning border-warning/40 bg-warning/10",
  PATCH: "text-warning border-warning/40 bg-warning/10",
  DELETE: "text-destructive border-destructive/40 bg-destructive/10",
};

export function ApiMappingPanel({
  mappings,
  steps,
  onRemove,
  onInfer,
  inferring,
}: {
  mappings: ApiCall[];
  steps: TestStep[];
  onRemove?: (id: string) => void;
  onInfer?: () => void;
  inferring?: boolean;
}) {
  const stepById = new Map(steps.map((s) => [s.id, s]));
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Network className="size-4 text-primary" /> Screen → API Mapping
          <span className="text-xs text-muted-foreground mono">({mappings.length})</span>
        </h3>
        {onInfer && (
          <Button size="sm" variant="outline" onClick={onInfer} disabled={inferring} className="gap-1.5">
            <Sparkles className="size-3.5" />
            {inferring ? "Analyzing…" : "AI Infer APIs"}
          </Button>
        )}
      </div>

      {mappings.length === 0 ? (
        <div className="text-center text-xs text-muted-foreground py-8 border border-dashed border-border rounded-lg">
          No API mappings yet. Click <span className="text-primary">AI Infer APIs</span> to map steps to backend calls.
        </div>
      ) : (
        <div className="glass rounded-lg overflow-hidden">
          <div className="divide-y divide-border/60">
            {mappings.map((m) => {
              const step = m.triggeredByStepId ? stepById.get(m.triggeredByStepId) : null;
              return (
                <div key={m.id} className="px-3 py-2.5 hover:bg-accent/30">
                  <div className="flex items-center gap-2">
                    <span className={`mono text-[10px] px-1.5 py-0.5 rounded border ${METHOD_COLOR[m.method] ?? "border-border"}`}>{m.method}</span>
                    <span className="mono text-xs flex-1 truncate">{m.url}</span>
                    {typeof m.status === "number" && (
                      <span className={`mono text-[10px] ${m.status < 300 ? "text-success" : m.status < 500 ? "text-warning" : "text-destructive"}`}>{m.status}</span>
                    )}
                    {typeof m.durationMs === "number" && (
                      <span className="mono text-[10px] text-muted-foreground">{m.durationMs}ms</span>
                    )}
                    {onRemove && (
                      <Button size="icon" variant="ghost" className="size-6 hover:text-destructive" onClick={() => onRemove(m.id)}>
                        <Trash2 className="size-3" />
                      </Button>
                    )}
                  </div>
                  {step && (
                    <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground mono">
                      <ArrowRight className="size-3 text-primary/60" />
                      triggered by step: [{step.kind}] {step.selector ?? step.value ?? step.description ?? ""}
                    </div>
                  )}
                  {(m.payload || m.response) && (
                    <div className="mt-1.5 grid grid-cols-2 gap-2">
                      {m.payload && (
                        <div className="bg-background/60 border border-border/60 rounded p-1.5">
                          <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-0.5">Payload</div>
                          <pre className="mono text-[10px] text-foreground/80 overflow-hidden whitespace-pre-wrap break-all">{truncate(m.payload, 140)}</pre>
                        </div>
                      )}
                      {m.response && (
                        <div className="bg-background/60 border border-border/60 rounded p-1.5">
                          <div className="text-[9px] uppercase tracking-wider text-muted-foreground mb-0.5">Response</div>
                          <pre className="mono text-[10px] text-foreground/80 overflow-hidden whitespace-pre-wrap break-all">{truncate(m.response, 140)}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
