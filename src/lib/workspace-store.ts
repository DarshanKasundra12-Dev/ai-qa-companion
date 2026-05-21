import { create } from "zustand";

interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  status?: number;
  body?: string | null;
  resourceType: string;
  timestamp: number;
}

interface SecurityIssue {
  url: string;
  type: string;
  name: string;
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  details: string;
}

interface WorkspaceState {
  isConnected: boolean;
  isRecording: boolean;
  targetUrl: string;
  networkRequests: NetworkRequest[];
  securityIssues: SecurityIssue[];
  selectedElement: any | null;
  
  setConnected: (val: boolean) => void;
  setRecording: (val: boolean) => void;
  setTargetUrl: (url: string) => void;
  addNetworkRequest: (req: NetworkRequest) => void;
  updateNetworkResponse: (url: string, status: number, body: string | null) => void;
  addSecurityIssues: (url: string, issues: any[]) => void;
  setSelectedElement: (el: any | null) => void;
  clearWorkspace: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  isConnected: false,
  isRecording: false,
  targetUrl: "",
  networkRequests: [],
  securityIssues: [],
  selectedElement: null,

  setConnected: (val) => set({ isConnected: val }),
  setRecording: (val) => set({ isRecording: val }),
  setTargetUrl: (url) => set({ targetUrl: url }),
  addNetworkRequest: (req) => 
    set((state) => ({ networkRequests: [...state.networkRequests, req] })),
  updateNetworkResponse: (url, status, body) =>
    set((state) => ({
      networkRequests: state.networkRequests.map((r) => 
        r.url === url ? { ...r, status, body } : r
      )
    })),
  addSecurityIssues: (url, issues) => 
    set((state) => ({ 
      securityIssues: [...state.securityIssues, ...issues.map(i => ({ ...i, url }))] 
    })),
  setSelectedElement: (el) => set({ selectedElement: el }),
  clearWorkspace: () => set({ networkRequests: [], securityIssues: [], selectedElement: null })
}));
