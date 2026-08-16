const API_URL = 'http://localhost:3000/api';

const messagesContainer = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

function appendMessage(msg) {
  const div = document.createElement('div');
  div.className = 'message';
  
  const timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = new Date(msg.created_at).toLocaleTimeString();
  
  const textSpan = document.createElement('span');
  textSpan.textContent = msg.text;
  
  div.appendChild(timeSpan);
  div.appendChild(textSpan);
  
  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Fetch initial messages
async function fetchMessages() {
  try {
    const res = await fetch(`${API_URL}/messages`);
    const messages = await res.json();
    messages.forEach(appendMessage);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
  }
}

// Setup SSE
function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'connected') {
      console.log('Connected to SSE stream');
    } else {
      appendMessage(data);
    }
  };

  eventSource.onerror = (err) => {
    console.error('SSE error:', err);
  };
}

// Handle form submission
messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  try {
    await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
    messageInput.value = '';
  } catch (err) {
    console.error('Failed to send message:', err);
  }
});

// Initialize
fetchMessages().then(setupSSE);
