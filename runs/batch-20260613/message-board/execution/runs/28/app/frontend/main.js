const API_BASE = 'http://localhost:3000/api';
const messagesContainer = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');
const statusEl = document.getElementById('status');

// Format timestamp
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Render a single message
function renderMessage(message) {
  const div = document.createElement('div');
  div.className = 'message';
  div.innerHTML = `
    <div>${escapeHtml(message.text)}</div>
    <div class="message-time">${formatTime(message.created_at)}</div>
  `;
  return div;
}

// Simple HTML escape
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Fetch historical messages
async function fetchMessages() {
  try {
    const response = await fetch(`${API_BASE}/messages`);
    if (!response.ok) throw new Error('Failed to fetch');
    const messages = await response.json();
    
    messagesContainer.innerHTML = '';
    messages.forEach(msg => {
      messagesContainer.appendChild(renderMessage(msg));
    });
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  } catch (error) {
    console.error('Error fetching messages:', error);
    statusEl.textContent = 'Error loading messages';
    statusEl.style.color = '#dc3545';
  }
}

// Connect to SSE stream
function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onopen = () => {
    statusEl.textContent = 'Connected - Live updates active';
    statusEl.style.color = '#28a745';
  };
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'new_message' && data.message) {
        const msgEl = renderMessage(data.message);
        messagesContainer.appendChild(msgEl);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      } else if (data.type === 'connected') {
        // Initial connection confirmation
      }
    } catch (e) {
      console.error('Error parsing SSE message:', e);
    }
  };
  
  eventSource.onerror = () => {
    statusEl.textContent = 'Connection lost - Reconnecting...';
    statusEl.style.color = '#dc3545';
  };
  
  return eventSource;
}

// Handle form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const text = input.value.trim();
  if (!text) return;
  
  try {
    const response = await fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    
    if (response.ok) {
      input.value = '';
    } else {
      const error = await response.json();
      alert('Error: ' + (error.error || 'Failed to send message'));
    }
  } catch (error) {
    console.error('Error sending message:', error);
    alert('Failed to send message. Is the server running?');
  }
});

// Initialize app
async function init() {
  await fetchMessages();
  connectSSE();
}

init();