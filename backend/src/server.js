require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// API Routes
const chatRoutes = require('./routes/chat');
app.use('/', chatRoutes);

// Serve static files from the React app in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../frontend/build')));
  
  // Handle React routing, return all requests to React app
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../../frontend/build', 'index.html'));
  });
}

// WebSocket setup
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

// In-memory session storage (will be replaced with Redis)
const sessions = new Map();

// Generate a new session ID
const generateSessionId = () => uuidv4();

// WebSocket connection handler
io.on('connection', (socket) => {
  console.log('New client connected');
  
  // Initialize a new session
  const sessionId = generateSessionId();
  sessions.set(sessionId, {
    messages: [],
    createdAt: new Date()
  });
  
  // Send the session ID to the client
  socket.emit('session_init', { sessionId });

  // Handle incoming messages
  socket.on('send_message', async (data) => {
    const { sessionId, message } = data;
    const session = sessions.get(sessionId);
    
    if (!session) {
      socket.emit('error', { message: 'Invalid session' });
      return;
    }

    // Add user message to session
    session.messages.push({ role: 'user', content: message });
    
    // TODO: Implement RAG pipeline here
    // For now, just echo the message
    const botResponse = `I received your message: "${message}". This will be replaced with RAG response.`;
    
    // Add bot response to session
    session.messages.push({ role: 'assistant', content: botResponse });
    
    // Send response back to client
    socket.emit('receive_message', { 
      role: 'assistant', 
      content: botResponse 
    });
  });

  // Handle session clearing
  socket.on('clear_session', ({ sessionId }) => {
    if (sessions.has(sessionId)) {
      sessions.set(sessionId, {
        messages: [],
        createdAt: new Date()
      });
      socket.emit('session_cleared');
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = { app, server };
