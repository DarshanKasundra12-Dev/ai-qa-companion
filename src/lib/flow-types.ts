// Shared types for test flows
export type StepKind = "navigate" | "click" | "input" | "wait" | "assert" | "scroll" | "press";

export type TestStep = {
  id: string;
  kind: StepKind;
  selector?: string;
  value?: string;
  description?: string;
};

export type ApiCall = {
  id: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  status?: number;
  durationMs?: number;
  triggeredByStepId?: string | null;
  payload?: string;
  response?: string;
};

export const STEP_LABEL: Record<StepKind, string> = {
  navigate: "Navigate",
  click: "Click",
  input: "Input",
  wait: "Wait",
  assert: "Assert",
  scroll: "Scroll",
  press: "Press Key",
};
