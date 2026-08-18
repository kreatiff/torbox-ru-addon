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
    throw new Error(`API error: ${res.statusText} (${res.status})`);
  }

  return res.json() as Promise<T>;
}
