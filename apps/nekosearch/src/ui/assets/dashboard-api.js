export function createDashboardApi() {
  const tokenFromLink = new URLSearchParams(window.location.hash.slice(1)).get(
    'token',
  );
  if (tokenFromLink) {
    sessionStorage.setItem('nekosearch-token', tokenFromLink);
    window.history.replaceState(null, '', window.location.pathname);
  }
  const token = sessionStorage.getItem('nekosearch-token');
  if (!token) return null;

  return {
    readCatalog: () => request('/api/catalog'),
    readUsageSettings: () => request('/api/usage/settings'),
    readUsage: (filters = {}) => {
      const parameters = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null && value !== '')
          parameters.set(key, String(value));
      }
      const query = parameters.size ? `?${parameters}` : '';
      return request(`/api/usage${query}`);
    },
    updateUsageSettings: (settings) =>
      request('/api/usage/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }),
    clearUsage: () => request('/api/usage', { method: 'DELETE' }),
    startJob: (input) =>
      request('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    readJob: (id) => request(`/api/jobs/${encodeURIComponent(id)}`),
  };

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error ?? 'The dashboard request failed.');
    return data;
  }
}
