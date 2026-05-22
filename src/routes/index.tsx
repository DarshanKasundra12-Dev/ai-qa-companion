import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, Cpu, Network, Radar, Sparkles, Workflow, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Landing,
});

const features = [
  { icon: Workflow, title: "No-Code Test Flow Engine", desc: "Record clicks, inputs, navigation, waits and assertions step-by-step. Replay anytime." },
  { icon: Network, title: "Screen → API Intelligence", desc: "Map every UI action to the API calls it triggers. Auto-generate sequence diagrams." },
  { icon: Sparkles, title: "AI Selector Healing", desc: "Gemini-powered self-healing locators that survive UI changes." },
  { icon: Cpu, title: "Script Generator", desc: "Export Playwright, Cypress, and Selenium scripts in one click." },
  { icon: Radar, title: "Inspector & DevTools", desc: "Inspect selectors, stability scores, and runtime APIs in a familiar console." },
  { icon: Activity, title: "Run History & Reports", desc: "Track pass/fail, durations, and step-level logs for every execution." },
];

function Landing() {
  return (
    <div className="min-h-screen grid-bg">
      <header className="border-b border-border/60 backdrop-blur-md bg-background/50 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex items-center justify-between px-6 h-14">
          <div className="flex items-center gap-2">
            <div className="size-7 rounded-md bg-primary/15 border border-primary/40 grid place-items-center">
              <Zap className="size-4 text-primary" />
            </div>
            <span className="font-semibold tracking-tight">QAforge<span className="text-primary">.</span></span>
            <span className="ml-2 text-[10px] uppercase tracking-widest text-muted-foreground border border-border rounded px-1.5 py-0.5 mono">v0.1 preview</span>
          </div>
          <nav className="flex items-center gap-2">
            <Link to="/login"><Button variant="ghost" size="sm">Sign in</Button></Link>
            <Link to="/signup"><Button size="sm">Get started</Button></Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="max-w-6xl mx-auto px-6 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 mono text-xs text-primary border border-primary/30 bg-primary/10 rounded-full px-3 py-1 mb-6">
            <span className="size-1.5 rounded-full bg-primary animate-pulse" />
            AI-powered QA console
          </div>
          <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-[1.05]">
            No-code QA automation,<br />
            <span className="text-primary text-glow">wired to the network.</span>
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
            Record test flows visually, map every interaction to the APIs it fires, and replay
            with one click. Built for QA engineers who think in DevTools.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link to="/signup"><Button size="lg" className="gap-2"><Zap className="size-4" />Start free</Button></Link>
            <Link to="/login"><Button size="lg" variant="outline">Sign in</Button></Link>
          </div>

          <div className="mt-16 mx-auto max-w-4xl glass rounded-xl p-1 shadow-glow">
            <div className="rounded-lg bg-background/80 border border-border/60 overflow-hidden">
              <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border/60 bg-card/50">
                <div className="size-2.5 rounded-full bg-destructive/70" />
                <div className="size-2.5 rounded-full bg-warning/70" />
                <div className="size-2.5 rounded-full bg-success/70" />
                <span className="ml-3 text-xs text-muted-foreground mono">qaforge://run/login-flow</span>
              </div>
              <div className="grid grid-cols-12 text-left text-xs mono">
                <div className="col-span-7 p-4 border-r border-border/60 space-y-1.5">
                  <div className="text-primary">▶ run login-flow.test</div>
                  <div className="text-muted-foreground">  ✓ navigate https://app.example.com/login <span className="text-success">120ms</span></div>
                  <div className="text-muted-foreground">{`  ✓ fill #email "user@acme.io"`} <span className="text-success">8ms</span></div>
                  <div className="text-muted-foreground">{`  ✓ fill #password "••••••••"`} <span className="text-success">6ms</span></div>
                  <div className="text-muted-foreground">  ✓ click button[type=submit] <span className="text-success">14ms</span></div>
                  <div className="text-info">  ↳ POST /api/v1/auth/login <span className="text-success">200 · 213ms</span></div>
                  <div className="text-muted-foreground">  ✓ assert url=/dashboard <span className="text-success">300ms</span></div>
                  <div className="text-success mt-2">PASS · 4 steps · 1 API · 661ms</div>
                </div>
                <div className="col-span-5 p-4 space-y-2">
                  <div className="text-muted-foreground uppercase tracking-widest text-[10px]">Network</div>
                  <div className="flex justify-between"><span className="text-info">POST</span><span className="text-muted-foreground">/auth/login</span><span className="text-success">200</span></div>
                  <div className="flex justify-between"><span className="text-info">GET</span><span className="text-muted-foreground">/users/me</span><span className="text-success">200</span></div>
                  <div className="flex justify-between"><span className="text-info">GET</span><span className="text-muted-foreground">/dashboard/stats</span><span className="text-success">200</span></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-6 pb-24">
          <div className="grid md:grid-cols-3 gap-4">
            {features.map((f) => (
              <div key={f.title} className="glass rounded-lg p-5 hover:border-primary/40 transition-colors">
                <f.icon className="size-5 text-primary mb-3" />
                <h3 className="font-medium">{f.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60 py-6 text-center text-xs text-muted-foreground mono">
        QAforge · built with Lovable Cloud + Lovable AI
      </footer>
    </div>
  );
}
