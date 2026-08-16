const BASE_URL = '/api';

async function handleResponse(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

export const api = {
  async getEvents(start, end) {
    const params = new URLSearchParams({ start, end });
    const response = await fetch(`${BASE_URL}/events?${params}`);
    return handleResponse(response);
  },

  async createEvent(event) {
    const response = await fetch(`${BASE_URL}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    return handleResponse(response);
  },

  async updateEvent(id, event) {
    const response = await fetch(`${BASE_URL}/events/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    return handleResponse(response);
  },

  async deleteEvent(id) {
    const response = await fetch(`${BASE_URL}/events/${id}`, {
      method: 'DELETE'
    });
    return handleResponse(response);
  }
};
