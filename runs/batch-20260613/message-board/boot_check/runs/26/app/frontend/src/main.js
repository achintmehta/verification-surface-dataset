const messagesDiv = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

let lastMessageId = 0;

function renderMessage(message) {
  const div = document.createElement('div');
  div.className = 'message';
  const timestamp = new Date(message.created_at).toLocaleString();
  div.innerHTML = `
    <div>${escapeHtml(message.text)}</div>
    <div class="timestamp">${timestamp}</div>
  `;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
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
    messagesDiv.innerHTML = '';
    messages.forEach(msg => {
      renderMessage(msg);
      if (msg.id > lastMessageId) lastMessageId = msg.id;
    });
  } catch (err) {
    console.error('Failed to fetch messages:', err);
  }
}

function connectSSE() {
  const eventSource = new EventSource('/api/stream');

  eventSource.onmessage = (event) => {
    const message = JSON.parse(event.data);
    renderMessage(message);
  };

  eventSource.onerror = (err) => {
    console.error('SSE error:', err);
    eventSource.close();
    // Reconnect after delay
    setTimeout(connectSSE, 3000);
  };
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

// Initialize
fetchMessages();
connectSSE();