import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { LayoutDashboard, FlaskConical, LogOut, Plus, Zap, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/login" });
  },
  component: AuthenticatedLayout,
});

const nav = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/tests", label: "Test Flows", icon: FlaskConical },
  { to: "/api-tester", label: "API Tester", icon: Activity },
];

function AuthenticatedLayout() {
  const { user, signOut } = useAuth();
  const path = useRouterState({ select: (s) => s.location.pathname });

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <Sidebar collapsible="icon">
          <SidebarHeader className="border-b border-sidebar-border">
            <Link to="/dashboard" className="flex items-center gap-2 px-2 py-1">
              <div className="size-7 rounded-md bg-primary/15 border border-primary/40 grid place-items-center shrink-0">
                <Zap className="size-4 text-primary" />
              </div>
              <span className="font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
                QAforge<span className="text-primary">.</span>
              </span>
            </Link>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {nav.map((item) => {
                    const active = path === item.to || (item.to !== "/dashboard" && path.startsWith(item.to));
                    return (
                      <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton asChild isActive={active}>
                          <Link to={item.to} className="flex items-center gap-2">
                            <item.icon className="size-4" />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <SidebarGroup>
              <SidebarGroupLabel>Quick Actions</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild>
                      <Link to="/tests/new" className="flex items-center gap-2">
                        <Plus className="size-4" />
                        <span>New Flow</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="border-t border-sidebar-border">
            <div className="px-2 py-1 flex items-center gap-2">
              <div className="size-7 rounded-full bg-primary/10 border border-primary/30 grid place-items-center text-xs mono text-primary shrink-0">
                {user?.email?.slice(0, 1).toUpperCase() ?? "U"}
              </div>
              <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                <div className="text-xs truncate">{user?.email}</div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 group-data-[collapsible=icon]:hidden"
                onClick={() => signOut()}
                title="Sign out"
              >
                <LogOut className="size-3.5" />
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>

        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-12 flex items-center gap-2 border-b border-border/60 bg-background/60 backdrop-blur-md px-3 sticky top-0 z-30">
            <SidebarTrigger />
            <div className="text-xs text-muted-foreground mono">{path}</div>
            <div className="ml-auto flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-success animate-pulse" />
              <span className="text-[11px] text-muted-foreground mono">runtime: ready</span>
            </div>
          </header>
          <main className="flex-1 min-w-0">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
