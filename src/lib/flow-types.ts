// Shared types for test flows
export type StepKind = "navigate" | "click" | "input" | "wait" | "assert" | "scroll" | "press";

// Multi-signal fingerprint captured at record time. Used by the universal
// resolver at replay time instead of a single brittle CSS selector.
export type ElementFingerprint = {
  role?: string;
  accessibleName?: string;
  tagName: string;
  visibleText?: string;
  iconClass?: string | null;       // edit | delete | close | menu | add | search | back | settings | dropdown | toggle | view | hide | copy | shape:gear | svg:<hash>
  colorHint?: string | null;       // color:green | color:red | color:amber

  testId?: string;
  ariaLabel?: string;
  name?: string;
  href?: string;
  placeholder?: string;
  // Container that disambiguates repeated rows/cards
  containerRole?: string;
  containerKeyText?: string;
  // Structural hint
  ancestorRoles?: string[];
};

export type TestStep = {
  id: string;
  kind: StepKind;
  selector?: string;                  // legacy / manual fallback
  fingerprint?: ElementFingerprint;   // preferred — used by universal resolver
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
