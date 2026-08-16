const messagesContainer = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}

function renderMessage(msg) {
  const div = document.createElement('div');
  div.className = 'message';
  div.innerHTML = `
    <div>${escapeHtml(msg.text)}</div>
    <div class="time">${formatTime(msg.created_at)}</div>
  `;
  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function fetchMessages() {
  try {
    const res = await fetch('/api/messages');
    const messages = await res.json();
    messagesContainer.innerHTML = '';
    messages.forEach(renderMessage);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
  }
}

function connectSSE() {
  const eventSource = new EventSource('/api/stream');
  
  eventSource.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    renderMessage(msg);
  };
  
  eventSource.onerror = (err) => {
    console.error('SSE error:', err);
    // Optionally reconnect logic here
  };
  
  return eventSource;
}

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
  }
});

async function init() {
  await fetchMessages();
  connectSSE();
}

init();