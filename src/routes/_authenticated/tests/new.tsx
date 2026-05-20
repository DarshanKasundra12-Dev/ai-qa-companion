import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { StepBuilder } from "@/components/test-flow/StepBuilder";
import { ApiMappingPanel } from "@/components/test-flow/ApiMappingPanel";
import { type TestStep, type ApiCall } from "@/lib/flow-types";
import { inferApiMappings } from "@/lib/ai.functions";
import { toast } from "sonner";
import { Save, Workflow } from "lucide-react";

export const Route = createFileRoute("/_authenticated/tests/new")({ component: NewTest });

function NewTest() {
  const navigate = useNavigate();
  const [name, setName] = useState("Untitled flow");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<TestStep[]>([]);
  const [mappings, setMappings] = useState<ApiCall[]>([]);

  const inferFn = useServerFn(inferApiMappings);
  const infer = useMutation({
    mutationFn: async () => inferFn({ data: { url, description, steps } }),
    onSuccess: (res) => {
      if (res.error) return toast.error(res.error);
      setMappings(res.mappings);
      toast.success(`Inferred ${res.mappings.length} API call${res.mappings.length === 1 ? "" : "s"}`);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const save = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error("Not signed in");
      const { data, error } = await supabase
        .from("test_flows")
        .insert({
          user_id: u.user.id,
          name: name.trim() || "Untitled flow",
          url: url.trim(),
          description: description.trim(),
          steps: steps as unknown as never,
          api_mappings: mappings as unknown as never,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success("Flow saved");
      navigate({ to: "/tests/$testId", params: { testId: data!.id } });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Workflow className="size-6 text-primary" /> Record New Flow
          </h1>
          <p className="text-sm text-muted-foreground">Build a no-code test flow and let AI map it to APIs.</p>
        </div>
        <Button onClick={() => save.mutate()} disabled={save.isPending || steps.length === 0} className="gap-2">
          <Save className="size-4" /> {save.isPending ? "Saving…" : "Save flow"}
        </Button>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-8 space-y-4">
          <div className="glass rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-input/60" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Target URL</Label>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.example.com" className="bg-input/60 mono" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this flow verify?" className="bg-input/60 min-h-[60px]" />
            </div>
          </div>

          <div className="glass rounded-xl p-4">
            <h2 className="text-sm font-medium mb-3 flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              Test Steps
            </h2>
            <StepBuilder steps={steps} onChange={setSteps} />
          </div>
        </div>

        <div className="col-span-12 lg:col-span-4">
          <div className="glass rounded-xl p-4 sticky top-16">
            <ApiMappingPanel
              mappings={mappings}
              steps={steps}
              onRemove={(id) => setMappings(mappings.filter((m) => m.id !== id))}
              onInfer={steps.length > 0 ? () => infer.mutate() : undefined}
              inferring={infer.isPending}
            />
            {steps.length === 0 && (
              <div className="mt-3 text-[11px] text-muted-foreground mono">Add steps first, then run AI inference.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
