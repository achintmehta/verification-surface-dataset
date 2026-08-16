const messagesDiv = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

function addMessage(message) {
  const div = document.createElement('div');
  div.className = 'message';
  const time = new Date(message.created_at).toLocaleTimeString();
  div.innerHTML = `
    <div>${escapeHtml(message.text)}</div>
    <div class="message-time">${time}</div>
  `;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
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
    messages.forEach(addMessage);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
  }
}

// Connect to SSE
function connectSSE() {
  const eventSource = new EventSource('/api/stream');
  
  eventSource.onmessage = (event) => {
    const message = JSON.parse(event.data);
    addMessage(message);
  };
  
  eventSource.onerror = (err) => {
    console.error('SSE error:', err);
  };
  
  return eventSource;
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
  }
});

// Initialize
fetchMessages();
connectSSE();