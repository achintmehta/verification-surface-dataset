const API_BASE = 'http://localhost:3000';
const messagesContainer = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

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
    <div class="message-text">${escapeHtml(message.text)}</div>
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

// Append message to DOM
function appendMessage(message) {
  const msgEl = renderMessage(message);
  messagesContainer.appendChild(msgEl);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Fetch historical messages
async function fetchMessages() {
  try {
    const response = await fetch(`${API_BASE}/api/messages`);
    if (!response.ok) throw new Error('Failed to fetch');
    const messages = await response.json();
    
    messagesContainer.innerHTML = '';
    messages.forEach(msg => {
      const msgEl = renderMessage(msg);
      messagesContainer.appendChild(msgEl);
    });
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  } catch (error) {
    console.error('Error fetching messages:', error);
    messagesContainer.innerHTML = '<p style="color: red; padding: 20px;">Failed to load messages. Is the server running?</p>';
  }
}

// Connect to SSE
function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/api/stream`);
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'connected') {
        console.log('Connected to SSE stream');
        return;
      }
      // New message
      appendMessage(data);
    } catch (e) {
      console.error('Error parsing SSE message:', e);
    }
  };
  
  eventSource.onerror = (error) => {
    console.error('SSE error:', error);
    // Optionally reconnect logic could be added
  };
  
  return eventSource;
}

// Handle form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const text = input.value.trim();
  if (!text) return;
  
  try {
    const response = await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    
    if (!response.ok) {
      throw new Error('Failed to send message');
    }
    
    // Clear input - message will arrive via SSE
    input.value = '';
  } catch (error) {
    console.error('Error sending message:', error);
    alert('Failed to send message. Please try again.');
  }
});

// Initialize app
async function init() {
  await fetchMessages();
  connectSSE();
  
  // Focus input
  input.focus();
}

init();