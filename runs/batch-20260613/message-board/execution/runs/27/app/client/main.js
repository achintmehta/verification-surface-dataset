import './style.css'

const API_BASE = ''; // Uses Vite proxy in dev, or same origin in prod

document.querySelector('#app').innerHTML = `
  <div class="message-board">
    <h1>📋 Realtime Message Board</h1>
    
    <div class="messages-container">
      <h2>Messages</h2>
      <div id="messages" class="messages"></div>
    </div>

    <form id="message-form" class="message-form">
      <input 
        type="text" 
        id="message-input" 
        placeholder="Type your message here..." 
        required 
        autocomplete="off"
      />
      <button type="submit">Send</button>
    </form>
  </div>
`

// DOM elements
const messagesEl = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

// Render a single message
function renderMessage(message) {
  const messageEl = document.createElement('div');
  messageEl.className = 'message';
  messageEl.innerHTML = `
    <div class="message-text">${escapeHtml(message.text)}</div>
    <div class="message-time">${new Date(message.created_at).toLocaleTimeString()}</div>
  `;
  messagesEl.appendChild(messageEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Fetch historical messages
async function fetchMessages() {
  try {
    const response = await fetch(`${API_BASE}/api/messages`);
    if (!response.ok) throw new Error('Failed to fetch');
    const messages = await response.json();
    messagesEl.innerHTML = '';
    messages.forEach(renderMessage);
  } catch (error) {
    console.error('Error fetching messages:', error);
    messagesEl.innerHTML = '<p class="error">Failed to load messages. Is the server running?</p>';
  }
}

// Connect to SSE for real-time updates
function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/api/stream`);
  
  eventSource.onmessage = (event) => {
    const message = JSON.parse(event.data);
    renderMessage(message);
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

  try {
    const response = await fetch(`${API_BASE}/api/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      throw new Error('Failed to post message');
    }

    input.value = '';
    // Message will be received via SSE, no need to render here
  } catch (error) {
    console.error('Error posting message:', error);
    alert('Failed to send message. Please try again.');
  }
});

// Initialize the app
async function init() {
  await fetchMessages();
  connectSSE();
  input.focus();
}

init();