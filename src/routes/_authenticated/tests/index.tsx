import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Copy, Play } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/tests/")({ component: TestsList });

function TestsList() {
  const qc = useQueryClient();
  const { data: flows, isLoading } = useQuery({
    queryKey: ["flows"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("test_flows")
        .select("*")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("test_flows").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      toast.success("Flow deleted");
    },
  });

  const dup = useMutation({
    mutationFn: async (id: string) => {
      const flow = flows?.find((f) => f.id === id);
      if (!flow) return;
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { error } = await supabase.from("test_flows").insert({
        user_id: u.user.id,
        name: `${flow.name} (copy)`,
        url: flow.url,
        description: flow.description,
        steps: flow.steps,
        api_mappings: flow.api_mappings,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flows"] });
      toast.success("Flow duplicated");
    },
  });

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Test Flows</h1>
          <p className="text-sm text-muted-foreground">Record, replay, and inspect your no-code test flows.</p>
        </div>
        <Link to="/tests/new"><Button className="gap-2"><Plus className="size-4" /> New flow</Button></Link>
      </div>

      <div className="glass rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-muted-foreground bg-card/60">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Name</th>
              <th className="text-left px-4 py-2.5 font-medium">URL</th>
              <th className="text-left px-4 py-2.5 font-medium">Steps</th>
              <th className="text-left px-4 py-2.5 font-medium">APIs</th>
              <th className="text-left px-4 py-2.5 font-medium">Last run</th>
              <th className="text-left px-4 py-2.5 font-medium">Updated</th>
              <th className="text-right px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {isLoading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!isLoading && (!flows || flows.length === 0) && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                No flows yet. <Link to="/tests/new" className="text-primary">Create one →</Link>
              </td></tr>
            )}
            {flows?.map((f) => (
              <tr key={f.id} className="hover:bg-accent/30 transition-colors">
                <td className="px-4 py-3">
                  <Link to="/tests/$testId" params={{ testId: f.id }} className="font-medium hover:text-primary">{f.name}</Link>
                </td>
                <td className="px-4 py-3 mono text-xs text-muted-foreground truncate max-w-[16rem]">{f.url || "—"}</td>
                <td className="px-4 py-3 mono text-xs">{(f.steps as unknown[])?.length ?? 0}</td>
                <td className="px-4 py-3 mono text-xs">{(f.api_mappings as unknown[])?.length ?? 0}</td>
                <td className="px-4 py-3">
                  <span className={`mono text-xs px-2 py-0.5 rounded-full border ${
                    f.last_run_status === "passed" ? "border-success/40 text-success bg-success/10" :
                    f.last_run_status === "failed" ? "border-destructive/40 text-destructive bg-destructive/10" :
                    "border-border text-muted-foreground"
                  }`}>{f.last_run_status ?? "never"}</span>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground mono">
                  {formatDistanceToNow(new Date(f.updated_at), { addSuffix: true })}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex gap-1">
                    <Link to="/tests/$testId" params={{ testId: f.id }}>
                      <Button size="icon" variant="ghost" className="size-8" title="Open"><Play className="size-3.5" /></Button>
                    </Link>
                    <Button size="icon" variant="ghost" className="size-8" title="Duplicate" onClick={() => dup.mutate(f.id)}>
                      <Copy className="size-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-8 hover:text-destructive" title="Delete" onClick={() => {
                      if (confirm(`Delete "${f.name}"?`)) del.mutate(f.id);
                    }}><Trash2 className="size-3.5" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
