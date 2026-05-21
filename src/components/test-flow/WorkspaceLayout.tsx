import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ReactNode } from "react";

interface WorkspaceLayoutProps {
  sidebar: ReactNode;
  preview: ReactNode;
  inspector: ReactNode;
  network: ReactNode;
}

export function WorkspaceLayout({ sidebar, preview, inspector, network }: WorkspaceLayoutProps) {
  return (
    <div className="h-[calc(100vh-3rem)] w-full bg-background flex flex-col overflow-hidden">
      <div className="h-10 border-b border-border/60 flex items-center px-4 shrink-0 bg-card/50">
        <div className="font-semibold tracking-tight text-sm flex items-center gap-2">
          <span className="text-primary text-glow">⚡ QAforge</span> Workspace
        </div>
      </div>
      
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          {/* Left Sidebar */}
          <ResizablePanel defaultSize={15} minSize={10} maxSize={20}>
            <div className="h-full bg-card border-r border-border/60 overflow-y-auto p-2">
              {sidebar}
            </div>
          </ResizablePanel>
          
          <ResizableHandle withHandle />
          
          {/* Center (Preview + Network Bottom) */}
          <ResizablePanel defaultSize={60}>
            <ResizablePanelGroup direction="vertical">
              {/* Browser Preview Center */}
              <ResizablePanel defaultSize={70}>
                <div className="h-full bg-black/5 flex flex-col relative">
                  {preview}
                </div>
              </ResizablePanel>
              
              <ResizableHandle withHandle />
              
              {/* Network Bottom Console */}
              <ResizablePanel defaultSize={30} minSize={10}>
                <div className="h-full bg-card border-t border-border/60 overflow-hidden">
                  {network}
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          
          <ResizableHandle withHandle />
          
          {/* Right Inspector */}
          <ResizablePanel defaultSize={25} minSize={15} maxSize={40}>
            <div className="h-full bg-card border-l border-border/60 overflow-y-auto">
              {inspector}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
