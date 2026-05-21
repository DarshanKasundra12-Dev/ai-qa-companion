import { create } from 'zustand';

export interface KeyVal {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface ApiRequest {
  id: string;
  method: string;
  url: string;
  headers: KeyVal[];
  params: KeyVal[];
  body: string;
  timestamp: number;
}

export interface ApiResponse {
  status: number;
  statusText: string;
  timeMs: number;
  size: number;
  data: any;
  headers: Record<string, string>;
  error?: string;
}

interface ApiTesterState {
  currentRequest: ApiRequest;
  response: ApiResponse | null;
  history: ApiRequest[];
  isLoading: boolean;
  
  setCurrentRequest: (updater: (req: ApiRequest) => ApiRequest) => void;
  setResponse: (res: ApiResponse | null) => void;
  setLoading: (loading: boolean) => void;
  addToHistory: (req: ApiRequest) => void;
  loadFromHistory: (id: string) => void;
  clearHistory: () => void;
}

const defaultRequest: ApiRequest = {
  id: Math.random().toString(36).substring(7),
  method: 'GET',
  url: 'https://jsonplaceholder.typicode.com/todos/1',
  headers: [],
  params: [],
  body: '',
  timestamp: Date.now()
};

export const useApiStore = create<ApiTesterState>((set) => ({
  currentRequest: { ...defaultRequest },
  response: null,
  history: [],
  isLoading: false,

  setCurrentRequest: (updater) => set((state) => ({ currentRequest: updater(state.currentRequest) })),
  setResponse: (res) => set({ response: res }),
  setLoading: (loading) => set({ isLoading: loading }),
  
  addToHistory: (req) => set((state) => {
    // Only keep last 50 requests
    const newHistory = [req, ...state.history].slice(0, 50);
    return { history: newHistory };
  }),
  
  loadFromHistory: (id) => set((state) => {
    const req = state.history.find(r => r.id === id);
    if (req) {
      return { currentRequest: { ...req, id: Math.random().toString(36).substring(7) }, response: null };
    }
    return state;
  }),

  clearHistory: () => set({ history: [] })
}));
