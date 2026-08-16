const messagesDiv = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

const API_URL = '/api';

function appendMessage(msg) {
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
