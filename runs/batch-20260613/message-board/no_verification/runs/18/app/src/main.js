const API_URL = 'http://localhost:3000/api';

const messagesContainer = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

function renderMessage(message) {
  const div = document.createElement('div');
  div.className = 'message';
  
  const textSpan = document.createElement('span');
  textSpan.textContent = message.text;
  
  const timeSpan = document.createElement('span');
  timeSpan.className = 'time';
  timeSpan.textContent = new Date(message.created_at).toLocaleString();
  
  div.appendChild(textSpan);
  div.appendChild(timeSpan);
  
  messagesContainer.appendChild(div);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
    const message = JSON.parse(event.data);
    renderMessage(message);
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
    await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
    
    messageInput.value = '';
  } catch (error) {
    console.error('Error posting message:', error);
  }
});

// Initialize
fetchMessages().then(setupSSE);
