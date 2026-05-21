import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Play, Activity, History, Trash2, Plus, Clock, HardDrive, AlertCircle } from "lucide-react";
import { useApiStore, KeyVal } from "@/lib/api-store";
import Editor from "@monaco-editor/react";

export const Route = createFileRoute("/_authenticated/api-tester")({
  component: ApiTesterPage
});

function ApiTesterPage() {
  const { currentRequest, setCurrentRequest, response, setResponse, isLoading, setLoading, history, addToHistory, loadFromHistory, clearHistory } = useApiStore();
  const [activeReqTab, setActiveReqTab] = useState<'Params' | 'Headers' | 'Body'>('Params');
  const [activeResTab, setActiveResTab] = useState<'Body' | 'Headers'>('Body');

  const handleSend = async () => {
    if (!currentRequest.url) return toast.error("URL is required");
    
    setLoading(true);
    setResponse(null);
    
    const headersObj: Record<string, string> = {};
    currentRequest.headers.filter(h => h.enabled && h.key).forEach(h => headersObj[h.key] = h.value);
    
    const paramsString = currentRequest.params
      .filter(p => p.enabled && p.key)
      .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
      .join('&');
      
    const finalUrl = paramsString ? `${currentRequest.url}${currentRequest.url.includes('?') ? '&' : '?'}${paramsString}` : currentRequest.url;

    try {
      const res = await fetch("http://localhost:4000/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: finalUrl,
          method: currentRequest.method,
          headers: headersObj,
          data: currentRequest.method !== 'GET' ? currentRequest.body : undefined
        })
      });
      
      const data = await res.json();
      setResponse(data);
      
      addToHistory({
        ...currentRequest,
        id: Math.random().toString(36).substring(7),
        timestamp: Date.now()
      });
    } catch (error: any) {
      toast.error("Proxy error: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const updateKeyVal = (type: 'params' | 'headers', id: string, field: keyof KeyVal, value: any) => {
    setCurrentRequest(req => ({
      ...req,
      [type]: req[type].map(item => item.id === id ? { ...item, [field]: value } : item)
    }));
  };

  const addKeyVal = (type: 'params' | 'headers') => {
    setCurrentRequest(req => ({
      ...req,
      [type]: [...req[type], { id: Math.random().toString(36).substring(7), key: '', value: '', enabled: true }]
    }));
  };
  
  const removeKeyVal = (type: 'params' | 'headers', id: string) => {
    setCurrentRequest(req => ({
      ...req,
      [type]: req[type].filter(item => item.id !== id)
    }));
  };

  const methodColor = (m: string) => {
    if (m === 'GET') return 'text-emerald-400';
    if (m === 'POST') return 'text-amber-400';
    if (m === 'PUT') return 'text-blue-400';
    if (m === 'DELETE') return 'text-red-400';
    if (m === 'PATCH') return 'text-purple-400';
    return 'text-muted-foreground';
  };

  const renderKeyValEditor = (type: 'params' | 'headers') => {
    const items = currentRequest[type];
    return (
      <div className="space-y-2 p-4">
        {items.map(item => (
          <div key={item.id} className="flex items-center gap-2">
            <input type="checkbox" checked={item.enabled} onChange={(e) => updateKeyVal(type, item.id, 'enabled', e.target.checked)} className="cursor-pointer accent-primary" />
            <Input placeholder="Key" value={item.key} onChange={(e) => updateKeyVal(type, item.id, 'key', e.target.value)} className="h-8 text-xs bg-black/30 border-border/50" />
            <Input placeholder="Value" value={item.value} onChange={(e) => updateKeyVal(type, item.id, 'value', e.target.value)} className="h-8 text-xs bg-black/30 border-border/50" />
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0" onClick={() => removeKeyVal(type, item.id)}>
              <Trash2 className="size-3" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="h-7 text-xs mt-2" onClick={() => addKeyVal(type)}>
          <Plus className="size-3 mr-1" /> Add {type === 'params' ? 'Parameter' : 'Header'}
        </Button>
      </div>
    );
  };

  return (
    <div className="h-[calc(100vh-3rem)] w-full bg-background flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="h-11 border-b border-border/40 bg-card/30 flex items-center px-4 justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Activity className="size-5 text-primary" />
          <h1 className="font-semibold text-sm tracking-wide">API Tester</h1>
        </div>
        {response && (
          <div className="flex items-center gap-4 text-[11px] mono">
            <span className={`font-semibold flex items-center gap-1.5 ${response.status >= 200 && response.status < 300 ? 'text-emerald-400' : response.status === 0 ? 'text-red-400' : 'text-amber-400'}`}>
              <div className={`size-2 rounded-full ${response.status >= 200 && response.status < 300 ? 'bg-emerald-400' : response.status === 0 ? 'bg-red-400' : 'bg-amber-400'}`} />
              {response.status} {response.statusText}
            </span>
            <span className="text-muted-foreground flex items-center gap-1"><Clock className="size-3" /> {response.timeMs}ms</span>
            <span className="text-muted-foreground flex items-center gap-1"><HardDrive className="size-3" /> {(response.size / 1024).toFixed(1)}KB</span>
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* History sidebar — plain div, no resizable panel needed to avoid the sliding bug */}
        <div className="w-56 shrink-0 border-r border-border/40 bg-card/20 flex flex-col">
          <div className="p-3 border-b border-border/40 flex items-center justify-between shrink-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <History className="size-3.5" /> History
            </div>
            {history.length > 0 && (
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={clearHistory} title="Clear">
                <Trash2 className="size-3 text-muted-foreground hover:text-destructive" />
              </Button>
            )}
          </div>
          <div className="flex-1 overflow-auto p-2 space-y-1">
            {history.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-8">No request history yet</div>
            ) : (
              history.map(req => (
                <button
                  key={req.id}
                  onClick={() => loadFromHistory(req.id)}
                  className="w-full text-left p-2 rounded-lg bg-black/20 hover:bg-black/40 border border-transparent hover:border-border/50 cursor-pointer transition-all group"
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`text-[10px] font-bold ${methodColor(req.method)}`}>{req.method}</span>
                    <span className="text-[10px] text-muted-foreground truncate ml-auto">{new Date(req.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-[11px] truncate mono text-muted-foreground group-hover:text-foreground transition-colors">{req.url.replace(/^https?:\/\//, '')}</div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Request/Response area */}
        <div className="flex-1 flex flex-col min-w-0">
          <ResizablePanelGroup direction="vertical">
            {/* Top: Request Builder */}
            <ResizablePanel defaultSize={50} minSize={25}>
              <div className="h-full flex flex-col overflow-hidden">
                {/* URL bar */}
                <div className="p-3 border-b border-border/40 flex gap-2 items-center bg-card/10 shrink-0">
                  <select 
                    className={`h-9 bg-black/40 border border-border/50 rounded-lg px-3 text-sm font-bold outline-none focus:border-primary w-28 ${methodColor(currentRequest.method)}`}
                    value={currentRequest.method}
                    onChange={(e) => setCurrentRequest(r => ({ ...r, method: e.target.value }))}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="DELETE">DELETE</option>
                    <option value="PATCH">PATCH</option>
                  </select>
                  <Input 
                    placeholder="Enter request URL" 
                    className="flex-1 h-9 bg-black/30 border-border/50 mono text-sm"
                    value={currentRequest.url}
                    onChange={(e) => setCurrentRequest(r => ({ ...r, url: e.target.value }))}
                    onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                  />
                  <Button onClick={handleSend} disabled={isLoading} className="h-9 px-6 gap-2 font-semibold">
                    {isLoading ? <Activity className="size-4 animate-spin" /> : <Play className="size-4" />}
                    Send
                  </Button>
                </div>

                {/* Request Tabs */}
                <div className="flex items-center gap-6 px-4 border-b border-border/40 bg-card/20 pt-2 shrink-0">
                  {['Params', 'Headers', 'Body'].map(tab => (
                    <button 
                      key={tab}
                      onClick={() => setActiveReqTab(tab as any)}
                      className={`pb-2 text-xs font-medium border-b-2 transition-colors ${activeReqTab === tab ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                    >
                      {tab}
                      {(tab === 'Params' && currentRequest.params.length > 0) && <span className="ml-1.5 text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded-full">{currentRequest.params.length}</span>}
                      {(tab === 'Headers' && currentRequest.headers.length > 0) && <span className="ml-1.5 text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded-full">{currentRequest.headers.length}</span>}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                <div className="flex-1 overflow-auto bg-black/5">
                  {activeReqTab === 'Params' && renderKeyValEditor('params')}
                  {activeReqTab === 'Headers' && renderKeyValEditor('headers')}
                  {activeReqTab === 'Body' && (
                    <div className="h-full">
                      <Editor
                        height="100%"
                        defaultLanguage="json"
                        theme="vs-dark"
                        value={currentRequest.body}
                        onChange={(val) => setCurrentRequest(r => ({ ...r, body: val || '' }))}
                        options={{ minimap: { enabled: false }, fontSize: 12, wordWrap: 'on', scrollBeyondLastLine: false }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle withHandle />

            {/* Bottom: Response Viewer */}
            <ResizablePanel defaultSize={50} minSize={20}>
              <div className="h-full flex flex-col overflow-hidden">
                {/* Response tabs header */}
                <div className="h-9 border-b border-border/40 flex items-center justify-between px-4 bg-card/20 shrink-0">
                  <div className="flex items-center gap-5">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Response</span>
                    {['Body', 'Headers'].map(tab => (
                      <button 
                        key={tab}
                        onClick={() => setActiveResTab(tab as any)}
                        className={`text-xs font-medium transition-colors ${activeResTab === tab ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Response content */}
                <div className="flex-1 overflow-auto bg-black/10">
                  {!response && !isLoading && (
                    <div className="h-full flex flex-col items-center justify-center text-muted-foreground/40">
                      <Activity className="size-10 mb-3" />
                      <p className="text-sm">Send a request to see the response</p>
                    </div>
                  )}
                  {isLoading && (
                    <div className="h-full flex items-center justify-center">
                      <Activity className="size-8 text-primary animate-spin" />
                    </div>
                  )}
                  {response && !isLoading && activeResTab === 'Body' && (
                    response.error ? (
                      <div className="p-4 text-red-400 flex items-start gap-3 bg-red-500/5">
                        <AlertCircle className="size-5 shrink-0 mt-0.5" />
                        <div>
                          <h4 className="font-semibold text-sm mb-1">Request Failed</h4>
                          <p className="text-xs mono break-all">{response.error}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="h-full">
                        <Editor
                          height="100%"
                          defaultLanguage={typeof response.data === 'object' ? 'json' : 'html'}
                          theme="vs-dark"
                          value={typeof response.data === 'object' ? JSON.stringify(response.data, null, 2) : String(response.data)}
                          options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, wordWrap: 'on', scrollBeyondLastLine: false }}
                        />
                      </div>
                    )
                  )}
                  {response && !isLoading && activeResTab === 'Headers' && (
                    <div className="p-4">
                      <table className="w-full text-left text-xs mono">
                        <tbody>
                          {Object.entries(response.headers || {}).map(([key, val]) => (
                            <tr key={key} className="border-b border-border/20 last:border-0 hover:bg-white/5">
                              <td className="py-2 pr-4 font-semibold text-muted-foreground w-1/3 align-top">{key}</td>
                              <td className="py-2 break-all align-top">{val as string}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    </div>
  );
}
