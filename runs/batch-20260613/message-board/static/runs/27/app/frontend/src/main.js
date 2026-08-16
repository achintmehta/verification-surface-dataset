import './style.css';

const messagesContainer = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

let lastMessageId = 0;

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
    <div class="time">${formatTime(message.created_at)}</div>
  `;
  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Fetch historical messages
async function fetchMessages() {
  try {
    const res = await fetch('/api/messages');
    const messages = await res.json();
    messagesContainer.innerHTML = '';
    messages.forEach(msg => {
      renderMessage(msg);
      if (msg.id > lastMessageId) lastMessageId = msg.id;
    });
  } catch (err) {
    console.error('Failed to fetch messages:', err);
  }
}

// Connect to SSE for real-time updates
function connectSSE() {
  const eventSource = new EventSource('/api/stream');
  
  eventSource.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id > lastMessageId) {
      renderMessage(message);
      lastMessageId = message.id;
    }
  };
  
  eventSource.onerror = (err) => {
    console.error('SSE error:', err);
    // Attempt to reconnect after delay
    setTimeout(() => {
      eventSource.close();
      connectSSE();
    }, 5000);
  };
}

// Handle form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  try {
    await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    input.value = '';
  } catch (err) {
    console.error('Failed to send message:', err);
    alert('Failed to send message');
  }
});

// Initialize app
async function init() {
  await fetchMessages();
  connectSSE();
}

init();