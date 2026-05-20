import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { AuthShell, Field } from "./login";

export const Route = createFileRoute("/signup")({ component: SignupPage });

function SignupPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 6) return toast.error("Password must be at least 6 characters");
    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: typeof window !== "undefined" ? window.location.origin : undefined },
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Account created");
    navigate({ to: "/dashboard" });
  }

  return (
    <AuthShell title="Create account" subtitle="Spin up your QA workspace.">
      <form onSubmit={submit} className="space-y-4">
        <Field id="email" label="Email" type="email" value={email} onChange={setEmail} required />
        <Field id="password" label="Password" type="password" value={password} onChange={setPassword} required />
        <Button type="submit" disabled={loading} className="w-full">
          {loading ? "Creating…" : "Create account"}
        </Button>
        <div className="text-xs text-muted-foreground text-center">
          Have an account? <Link to="/login" className="text-primary">Sign in</Link>
        </div>
      </form>
    </AuthShell>
  );
}
