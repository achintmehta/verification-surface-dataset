const API_URL = 'http://localhost:3000/api';

const messageList = document.getElementById('message-list');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

function renderMessage(message) {
  const div = document.createElement('div');
  div.className = 'message';
  
  const time = document.createElement('div');
  time.className = 'message-time';
  time.textContent = new Date(message.created_at).toLocaleString();
  
  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = message.text;
  
  div.appendChild(time);
  div.appendChild(text);
  
  messageList.appendChild(div);
  messageList.scrollTop = messageList.scrollHeight;
}

async function fetchMessages() {
  try {
    const response = await fetch(`${API_URL}/messages`);
    const messages = await response.json();
    messages.forEach(renderMessage);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
  }
}

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.onmessage = (event) => {
    const message = JSON.parse(event.data);
    renderMessage(message);
  };
  
  eventSource.onerror = (err) => {
    console.error('SSE error:', err);
  };
}

messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const text = messageInput.value.trim();
  if (!text) return;
  
  try {
    const response = await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
    
    if (response.ok) {
      messageInput.value = '';
    } else {
      console.error('Failed to send message');
    }
  } catch (err) {
    console.error('Error sending message:', err);
  }
});

// Initialize
fetchMessages().then(() => {
  setupSSE();
});
