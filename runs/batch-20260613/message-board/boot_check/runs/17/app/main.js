const messagesDiv = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

const API_URL = 'http://localhost:3000/api';

function renderMessage(msg) {
  const div = document.createElement('div');
  div.className = 'message';
  
  const textDiv = document.createElement('div');
  textDiv.textContent = msg.text;
  
  const timeDiv = document.createElement('div');
  timeDiv.className = 'time';
  timeDiv.textContent = new Date(msg.created_at).toLocaleString();
  
  div.appendChild(textDiv);
  div.appendChild(timeDiv);
  
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

async function fetchMessages() {
  try {
    const res = await fetch(`${API_URL}/messages`);
    const messages = await res.json();
    messages.forEach(renderMessage);
  } catch (err) {
    console.error('Failed to fetch messages:', err);
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

messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const text = messageInput.value.trim();
  if (!text) return;
  
  try {
    const res = await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
    
    if (res.ok) {
      messageInput.value = '';
    } else {
      console.error('Failed to send message');
    }
  } catch (err) {
    console.error('Error sending message:', err);
  }
});

// Initialize
fetchMessages().then(setupSSE);
