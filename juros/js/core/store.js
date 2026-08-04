// Wrapper simples e seguro sobre localStorage (nunca lança erro).

const PREFIX = "juros-compostos:";

export const KEYS = {
  STATE: `${PREFIX}state-v1`,
};

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
