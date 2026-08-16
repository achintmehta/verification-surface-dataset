import './style.css';

const messagesDiv = document.getElementById('messages');
const form = document.getElementById('form');
const input = document.getElementById('input');

function addMessage(msg, isNew = false) {
  const el = document.createElement('div');
  el.className = 'message';
  const time = new Date(msg.created_at).toLocaleTimeString();
  el.innerHTML = `<span class="time">[${time}]</span> ${escapeHtml(msg.text)}`;
  messagesDiv.appendChild(el);
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
    if (!res.ok) throw new Error('Failed to fetch');
    const msgs = await res.json();
    messagesDiv.innerHTML = '';
    msgs.forEach(msg => addMessage(msg));
  } catch (err) {
    console.error(err);
    messagesDiv.innerHTML = '<div class="error">Failed to load messages</div>';
  }
}

// Connect to SSE for real-time updates
const eventSource = new EventSource('/api/stream');
eventSource.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  addMessage(msg, true);
};
eventSource.onerror = (err) => {
  console.error('SSE error', err);
};

// Handle form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  try {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error('Failed to post');
    input.value = '';
  } catch (err) {
    console.error(err);
    alert('Failed to send message');
  }
});

// Load initial messages
fetchMessages();