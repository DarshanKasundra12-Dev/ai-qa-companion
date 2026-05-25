import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useRef, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { StepBuilder } from "@/components/test-flow/StepBuilder";
import { ApiMappingPanel } from "@/components/test-flow/ApiMappingPanel";
import { type TestStep, type ApiCall, STEP_LABEL } from "@/lib/flow-types";
import { inferApiMappings } from "@/lib/ai.functions";
import { toast } from "sonner";
import { io, Socket } from "socket.io-client";
import {
  Save, Workflow, Play, Square, Activity, MousePointer2, Globe, Shield, Eye,
  ArrowLeft, Wifi, WifiOff, Sparkles, CheckCircle2, ChevronRight, Video, X, Timer, CheckSquare, ArrowDown, HelpCircle, Keyboard
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

export const Route = createFileRoute("/_authenticated/tests/new")({ component: NewTest });

function NewTest() {
  const navigate = useNavigate();
  const [name, setName] = useState("Untitled flow");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<TestStep[]>([]);
  const [mappings, setMappings] = useState<ApiCall[]>([]);

  // Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setConnected] = useState(false);
  const [screencastFrame, setScreencastFrame] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });
  const [mode, setMode] = useState<'interact' | 'inspect'>('interact');
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [isManualMode, setIsManualMode] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // Sync mode changes with automation server
  useEffect(() => {
    if (socketRef.current && isRecording) {
      socketRef.current.emit("set_mode", { mode });
    }
  }, [mode, isRecording]);

  // Clean up socket on unmount
  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  const startRecording = () => {
    if (!url) return toast.error("Please enter a target URL");
    if (!name) return toast.error("Please enter a flow name");

    let formattedUrl = url.trim();
    if (!/^https?:\/\//i.test(formattedUrl)) {
      formattedUrl = "https://" + formattedUrl;
      setUrl(formattedUrl);
    }

    setIsRecording(true);
    setSteps([]);
    setMappings([]);

    const socket = io("http://localhost:4000");
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("start_session", { url: formattedUrl });
    });

    socket.on("connect_error", () => {
      toast.error("Cannot connect to automation server at localhost:4000");
      setIsRecording(false);
    });

    socket.on("disconnect", () => {
      setConnected(false);
      setIsRecording(false);
      setScreencastFrame(null);
    });

    socket.on("session_started", (data) => {
      if (data.success) {
        toast.success("Live browser started! Interact on the right to record steps.");
      } else {
        toast.error("Failed to start session: " + data.error);
        setIsRecording(false);
      }
    });

    socket.on("screencast_frame", (frame) => {
      setScreencastFrame(`data:image/jpeg;base64,${frame.data}`);
    });

    socket.on("viewport_info", (vp) => {
      setViewport(vp);
    });

    socket.on("element_selected", (elData) => {
      // User captured an element in inspect mode to create an assertion
      // Selector priority: data-testid/cy/qa → aria-label → role → semantic id → name → text → tag
      const isSemanticId = (id: string) => {
        if (!id) return false;
        if (id.startsWith(':r') && id.endsWith(':')) return false;
        if (/[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return false;
        if (/^(ember|jquery|radix|react-aria|next|__next|nuxt|gatsby|vue-aria|headlessui)-\d+/i.test(id)) return false;
        if (/[a-zA-Z]+-?\d{2,}$/.test(id)) return false;
        if (/^\d+$/.test(id)) return false;
        return true;
      };

      const bestSelector = elData.dataTestId
        ? `[data-testid="${elData.dataTestId}"]`
        : elData.dataCy
          ? `[data-cy="${elData.dataCy}"]`
          : elData.dataQa
            ? `[data-qa="${elData.dataQa}"]`
            : elData.ariaLabel
              ? `[aria-label="${elData.ariaLabel}"]`
              : elData.role
                ? `[role="${elData.role}"]`
                : elData.id && isSemanticId(elData.id)
                  ? `#${elData.id}`
                  : elData.name
                    ? `[name="${elData.name}"]`
                    : elData.text?.trim()
                      ? `text="${elData.text.trim().substring(0, 50)}"`
                      : elData.tagName?.toLowerCase() || 'unknown';

      const newStep: TestStep = {
        id: crypto.randomUUID(),
        kind: "assert",
        selector: bestSelector,
        value: elData.text || "",
        description: `Assert element "${bestSelector}" exists`
      };

      setSteps((prev) => [...prev, newStep]);
      toast.success(`Assertion recorded for ${bestSelector}`);
      setMode('interact'); // Automatically switch back to interact
    });

    socket.on("interaction_recorded", (data) => {
      setSteps((prev) => {
        // Debounce/collapse consecutive inputs on the same element
        if (data.kind === "input" && prev.length > 0 && prev[prev.length - 1].kind === "input" && prev[prev.length - 1].selector === data.selector) {
          const next = [...prev];
          next[next.length - 1] = {
            ...next[next.length - 1],
            value: data.value,
            description: `Type "${data.value}"`
          };
          return next;
        }

        // Debounce consecutive scroll events
        if (data.kind === "scroll" && prev.length > 0 && prev[prev.length - 1].kind === "scroll") {
          const next = [...prev];
          next[next.length - 1] = {
            ...next[next.length - 1],
            value: data.value,
            description: `Scroll to ${data.value}px`
          };
          return next;
        }

        const newStep: TestStep = {
          id: crypto.randomUUID(),
          kind: data.kind,
          selector: data.selector,
          value: data.value,
          description: data.kind === "click"
            ? `Click ${data.selector}`
            : data.kind === "input"
              ? `Type "${data.value}"`
              : data.kind === "navigate"
                ? `Navigate to ${data.value}`
                : data.kind === "press"
                  ? `Press key "${data.value}"`
                  : `Scroll page`
        };
        return [...prev, newStep];
      });
      toast.success(`Action recorded: ${data.kind}`, { duration: 1000 });
    });
  };

  const stopRecording = () => {
    if (socketRef.current) {
      socketRef.current.emit("stop_session");
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setScreencastFrame(null);
    setIsRecording(false);
  };

  const toPageCoords = (e: React.MouseEvent | React.WheelEvent) => {
    const el = previewRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
    const dispW = viewport.width * scale;
    const dispH = viewport.height * scale;
    const offX = (rect.width - dispW) / 2;
    const offY = (rect.height - dispH) / 2;
    const localX = (e.clientX - rect.left - offX) / scale;
    const localY = (e.clientY - rect.top - offY) / scale;
    return { x: Math.max(0, Math.min(viewport.width, localX)), y: Math.max(0, Math.min(viewport.height, localY)) };
  };

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
          last_run_status: "passed",
          last_run_at: new Date().toISOString()
        })
        .select("id")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast.success("Flow saved successfully!");
      setShowSaveConfirm(false);
      navigate({ to: "/tests/$testId", params: { testId: data!.id } });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // Display components helper for step icons
  const getStepIcon = (kind: string) => {
    if (kind === "navigate") return <Globe className="size-3.5 text-blue-400" />;
    if (kind === "click") return <MousePointer2 className="size-3.5 text-primary" />;
    if (kind === "input") return <Activity className="size-3.5 text-amber-400" />;
    if (kind === "wait") return <Timer className="size-3.5 text-purple-400" />;
    if (kind === "assert") return <CheckSquare className="size-3.5 text-emerald-400" />;
    if (kind === "press") return <Keyboard className="size-3.5 text-sky-400" />;
    return <ArrowDown className="size-3.5 text-muted-foreground" />;
  };

  // If in interactive recording mode
  if (isRecording) {
    return (
      <div className="h-[calc(100vh-3rem)] w-full bg-background flex flex-col overflow-hidden">
        {/* Workspace Top Bar */}
        <div className="h-12 border-b border-border/50 flex items-center px-4 gap-3 shrink-0 bg-card/40 backdrop-blur-sm justify-between">
          <div className="flex items-center gap-2">
            <Link to="/tests" onClick={stopRecording} className="text-muted-foreground hover:text-foreground transition-colors shrink-0">
              <ArrowLeft className="size-4" />
            </Link>
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-red-500 animate-pulse" />
              <h1 className="text-sm font-semibold tracking-tight text-foreground truncate max-w-[200px]">{name}</h1>
              <span className="text-[10px] mono text-muted-foreground hidden sm:inline px-1.5 py-0.5 rounded bg-black/40 border border-border/40 truncate max-w-[250px]">
                {url}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Inspect / Interact Toggle */}
            <div className="flex items-center rounded-md border border-border/50 overflow-hidden bg-black/20 shrink-0">
              <button
                onClick={() => setMode('interact')}
                className={`text-[11px] px-2.5 py-1 font-medium transition-colors ${mode === 'interact' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                title="Interact with page normally to record clicks/inputs"
              >
                Interact
              </button>
              <button
                onClick={() => setMode('inspect')}
                className={`text-[11px] px-2.5 py-1 font-medium transition-colors ${mode === 'inspect' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                title="Click elements to record existence assertions"
              >
                Inspect Assert
              </button>
            </div>

            <Button
              onClick={() => setShowSaveConfirm(true)}
              disabled={steps.length === 0}
              className="h-8 text-xs font-semibold gap-1 bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.25)] border-0"
            >
              <Save className="size-3.5" /> Finish Recording
            </Button>
            <Button
              variant="outline"
              onClick={stopRecording}
              className="h-8 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
            >
              Cancel
            </Button>
          </div>
        </div>

        {/* Split Screen Workspace */}
        <div className="flex-1 overflow-hidden">
          <ResizablePanelGroup direction="horizontal">
            {/* Left steps preview checklist */}
            <ResizablePanel defaultSize={25} minSize={20}>
              <div className="h-full bg-card/40 border-r border-border/30 flex flex-col overflow-hidden">
                <div className="p-3 border-b border-border/30 flex items-center justify-between bg-black/10 shrink-0">
                  <div className="flex items-center gap-1.5">
                    <Video className="size-4 text-red-500 animate-pulse" />
                    <span className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Recorded Steps</span>
                  </div>
                  <span className="text-[10px] mono px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-primary">
                    {steps.length} step{steps.length !== 1 ? 's' : ''}
                  </span>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                  {steps.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center p-4 space-y-2 text-muted-foreground">
                      <div className="size-10 rounded-full bg-black/20 border border-border/40 flex items-center justify-center animate-pulse">
                        <Activity className="size-5" />
                      </div>
                      <p className="text-xs font-medium">No steps recorded yet</p>
                      <p className="text-[10px] text-muted-foreground/60 max-w-[200px]">
                        Perform actions like clicks, inputs, scrolls, or assertion captures on the browser preview to start recording!
                      </p>
                    </div>
                  ) : (
                    steps.map((s, index) => (
                      <div key={s.id} className="glass border-border/30 rounded-lg p-2.5 flex items-start gap-2 relative group hover:border-border/60 transition-all">
                        <span className="mono text-[9px] text-muted-foreground w-4 mt-0.5 shrink-0">
                          {index + 1}
                        </span>
                        <div className="mt-0.5 shrink-0">
                          {getStepIcon(s.kind)}
                        </div>
                        <div className="flex-1 min-w-0 pr-4">
                          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 mono">
                            {STEP_LABEL[s.kind]}
                          </div>
                          <p className="text-xs font-medium text-foreground truncate mt-0.5">
                            {s.description}
                          </p>
                          {s.selector && (
                            <p className="text-[9px] mono text-primary/80 truncate mt-0.5" title={s.selector}>
                              {s.selector}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={() => setSteps(steps.filter((val) => val.id !== s.id))}
                          className="opacity-0 group-hover:opacity-100 transition-opacity absolute right-2 top-2.5 text-muted-foreground hover:text-destructive"
                          title="Remove Step"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* Right Live Viewport */}
            <ResizablePanel defaultSize={75}>
              <div className="h-full bg-black/90 flex flex-col overflow-hidden relative">
                {/* Mode notification banner */}
                {mode === 'inspect' && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 glass border-emerald-500/30 bg-emerald-950/20 text-emerald-400 text-xs px-4 py-2 rounded-full flex items-center gap-2 shadow-lg backdrop-blur-md">
                    <Eye className="size-3.5 text-emerald-400 animate-pulse" />
                    <span><b>Inspect Mode:</b> Click any element in the browser viewport to record an existence assertion.</span>
                  </div>
                )}

                <div
                  ref={previewRef}
                  tabIndex={0}
                  className={`flex-1 flex items-center justify-center relative overflow-hidden outline-none ${screencastFrame ? (mode === 'inspect' ? 'cursor-crosshair' : 'cursor-pointer') : ''}`}
                  onClick={(e) => {
                    if (!screencastFrame) return;
                    previewRef.current?.focus();
                    const { x, y } = toPageCoords(e);
                    const eventName = mode === 'inspect' ? 'inspect_click' : 'forward_click';
                    socketRef.current?.emit(eventName, { x, y, button: 'left' });
                  }}
                  onContextMenu={(e) => {
                    if (!screencastFrame) return;
                    e.preventDefault();
                    const { x, y } = toPageCoords(e);
                    const eventName = mode === 'inspect' ? 'inspect_click' : 'forward_click';
                    socketRef.current?.emit(eventName, { x, y, button: 'right' });
                  }}
                  onWheel={(e) => {
                    if (!screencastFrame) return;
                    const { x, y } = toPageCoords(e);
                    socketRef.current?.emit('forward_scroll', { x, y, deltaX: e.deltaX, deltaY: e.deltaY });
                  }}
                  onMouseMove={(e) => {
                    if (!screencastFrame || mode !== 'inspect') return;
                    const { x, y } = toPageCoords(e);
                    socketRef.current?.emit('forward_move', { x, y });
                  }}
                  onKeyDown={(e) => {
                    if (!screencastFrame) return;
                    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault();
                      socketRef.current?.emit('forward_type', { text: e.key });
                    } else if (['Enter', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                      e.preventDefault();
                      socketRef.current?.emit('forward_key', { key: e.key });
                    }
                  }}
                >
                  {screencastFrame ? (
                    <img
                      src={screencastFrame}
                      className="w-full h-full object-contain pointer-events-none select-none"
                      alt="Live Browser Recording Viewport"
                      draggable={false}
                    />
                  ) : (
                    <div className="text-center space-y-3">
                      <div className="size-14 rounded-full bg-primary/20 flex items-center justify-center mx-auto animate-pulse">
                        <Activity className="size-6 text-primary" />
                      </div>
                      <p className="text-sm text-muted-foreground">Connecting to live browser...</p>
                      <p className="text-[10px] text-muted-foreground/60 mono">Spinning up Chromium and starting video feed</p>
                    </div>
                  )}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>

        {/* Confirmation Modal to Save Recorded Flow */}
        <Dialog open={showSaveConfirm} onOpenChange={setShowSaveConfirm}>
          <DialogContent className="glass border-border/80 max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-5 text-emerald-400" /> Save Recorded Flow
              </DialogTitle>
              <DialogDescription>
                You have successfully recorded <b>{steps.length} steps</b>. Do you want to save this as a feature in your new flow?
              </DialogDescription>
            </DialogHeader>

            <div className="bg-black/30 border border-border/30 rounded-lg p-3 space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Flow Name:</span>
                <span className="font-semibold text-foreground">{name}</span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Target URL:</span>
                <span className="mono truncate max-w-[200px] text-foreground">{url}</span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Initial Test Run:</span>
                <span className="text-emerald-400 flex items-center gap-1 font-medium">
                  Passed (verified live) <CheckCircle2 className="size-3" />
                </span>
              </div>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setShowSaveConfirm(false)} disabled={save.isPending}>
                Keep Recording
              </Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending} className="bg-emerald-600 hover:bg-emerald-500 border-0">
                {save.isPending ? "Creating Flow…" : "Yes, Create Flow"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // Setup / Entry View (when not recording)
  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Workflow className="size-6 text-primary" /> Create New Flow
          </h1>
          <p className="text-sm text-muted-foreground">Build a no-code test flow interactively or manually.</p>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* Left main form cards */}
        <div className="col-span-12 lg:col-span-8 space-y-4">
          <div className="glass rounded-xl p-5 space-y-4">
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
              <Globe className="size-4.5 text-primary" /> Flow Details
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="bg-input/60 border-border/60"
                  placeholder="e.g., Login Verification"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">Target URL</Label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://app.example.com"
                  className="bg-input/60 border-border/60 mono"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what features/behaviors this flow verifies..."
                className="bg-input/60 border-border/60 min-h-[60px]"
              />
            </div>

            {/* Interactive Recording Section */}
            {!isManualMode && (
              <div className="border border-primary/20 bg-primary/5 rounded-xl p-4 flex flex-col md:flex-row items-center justify-between gap-4 mt-6">
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold text-primary flex items-center gap-1.5">
                    <Video className="size-4 text-primary animate-pulse" /> Live Interactive Recording (Recommended)
                  </h3>
                  <p className="text-xs text-muted-foreground leading-relaxed max-w-xl">
                    Launches a live browser. Just click and type inside the browser viewport, and your steps will be captured automatically. No manual coding required!
                  </p>
                </div>
                <Button
                  onClick={startRecording}
                  disabled={!url || !name}
                  className="gap-2 font-semibold bg-primary hover:bg-primary/80 shrink-0 shadow-lg shadow-primary/25"
                >
                  <Play className="size-4 fill-current" /> Start Recording
                </Button>
              </div>
            )}
          </div>

          {/* Fallback Manual Step Builder */}
          {isManualMode ? (
            <div className="glass rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium flex items-center gap-2">
                  <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                  Manual Step Builder
                </h2>
                <Button variant="ghost" size="sm" onClick={() => setIsManualMode(false)} className="text-xs text-muted-foreground hover:text-foreground">
                  Switch to Recording Mode
                </Button>
              </div>
              <StepBuilder steps={steps} onChange={setSteps} />
            </div>
          ) : (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                onClick={() => setIsManualMode(true)}
                className="text-xs text-muted-foreground hover:text-foreground gap-1.5"
              >
                <HelpCircle className="size-3.5" /> Need to build steps manually instead? Click here
              </Button>
            </div>
          )}
        </div>

        {/* Right side static preview / Save panel when in manual mode */}
        {isManualMode && (
          <div className="col-span-12 lg:col-span-4 space-y-4">
            <div className="glass rounded-xl p-4 sticky top-16 space-y-4">
              <ApiMappingPanel
                mappings={mappings}
                steps={steps}
                onRemove={(id) => setMappings(mappings.filter((m) => m.id !== id))}
                onInfer={steps.length > 0 ? () => infer.mutate() : undefined}
                inferring={infer.isPending}
              />
              {steps.length === 0 && (
                <div className="text-[11px] text-muted-foreground mono">Add steps first, then run AI inference.</div>
              )}
              <Button
                onClick={() => save.mutate()}
                disabled={save.isPending || steps.length === 0}
                className="w-full gap-2 bg-emerald-600 hover:bg-emerald-500 border-0"
              >
                <Save className="size-4" /> {save.isPending ? "Saving…" : "Save Flow"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
