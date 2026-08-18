export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...options,
    credentials: 'include',
    headers: {
      ...options.headers,
    },
  });

  if (res.status === 401) {
    // Session expired or missing -- reload so the login page is shown.
    window.location.reload();
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    // Routes like POST/PATCH /api/titles return a JSON {error: "..."} body
    // with their non-2xx status (e.g. 409 on a provider-id conflict) --
    // surface that specific message instead of the generic status text
    // whenever the body parses as JSON with one.
    let detail = res.statusText;
    try {
      const body = (await res.clone().json()) as { error?: string };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      // Non-JSON error body -- fall back to statusText above.
    }
    throw new Error(`API error: ${detail} (${res.status})`);
  }

  return res.json() as Promise<T>;
}
