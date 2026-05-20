import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Zap } from "lucide-react";

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("test123@gmail.com");
  const [password, setPassword] = useState("test123");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Welcome back");
    navigate({ to: "/dashboard" });
  }

  return (
    <AuthShell title="Sign in" subtitle="Access your QA console.">
      <form onSubmit={submit} className="space-y-4">
        <Field id="email" label="Email" type="email" value={email} onChange={setEmail} required />
        <Field id="password" label="Password" type="password" value={password} onChange={setPassword} required />
        <Button type="submit" disabled={loading} className="w-full">
          {loading ? "Signing in…" : "Sign in"}
        </Button>
        <div className="flex justify-between text-xs text-muted-foreground">
          <Link to="/forgot-password" className="hover:text-primary">Forgot password?</Link>
          <Link to="/signup" className="hover:text-primary">Create account</Link>
        </div>
        <div className="mono text-[11px] text-muted-foreground border-t border-border pt-3 mt-2">
          Demo: <span className="text-primary">test123@gmail.com</span> / <span className="text-primary">test123</span>
        </div>
      </form>
    </AuthShell>
  );
}

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid-bg flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <Link to="/" className="flex items-center gap-2 mb-6 justify-center">
          <div className="size-7 rounded-md bg-primary/15 border border-primary/40 grid place-items-center">
            <Zap className="size-4 text-primary" />
          </div>
          <span className="font-semibold tracking-tight">QAforge<span className="text-primary">.</span></span>
        </Link>
        <div className="glass rounded-xl p-6 shadow-glow">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-sm text-muted-foreground mt-1 mb-5">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function Field({ id, label, type = "text", value, onChange, required }: { id: string; label: string; type?: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs uppercase tracking-wider text-muted-foreground">{label}</Label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} required={required} className="bg-input/60 mono" />
    </div>
  );
}
