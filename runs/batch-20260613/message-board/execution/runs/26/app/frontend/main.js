import './style.css';

const API_BASE = 'http://localhost:3000/api';
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
    <p class="message-text">${escapeHtml(message.text)}</p>
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
    const response = await fetch(`${API_BASE}/messages`);
    if (!response.ok) throw new Error('Failed to fetch');
    const messages = await response.json();
    
    messagesContainer.innerHTML = '';
    messages.forEach(msg => {
      const el = renderMessage(msg);
      messagesContainer.appendChild(el);
    });
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  } catch (error) {
    console.error('Error loading messages:', error);
    messagesContainer.innerHTML = '<p style="color: red;">Failed to load messages</p>';
  }
}

// Connect to SSE for real-time updates
function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);
  
  eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'message' && payload.data) {
        const el = renderMessage(payload.data);
        messagesContainer.appendChild(el);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  };
  
  eventSource.onerror = (error) => {
    console.error('SSE error:', error);
    // Optionally reconnect logic here
  };
  
  return eventSource;
}

// Handle form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const text = input.value.trim();
  if (!text) return;
  
  const submitBtn = form.querySelector('button');
  submitBtn.disabled = true;
  
  try {
    const response = await fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    
    if (!response.ok) {
      throw new Error('Failed to post message');
    }
    
    input.value = '';
  } catch (error) {
    console.error('Error posting message:', error);
    alert('Failed to send message. Please try again.');
  } finally {
    submitBtn.disabled = false;
    input.focus();
  }
});

// Initialize app
async function init() {
  await loadMessages();
  connectSSE();
  input.focus();
}

init();