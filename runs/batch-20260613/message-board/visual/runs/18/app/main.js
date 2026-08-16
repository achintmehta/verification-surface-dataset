const messagesDiv = document.getElementById('messages');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');

const API_URL = 'http://localhost:3000/api';

function renderMessage(msg) {
  const div = document.createElement('div');
  div.className = 'message';
  const time = new Date(msg.created_at).toLocaleTimeString();
  const textDiv = document.createElement('div');
  textDiv.textContent = msg.text;
  const timeDiv = document.createElement('div');
  timeDiv.className = 'time';
  timeDiv.textContent = time;
  div.appendChild(textDiv);
  div.appendChild(timeDiv);
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

async function loadMessages() {
  try {
    const res = await fetch(`${API_URL}/messages`);
    const messages = await res.json();
    messages.forEach(renderMessage);
  } catch (err) {
    console.error('Failed to load messages:', err);
  }
}

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  eventSource.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    renderMessage(msg);
  };
  eventSource.onerror = (err) => {
    console.error('SSE error:', err);
  };
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value;
  if (!text) return;

  input.value = '';
  try {
    await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch (err) {
    console.error('Failed to send message:', err);
  }
});

loadMessages().then(setupSSE);
