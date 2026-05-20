import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { AuthShell, Field } from "./login";

export const Route = createFileRoute("/forgot-password")({ component: ForgotPage });

function ForgotPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: typeof window !== "undefined" ? `${window.location.origin}/reset-password` : undefined,
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("If that email exists, a reset link is on its way.");
  }

  return (
    <AuthShell title="Reset password" subtitle="We'll send you a recovery link.">
      <form onSubmit={submit} className="space-y-4">
        <Field id="email" label="Email" type="email" value={email} onChange={setEmail} required />
        <Button type="submit" disabled={loading} className="w-full">
          {loading ? "Sending…" : "Send reset link"}
        </Button>
        <div className="text-xs text-muted-foreground text-center">
          <Link to="/login" className="text-primary">Back to sign in</Link>
        </div>
      </form>
    </AuthShell>
  );
}
