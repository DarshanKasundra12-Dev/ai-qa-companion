import { useState } from "react";
import { type TestStep, type StepKind, STEP_LABEL } from "@/lib/flow-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GripVertical, MousePointerClick, Keyboard, Navigation, Timer, CheckSquare, ArrowDown, Trash2, Plus } from "lucide-react";

const KIND_ICON: Record<StepKind, React.ElementType> = {
  navigate: Navigation,
  click: MousePointerClick,
  input: Keyboard,
  wait: Timer,
  assert: CheckSquare,
  scroll: ArrowDown,
};

export function StepBuilder({ steps, onChange }: { steps: TestStep[]; onChange: (s: TestStep[]) => void }) {
  const [kind, setKind] = useState<StepKind>("click");

  function add() {
    const next: TestStep = {
      id: crypto.randomUUID(),
      kind,
      selector: kind === "navigate" ? undefined : "",
      value: kind === "wait" ? "1000" : "",
      description: "",
    };
    onChange([...steps, next]);
  }
  function update(id: string, patch: Partial<TestStep>) {
    onChange(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
  function remove(id: string) {
    onChange(steps.filter((s) => s.id !== id));
  }
  function move(id: string, dir: -1 | 1) {
    const i = steps.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= steps.length) return;
    const copy = [...steps];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select value={kind} onValueChange={(v) => setKind(v as StepKind)}>
          <SelectTrigger className="w-36 h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(STEP_LABEL) as StepKind[]).map((k) => (
              <SelectItem key={k} value={k}>{STEP_LABEL[k]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={add} className="gap-1.5"><Plus className="size-3.5" />Add step</Button>
        <span className="ml-auto text-xs text-muted-foreground mono">{steps.length} step{steps.length !== 1 ? "s" : ""}</span>
      </div>

      <div className="space-y-1.5">
        {steps.length === 0 && (
          <div className="text-center text-sm text-muted-foreground py-10 border border-dashed border-border rounded-lg">
            No steps yet. Add your first one above.
          </div>
        )}
        {steps.map((s, i) => {
          const Icon = KIND_ICON[s.kind];
          return (
            <div key={s.id} className="glass rounded-lg p-3 flex items-start gap-2 group">
              <div className="flex flex-col items-center gap-0.5 pt-1">
                <button onClick={() => move(s.id, -1)} className="text-muted-foreground hover:text-primary text-xs">▲</button>
                <span className="mono text-[10px] text-muted-foreground">{i + 1}</span>
                <button onClick={() => move(s.id, 1)} className="text-muted-foreground hover:text-primary text-xs">▼</button>
              </div>
              <div className="size-8 rounded-md bg-primary/10 border border-primary/30 grid place-items-center shrink-0">
                <Icon className="size-4 text-primary" />
              </div>
              <div className="flex-1 grid grid-cols-12 gap-2 min-w-0">
                <div className="col-span-2">
                  <Select value={s.kind} onValueChange={(v) => update(s.id, { kind: v as StepKind })}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(STEP_LABEL) as StepKind[]).map((k) => (
                        <SelectItem key={k} value={k}>{STEP_LABEL[k]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  placeholder={s.kind === "navigate" ? "https://…" : s.kind === "wait" ? "ms" : "selector (#id, [data-testid], css)"}
                  value={s.kind === "navigate" ? (s.value ?? "") : (s.selector ?? "")}
                  onChange={(e) => s.kind === "navigate" ? update(s.id, { value: e.target.value }) : update(s.id, { selector: e.target.value })}
                  className="col-span-5 h-8 text-xs mono bg-input/60"
                />
                <Input
                  placeholder={s.kind === "input" ? "value to type" : s.kind === "assert" ? "expected (text/url)" : s.kind === "wait" ? "milliseconds" : "note"}
                  value={s.kind === "navigate" ? (s.description ?? "") : (s.value ?? "")}
                  onChange={(e) => s.kind === "navigate" ? update(s.id, { description: e.target.value }) : update(s.id, { value: e.target.value })}
                  className="col-span-4 h-8 text-xs mono bg-input/60"
                />
                <Button size="icon" variant="ghost" className="size-8 col-span-1 hover:text-destructive" onClick={() => remove(s.id)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <GripVertical className="size-3.5 text-muted-foreground/40 mt-2 opacity-0 group-hover:opacity-100" />
            </div>
          );
        })}
      </div>
    </div>
  );
}
