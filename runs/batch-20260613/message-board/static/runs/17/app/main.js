const API_URL = 'http://localhost:3000/api';

const messagesDiv = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

function renderMessage(msg) {
  const div = document.createElement('div');
  div.className = 'message';
  
  const text = document.createElement('div');
  text.textContent = msg.text;
  
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = new Date(msg.created_at).toLocaleString();
  
  div.appendChild(text);
  div.appendChild(time);
  
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

async function fetchMessages() {
  try {
    const response = await fetch(`${API_URL}/messages`);
    const messages = await response.json();
    messages.forEach(renderMessage);
  } catch (error) {
    console.error('Error fetching messages:', error);
  }
}

function setupSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.onmessage = (event) => {
    const newMessage = JSON.parse(event.data);
    renderMessage(newMessage);
  };
  
  eventSource.onerror = (error) => {
    console.error('SSE Error:', error);
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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
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