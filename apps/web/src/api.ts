let csrf = '';
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrf ? { 'X-AW-CSRF': csrf } : {}), ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Request failed');
  return body as T;
}
export async function signIn(): Promise<void> {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('bootstrap');
  if (token) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    const session = await request<{ csrf: string }>('/api/session/bootstrap', { method: 'POST', body: JSON.stringify({ token }) });
    csrf = session.csrf;
  } else csrf = (await request<{ csrf: string }>('/api/session')).csrf;
}
