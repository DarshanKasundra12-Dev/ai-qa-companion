import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Play, Square, Activity, MousePointer2, Globe, Shield, Eye,
  Network, Copy, AlertTriangle, CheckCircle2, Info, ArrowLeft,
  Wifi, WifiOff, Sparkles, Code, Bug
} from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/tests/workspace/$testId")({
  component: WorkspacePage
});

function WorkspacePage() {
  const { testId } = Route.useParams();
  const socketRef = useRef<Socket | null>(null);

  const {
    isConnected, setConnected,
    isRecording, setRecording,
    targetUrl, setTargetUrl,
    networkRequests, addNetworkRequest, updateNetworkResponse,
    securityIssues, addSecurityIssues,
    selectedElement, setSelectedElement,
    clearWorkspace
  } = useWorkspaceStore();

  const [urlInput, setUrlInput] = useState("https://example.com");
  const [screencastFrame, setScreencastFrame] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'inspector' | 'security' | 'ai'>('inspector');
  const [networkFilter, setNetworkFilter] = useState<string>('all');
  const [aiQuery, setAiQuery] = useState("");
  const [aiResponse, setAiResponse] = useState("");
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    clearWorkspace();
    const socket = io("http://localhost:4000");
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => { setConnected(false); setRecording(false); });

    socket.on("session_started", (data) => {
      if (data.success) {
        toast.success("Browser session started");
        setTargetUrl(data.url);
      } else {
        toast.error("Failed: " + data.error);
        setRecording(false);
      }
    });

    socket.on("session_stopped", () => {
      toast.info("Session stopped");
      setRecording(false);
      setScreencastFrame(null);
    });

    socket.on("network_request", (req) => {
      addNetworkRequest({
        id: Math.random().toString(36).substring(7),
        url: req.url,
        method: req.method,
        resourceType: req.resourceType,
        timestamp: Date.now()
      });
    });

    socket.on("network_response", (res) => {
      updateNetworkResponse(res.url, res.status, res.body);
    });

    socket.on("security_issues", (data) => {
      addSecurityIssues(data.url, data.issues);
    });

    socket.on("element_selected", (elData) => {
      setSelectedElement(elData);
      setActiveTab('inspector');
      toast.success("Element captured");
    });

    socket.on("screencast_frame", (frame) => {
      setScreencastFrame(`data:image/jpeg;base64,${frame.data}`);
    });

    return () => { socket.disconnect(); };
  }, []);

  const toggleRecording = () => {
    if (isRecording) {
      socketRef.current?.emit("stop_session");
      setRecording(false);
      setScreencastFrame(null);
    } else {
      if (!urlInput) return toast.error("Please enter a URL");
      socketRef.current?.emit("start_session", { url: urlInput });
      setRecording(true);
    }
  };

  const copySelector = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  }, []);

  const askAI = async () => {
    if (!aiQuery.trim()) return;
    setAiLoading(true);
    setAiResponse("");
    try {
      const res = await fetch("http://localhost:4000/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + (import.meta.env.VITE_GEMINI_API_KEY || ""),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: {
            contents: [{ role: "user", parts: [{ text: `You are a QA automation expert. The user is inspecting a webpage at "${targetUrl}". Answer concisely:\n\n${aiQuery}\n\n${selectedElement ? `Currently selected element: <${selectedElement.tagName?.toLowerCase()}> id="${selectedElement.id || ''}" class="${selectedElement.className || ''}" text="${selectedElement.text || ''}"` : ''}` }] }]
          }
        })
      });
      const data = await res.json();
      setAiResponse(data.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response from AI.");
    } catch {
      setAiResponse("Failed to reach AI. Check your API key.");
    } finally {
      setAiLoading(false);
    }
  };

  const filteredRequests = networkFilter === 'all'
    ? networkRequests
    : networkRequests.filter(r => r.method === networkFilter);

  const getSeverityColor = (sev: string) => {
    if (sev === 'Critical') return 'bg-red-500/20 text-red-400 border-red-500/30';
    if (sev === 'High') return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    if (sev === 'Medium') return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
  };

  return (
    <div className="h-[calc(100vh-3rem)] w-full bg-background flex flex-col overflow-hidden">
      {/* Workspace top bar */}
      <div className="h-11 border-b border-border/50 flex items-center px-3 gap-3 shrink-0 bg-card/40 backdrop-blur-sm">
        <Link to="/dashboard" className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Globe className="size-4 text-primary" />
          <span>Workspace</span>
          <span className="text-muted-foreground text-xs mono">#{testId.slice(0, 8)}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className={`flex items-center gap-1.5 text-[11px] mono px-2 py-0.5 rounded-full border ${isConnected ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-red-500/30 bg-red-500/10 text-red-400'}`}>
            {isConnected ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
            {isConnected ? 'Server Connected' : 'Disconnected'}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          {/* Left Sidebar: Controls */}
          <ResizablePanel defaultSize={16} minSize={12} maxSize={22}>
            <div className="h-full bg-card/50 overflow-y-auto p-3 space-y-4">
              {/* URL + Session Control */}
              <div className="space-y-2">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Target URL</label>
                <Input
                  type="url"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  className="h-8 text-xs bg-black/30 border-border/50 mono"
                  placeholder="https://example.com"
                  onKeyDown={(e) => e.key === 'Enter' && !isRecording && toggleRecording()}
                />
                <Button
                  onClick={toggleRecording}
                  variant={isRecording ? "destructive" : "default"}
                  className="w-full h-8 text-xs gap-1.5"
                  disabled={!isConnected}
                >
                  {isRecording ? <><Square className="size-3" /> Stop Session</> : <><Play className="size-3" /> Start Session</>}
                </Button>
              </div>

              {/* Connection status detail */}
              <div className="space-y-2">
                <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Session Info</label>
                <div className="text-[11px] space-y-1 text-muted-foreground">
                  <div className="flex justify-between"><span>Status:</span><span className={isRecording ? 'text-emerald-400' : ''}>{isRecording ? 'Recording' : 'Idle'}</span></div>
                  <div className="flex justify-between"><span>Requests:</span><span className="text-info">{networkRequests.length}</span></div>
                  <div className="flex justify-between"><span>Security:</span><span className={securityIssues.length > 0 ? 'text-warning' : ''}>{securityIssues.length} issues</span></div>
                </div>
              </div>

              {/* Quick actions */}
              {selectedElement && (
                <div className="space-y-2">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Quick Selectors</label>
                  <div className="space-y-1">
                    {selectedElement.id && (
                      <button onClick={() => copySelector(`#${selectedElement.id}`)} className="w-full text-left text-[10px] mono px-2 py-1 rounded bg-black/20 hover:bg-primary/10 border border-border/30 truncate transition-colors">
                        #{selectedElement.id}
                      </button>
                    )}
                    {selectedElement.dataTestId && (
                      <button onClick={() => copySelector(`[data-testid="${selectedElement.dataTestId}"]`)} className="w-full text-left text-[10px] mono px-2 py-1 rounded bg-black/20 hover:bg-primary/10 border border-border/30 truncate transition-colors">
                        [data-testid="{selectedElement.dataTestId}"]
                      </button>
                    )}
                    {selectedElement.role && (
                      <button onClick={() => copySelector(`[role="${selectedElement.role}"]`)} className="w-full text-left text-[10px] mono px-2 py-1 rounded bg-black/20 hover:bg-primary/10 border border-border/30 truncate transition-colors">
                        role: {selectedElement.role}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Center: Preview + Network */}
          <ResizablePanel defaultSize={55}>
            <ResizablePanelGroup direction="vertical">
              {/* Browser Preview */}
              <ResizablePanel defaultSize={70}>
                <div className="h-full bg-black/90 flex items-center justify-center relative overflow-hidden">
                  {isRecording ? (
                    screencastFrame ? (
                      <img src={screencastFrame} className="w-full h-full object-contain pointer-events-none" alt="Live Browser" />
                    ) : (
                      <div className="text-center space-y-3">
                        <div className="size-14 rounded-full bg-primary/20 flex items-center justify-center mx-auto animate-pulse">
                          <MousePointer2 className="size-6 text-primary" />
                        </div>
                        <p className="text-sm text-muted-foreground">Connecting to browser...</p>
                        <p className="text-[10px] text-muted-foreground/60 mono">Waiting for screencast stream</p>
                      </div>
                    )
                  ) : (
                    <div className="text-center space-y-3">
                      <Globe className="size-10 text-muted-foreground/30 mx-auto" />
                      <p className="text-sm text-muted-foreground">Enter a URL and click Start Session</p>
                      <p className="text-[10px] text-muted-foreground/50">Live browser preview will appear here</p>
                    </div>
                  )}
                </div>
              </ResizablePanel>

              <ResizableHandle withHandle />

              {/* Network Console */}
              <ResizablePanel defaultSize={30} minSize={15}>
                <div className="h-full bg-card/50 flex flex-col overflow-hidden">
                  <div className="h-8 border-b border-border/50 flex items-center px-3 gap-2 shrink-0">
                    <Network className="size-3.5 text-info" />
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Network</span>
                    <span className="text-[10px] mono text-muted-foreground ml-1">({filteredRequests.length})</span>
                    <div className="ml-auto flex gap-1">
                      {['all', 'GET', 'POST', 'PUT', 'DELETE'].map(f => (
                        <button
                          key={f}
                          onClick={() => setNetworkFilter(f)}
                          className={`text-[9px] px-1.5 py-0.5 rounded mono uppercase ${networkFilter === f ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex-1 overflow-auto p-1">
                    <table className="w-full text-[11px] mono text-left">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border/30">
                          <th className="pb-1 font-normal px-2 w-16">Method</th>
                          <th className="pb-1 font-normal px-2 w-14">Status</th>
                          <th className="pb-1 font-normal px-2 w-16">Type</th>
                          <th className="pb-1 font-normal px-2">URL</th>
                          <th className="pb-1 font-normal px-2 w-8"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRequests.map((req, i) => (
                          <tr key={i} className="hover:bg-accent/20 cursor-pointer border-b border-border/10">
                            <td className={`py-1 px-2 ${req.method === 'POST' ? 'text-warning' : req.method === 'DELETE' ? 'text-destructive' : 'text-info'}`}>{req.method}</td>
                            <td className={`py-1 px-2 ${req.status && req.status >= 200 && req.status < 300 ? 'text-success' : req.status ? 'text-destructive' : 'text-muted-foreground'}`}>
                              {req.status || '...'}
                            </td>
                            <td className="py-1 px-2 text-muted-foreground">{req.resourceType}</td>
                            <td className="py-1 px-2 truncate max-w-[300px]" title={req.url}>{req.url}</td>
                            <td className="py-1 px-2">
                              <button onClick={() => copySelector(req.url)} className="text-muted-foreground hover:text-foreground"><Copy className="size-3" /></button>
                            </td>
                          </tr>
                        ))}
                        {filteredRequests.length === 0 && (
                          <tr><td colSpan={5} className="py-6 text-center text-muted-foreground text-xs">
                            {isRecording ? 'Waiting for network activity...' : 'Start a session to capture requests'}
                          </td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Right Panel: Inspector / Security / AI */}
          <ResizablePanel defaultSize={29} minSize={18} maxSize={40}>
            <div className="h-full bg-card/50 flex flex-col overflow-hidden">
              {/* Tabs */}
              <div className="flex items-center border-b border-border/50 bg-card/30 shrink-0">
                {[
                  { key: 'inspector' as const, icon: Eye, label: 'Inspector' },
                  { key: 'security' as const, icon: Shield, label: 'Security' },
                  { key: 'ai' as const, icon: Sparkles, label: 'AI Assistant' },
                ].map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] font-medium border-b-2 transition-colors ${
                      activeTab === tab.key
                        ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <tab.icon className="size-3.5" />
                    {tab.label}
                    {tab.key === 'security' && securityIssues.length > 0 && (
                      <span className="text-[9px] bg-warning/20 text-warning px-1 py-0.5 rounded-full">{securityIssues.length}</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-auto">
                {/* Inspector Tab */}
                {activeTab === 'inspector' && (
                  <div className="p-4 space-y-3">
                    {selectedElement ? (
                      <>
                        <div className="bg-black/20 p-2.5 rounded-lg border border-border/50">
                          <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Element</div>
                          <div className="text-sm font-semibold text-primary mono">{`<${selectedElement.tagName?.toLowerCase()}>`}</div>
                        </div>

                        <div className="bg-black/20 p-2.5 rounded-lg border border-border/50">
                          <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-2">Selectors</div>
                          <div className="space-y-1.5">
                            {selectedElement.id && <SelectorRow label="ID" value={`#${selectedElement.id}`} score={95} onCopy={copySelector} />}
                            {selectedElement.dataTestId && <SelectorRow label="Test ID" value={`[data-testid="${selectedElement.dataTestId}"]`} score={90} onCopy={copySelector} />}
                            {selectedElement.role && <SelectorRow label="Role" value={`[role="${selectedElement.role}"]`} score={85} onCopy={copySelector} />}
                            {selectedElement.ariaLabel && <SelectorRow label="Aria" value={`[aria-label="${selectedElement.ariaLabel}"]`} score={80} onCopy={copySelector} />}
                            {selectedElement.name && <SelectorRow label="Name" value={`[name="${selectedElement.name}"]`} score={75} onCopy={copySelector} />}
                            {selectedElement.placeholder && <SelectorRow label="Placeholder" value={`[placeholder="${selectedElement.placeholder}"]`} score={60} onCopy={copySelector} />}
                          </div>
                          <div className="text-[10px] text-emerald-400 mt-2 pt-2 border-t border-border/30 flex items-center gap-1">
                            <CheckCircle2 className="size-3" /> Best selector recommended above
                          </div>
                        </div>

                        <div className="bg-black/20 p-2.5 rounded-lg border border-border/50">
                          <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Classes</div>
                          <div className="text-[11px] mono break-words text-blue-400">{selectedElement.className || 'None'}</div>
                        </div>

                        <div className="bg-black/20 p-2.5 rounded-lg border border-border/50">
                          <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Text Content</div>
                          <div className="text-xs italic text-muted-foreground">"{selectedElement.text || 'None'}"</div>
                        </div>

                        <div className="bg-black/20 p-2.5 rounded-lg border border-border/50 overflow-hidden">
                          <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">XPath</div>
                          <div className="text-[10px] mono text-amber-400 break-all">{selectedElement.xpath}</div>
                        </div>

                        <div className="bg-black/20 p-2.5 rounded-lg border border-border/50">
                          <div className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">Playwright Locator</div>
                          <div className="text-[10px] mono text-emerald-400 break-all">
                            {selectedElement.dataTestId
                              ? `page.getByTestId('${selectedElement.dataTestId}')`
                              : selectedElement.role
                              ? `page.getByRole('${selectedElement.role}'${selectedElement.name ? `, { name: '${selectedElement.name}' }` : ''})`
                              : selectedElement.id
                              ? `page.locator('#${selectedElement.id}')`
                              : selectedElement.text
                              ? `page.getByText('${selectedElement.text.slice(0, 30)}')`
                              : `page.locator('${selectedElement.tagName?.toLowerCase()}')`
                            }
                          </div>
                        </div>

                        <Button className="w-full text-xs gap-1.5 mt-2" variant="outline" onClick={() => {
                          const loc = selectedElement.dataTestId
                            ? `page.getByTestId('${selectedElement.dataTestId}')`
                            : selectedElement.id
                            ? `page.locator('#${selectedElement.id}')`
                            : `page.locator('${selectedElement.xpath}')`;
                          copySelector(loc);
                        }}>
                          <Code className="size-3" /> Copy Playwright Locator
                        </Button>
                      </>
                    ) : (
                      <div className="text-center py-16 space-y-3">
                        <Eye className="size-10 text-muted-foreground/30 mx-auto" />
                        <p className="text-xs text-muted-foreground">Click an element in the browser to inspect its properties.</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Security Tab */}
                {activeTab === 'security' && (
                  <div className="p-4 space-y-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Shield className="size-4 text-warning" />
                      <span className="text-sm font-medium">Security Analysis</span>
                      <span className="text-[10px] bg-warning/20 text-warning px-1.5 py-0.5 rounded-full ml-auto">{securityIssues.length} issues</span>
                    </div>
                    {securityIssues.length > 0 ? (
                      securityIssues.map((issue, i) => (
                        <div key={i} className={`p-2.5 rounded-lg border ${getSeverityColor(issue.severity)}`}>
                          <div className="flex justify-between items-start mb-1">
                            <span className="text-xs font-semibold">{issue.name}</span>
                            <span className="text-[9px] uppercase tracking-widest font-bold">{issue.severity}</span>
                          </div>
                          <div className="text-[10px] opacity-80 mt-1">{issue.details}</div>
                          <div className="text-[9px] mono opacity-60 truncate mt-1 pt-1 border-t border-current/10" title={issue.url}>
                            {issue.url}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-12 space-y-3">
                        <Shield className="size-10 text-muted-foreground/30 mx-auto" />
                        <p className="text-xs text-muted-foreground">Start a session to scan for security issues.</p>
                        <p className="text-[10px] text-muted-foreground/50">Checks: HSTS, Clickjacking, Cookies, JWT leaks</p>
                      </div>
                    )}
                  </div>
                )}

                {/* AI Assistant Tab */}
                {activeTab === 'ai' && (
                  <div className="p-4 flex flex-col h-full">
                    <div className="flex items-center gap-2 mb-3">
                      <Sparkles className="size-4 text-primary" />
                      <span className="text-sm font-medium">AI QA Assistant</span>
                    </div>

                    {aiResponse && (
                      <div className="bg-black/20 p-3 rounded-lg border border-border/50 mb-3 text-xs leading-relaxed whitespace-pre-wrap max-h-[50vh] overflow-auto">
                        {aiResponse}
                      </div>
                    )}

                    <div className="mt-auto space-y-2 pb-2">
                      <div className="flex gap-1 flex-wrap">
                        {['Explain this selector', 'Suggest better selector', 'Is this flaky?', 'Explain security risks'].map(q => (
                          <button
                            key={q}
                            onClick={() => setAiQuery(q)}
                            className="text-[10px] px-2 py-1 rounded-full border border-border/50 text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors"
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <Input
                          value={aiQuery}
                          onChange={(e) => setAiQuery(e.target.value)}
                          className="flex-1 h-8 text-xs bg-black/30 border-border/50"
                          placeholder="Ask the AI assistant..."
                          onKeyDown={(e) => e.key === 'Enter' && askAI()}
                        />
                        <Button size="sm" className="h-8 text-xs gap-1" onClick={askAI} disabled={aiLoading}>
                          {aiLoading ? <Activity className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                          Ask
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

function SelectorRow({ label, value, score, onCopy }: { label: string; value: string; score: number; onCopy: (v: string) => void }) {
  const scoreColor = score >= 85 ? 'text-emerald-400 bg-emerald-500/20' : score >= 70 ? 'text-amber-400 bg-amber-500/20' : 'text-red-400 bg-red-500/20';
  return (
    <div className="flex items-center gap-2 group">
      <span className="text-[9px] uppercase tracking-widest text-muted-foreground w-12 shrink-0">{label}</span>
      <span className="text-[10px] mono flex-1 truncate">{value}</span>
      <span className={`text-[9px] mono px-1 py-0.5 rounded ${scoreColor} shrink-0`}>{score}</span>
      <button onClick={() => onCopy(value)} className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground shrink-0">
        <Copy className="size-3" />
      </button>
    </div>
  );
}
