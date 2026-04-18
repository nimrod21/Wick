const BASE = ''; // same origin via next.config.mjs rewrites -> 127.0.0.1:3001

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get:  <T>(p: string)             => request<T>('GET',    p),
  post: <T>(p: string, b: unknown) => request<T>('POST',   p, b),
  put:  <T>(p: string, b: unknown) => request<T>('PUT',    p, b),
  del:  <T>(p: string)             => request<T>('DELETE', p),
};
