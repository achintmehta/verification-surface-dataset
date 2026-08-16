const messagesContainer = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

// Format timestamp
function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
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

// Fetch and render initial messages
async function loadMessages() {
  try {
    const response = await fetch('/api/messages');
    const messages = await response.json();
    messagesContainer.innerHTML = '';
    messages.forEach(msg => {
      messagesContainer.appendChild(renderMessage(msg));
    });
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  } catch (error) {
    console.error('Failed to load messages:', error);
  }
}

// Connect to SSE for real-time updates
function connectSSE() {
  const eventSource = new EventSource('/api/stream');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'connected') return; // ignore connect ping
      
      const messageEl = renderMessage(data);
      messagesContainer.appendChild(messageEl);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } catch (e) {
      console.error('Error parsing SSE message:', e);
    }
  };

  eventSource.onerror = (error) => {
    console.error('SSE error:', error);
    // Attempt to reconnect after delay
    setTimeout(() => {
      if (eventSource.readyState === EventSource.CLOSED) {
        connectSSE();
      }
    }, 5000);
  };

  return eventSource;
}

// Handle form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  try {
    const response = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (response.ok) {
      input.value = '';
    } else {
      const err = await response.json();
      alert('Error: ' + (err.error || 'Failed to send'));
    }
  } catch (error) {
    console.error('Failed to send message:', error);
    alert('Failed to send message');
  }
});

// Initialize app
async function init() {
  await loadMessages();
  connectSSE();
}

init();