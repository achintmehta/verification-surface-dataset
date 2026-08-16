import './style.css';

const API_BASE = 'http://localhost:3000/api';
const messagesContainer = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

// Format timestamp
function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}

// Render a single message
function renderMessage(message) {
  const messageEl = document.createElement('div');
  messageEl.className = 'message';
  messageEl.innerHTML = `
    <div class="message-text">${escapeHtml(message.text)}</div>
    <div class="message-time">${formatTime(message.created_at)}</div>
  `;
  messagesContainer.appendChild(messageEl);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
    const messages = await response.json();
    messagesContainer.innerHTML = '';
    messages.forEach(renderMessage);
  } catch (error) {
    console.error('Failed to fetch messages:', error);
    messagesContainer.innerHTML = '<p class="error">Failed to load messages</p>';
  }
}

// Connect to SSE for real-time updates
function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'connected') {
        console.log('Connected to SSE stream');
        return;
      }
      // New message received
      renderMessage(data);
    } catch (error) {
      console.error('Error parsing SSE message:', error);
    }
  };
  
  eventSource.onerror = (error) => {
    console.error('SSE connection error:', error);
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
    console.error('Failed to send message:', error);
    alert('Failed to send message. Is the server running?');
  }
});

// Initialize app
async function init() {
  await fetchMessages();
  connectSSE();
  input.focus();
}

init();