// Per-flow login recipe storage (localStorage only — credentials never leave the browser
// except inside the authenticated socket payload when a session starts).
export type LoginRecipe = {
  loginUrl: string;
  username: string;
  password: string;
  selectors: { username: string; password: string; submit: string };
};

const key = (testId: string) => `qaforge:login-recipe:${testId}`;

export function loadRecipe(testId: string): LoginRecipe | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key(testId));
    return raw ? (JSON.parse(raw) as LoginRecipe) : null;
  } catch {
    return null;
  }
}

export function saveRecipe(testId: string, recipe: LoginRecipe) {
  if (typeof window === "undefined") return;
  localStorage.setItem(key(testId), JSON.stringify(recipe));
}

export function clearRecipe(testId: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(key(testId));
}

export const emptyRecipe: LoginRecipe = {
  loginUrl: "",
  username: "",
  password: "",
  selectors: { username: "#email", password: "#password", submit: 'button[type="submit"]' },
};
