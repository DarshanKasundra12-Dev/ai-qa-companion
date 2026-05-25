import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Activity, ArrowUpRight, CheckCircle2, FlaskConical, Network, Plus, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/dashboard")({ component: Dashboard });

function Dashboard() {
  const { data: flows } = useQuery({
    queryKey: ["flows-overview"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("test_flows")
        .select("id,name,url,steps,api_mappings,last_run_status,last_run_at,updated_at")
        .order("updated_at", { ascending: false })
        .limit(6);
      if (error) throw error;
      return data;
    },
  });

  const total = flows?.length ?? 0;
  const passed = flows?.filter((f) => f.last_run_status === "passed").length ?? 0;
  const failed = flows?.filter((f) => f.last_run_status === "failed").length ?? 0;
  const apis = flows?.reduce((acc, f) => acc + ((f.api_mappings as unknown[])?.length ?? 0), 0) ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">Your QA console at a glance.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/api-tester">
            <Button variant="outline" className="gap-2"><Network className="size-4" /> API Tester</Button>
          </Link>
          <Link to="/tests/new">
            <Button className="gap-2"><Plus className="size-4" /> Open Workspace</Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={FlaskConical} label="Test flows" value={total} accent="text-primary" />
        <Stat icon={CheckCircle2} label="Passed" value={passed} accent="text-success" />
        <Stat icon={XCircle} label="Failed" value={failed} accent="text-destructive" />
        <Stat icon={Network} label="API mappings" value={apis} accent="text-info" />
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
          <h2 className="text-sm font-medium flex items-center gap-2"><Activity className="size-4 text-primary" /> Recent flows</h2>
          <Link to="/tests" className="text-xs text-primary hover:underline">View all</Link>
        </div>
        <div className="divide-y divide-border/60">
          {flows && flows.length > 0 ? (
            flows.map((f) => (
              <Link
                key={f.id}
                to="/tests/workspace/$testId"
                params={{ testId: f.id }}
                className="flex items-center gap-3 px-4 py-3 hover:bg-accent/40 transition-colors"
              >
                <StatusDot status={f.last_run_status} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{f.name}</div>
                  <div className="text-xs text-muted-foreground truncate mono">{f.url || "—"}</div>
                </div>
                <div className="text-xs text-muted-foreground mono shrink-0">
                  {(f.steps as unknown[])?.length ?? 0} steps · {(f.api_mappings as unknown[])?.length ?? 0} APIs
                </div>
                <ArrowUpRight className="size-4 text-muted-foreground shrink-0" />
              </Link>
            ))
          ) : (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              No flows yet. <Link to="/tests/new" className="text-primary">Record your first one →</Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, accent }: { icon: React.ElementType; label: string; value: number; accent: string }) {
  return (
    <div className="glass rounded-lg p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
        <Icon className={`size-4 ${accent}`} />
      </div>
      <div className={`text-3xl font-semibold mt-2 mono ${accent}`}>{value}</div>
    </div>
  );
}

function StatusDot({ status }: { status: string | null | undefined }) {
  const color = status === "passed" ? "bg-success" : status === "failed" ? "bg-destructive" : "bg-muted-foreground/50";
  return <span className={`size-2 rounded-full ${color} shrink-0`} />;
}
