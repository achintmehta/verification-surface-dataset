const API_URL = 'http://localhost:3000/api';

const messageList = document.getElementById('message-list');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

// Render a single message
function renderMessage(message) {
  const div = document.createElement('div');
  div.className = 'message';
  
  const textSpan = document.createElement('span');
  textSpan.textContent = message.text;
  
  const timeSpan = document.createElement('span');
  timeSpan.className = 'message-time';
  timeSpan.textContent = new Date(message.created_at).toLocaleTimeString();
  
  div.appendChild(textSpan);
  div.appendChild(timeSpan);
  
  messageList.appendChild(div);
  messageList.scrollTop = messageList.scrollHeight;
}

// Fetch historical messages
async function fetchMessages() {
  try {
    const response = await fetch(`${API_URL}/messages`);
    const messages = await response.json();
    messages.forEach(renderMessage);
  } catch (error) {
    console.error('Error fetching messages:', error);
  }
}

// Connect to SSE
function connectSSE() {
  const eventSource = new EventSource(`${API_URL}/stream`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type !== 'connected') {
      renderMessage(data);
    }
  };
  
  eventSource.onerror = (error) => {
    console.error('SSE Error:', error);
    eventSource.close();
    // Attempt to reconnect after 5 seconds
    setTimeout(connectSSE, 5000);
  };
}

// Handle form submission
messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const text = messageInput.value.trim();
  if (!text) return;
  
  messageInput.value = '';
  
  try {
    await fetch(`${API_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
  } catch (error) {
    console.error('Error posting message:', error);
  }
});

// Initialize
fetchMessages().then(() => {
  connectSSE();
});
