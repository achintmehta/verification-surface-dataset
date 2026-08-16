const API_URL = 'http://localhost:3000/api';

const messageList = document.getElementById('message-list');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

function renderMessage(message) {
  const div = document.createElement('div');
  div.className = 'message';
  
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = new Date(message.created_at).toLocaleString();
  
  const text = document.createElement('div');
  text.className = 'text';
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
  } catch (error) {
    console.error('Failed to fetch messages:', error);
  }
}

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.onmessage = (event) => {
    const message = JSON.parse(event.data);
    renderMessage(message);
  };

  eventSource.onerror = (error) => {
    console.error('SSE error:', error);
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
  } catch (error) {
    console.error('Error sending message:', error);
  }
});

// Initialize
fetchMessages().then(() => {
  setupSSE();
});
