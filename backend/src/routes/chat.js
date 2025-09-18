const express = require('express');
const router = express.Router();
const ragPipeline = require('../utils/rag');
const newsFetcher = require('../utils/newsFetcher');
const { v4: uuidv4 } = require('uuid');

// In-memory sessions (replace with Redis later)
const sessions = new Map();
const createSession = () => {
  const id = uuidv4();
  sessions.set(id, { id, createdAt: new Date().toISOString(), messages: [] });
  return id;
};
const getSession = (id) => (id ? sessions.get(id) : undefined);

// Simple health check endpoint
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'News RAG Chatbot API',
    version: '1.0.0'
  });
});

// Create a new session
router.post('/api/session', (req, res) => {
  const sessionId = createSession();
  return res.json({ sessionId });
});

// Get history for a session
router.get('/api/history', (req, res) => {
  const { sessionId } = req.query;
  const session = getSession(sessionId);
  if (!session) return res.status(400).json({ error: 'Invalid sessionId' });
  return res.json({ sessionId, messages: session.messages });
});

// Clear history for a session
router.post('/api/clear', (req, res) => {
  const { sessionId } = req.body || {};
  const session = getSession(sessionId);
  if (!session) return res.status(400).json({ error: 'Invalid sessionId' });
  session.messages = [];
  return res.json({ status: 'ok' });
});

// Chat endpoint
router.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ 
        error: 'Message is required and must be a string' 
      });
    }

    // Resolve session (create if not provided/invalid)
    let sid = sessionId;
    if (!sid || !getSession(sid)) sid = createSession();
    const session = getSession(sid);

    // Persist user message
    session.messages.push({ role: 'user', content: message, timestamp: new Date().toISOString() });

    console.log(`\n=== New Chat Request (session: ${sid}) ===`);
    console.log(`Query: ${message}`);
    
    // Process the query
    const result = await ragPipeline.query(message);
    
    // Persist assistant message
    session.messages.push({ role: 'assistant', content: result.answer, timestamp: new Date().toISOString() });

    console.log('Response generated successfully');
    console.log('Answer length:', result.answer.length);
    
    res.json({
      sessionId: sid,
      answer: result.answer,
      sources: result.sources || [],
      history: session.messages
    });
    
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    res.status(500).json({
      error: 'Failed to process your request',
      details: error.message
    });
  }
});

// Ingest latest news into the RAG pipeline
router.post('/api/ingest', async (req, res) => {
  try {
    const limit = Number(req.body?.limit) || 30;
    console.log(`\n=== Ingesting latest news (limit=${limit}) ===`);
    await ragPipeline.initialize();
    const articles = await newsFetcher.fetchNews(limit);
    console.log(`Fetched ${articles.length} articles. Adding to pipeline...`);

    if (!articles.length) {
      return res.status(500).json({ error: 'No articles fetched from sources' });
    }

    const docs = articles.map(a => ({
      text: a.text,
      title: a.title,
      url: a.url,
      publishedAt: a.publishedAt
    }));

    await ragPipeline.addDocuments(docs);
    const count = (ragPipeline.documents || []).length;
    console.log(`Ingestion complete. Total documents in store: ${count}`);
    res.json({ status: 'ok', ingested: docs.length, totalDocuments: count });
  } catch (error) {
    console.error('Error during ingestion:', error);
    res.status(500).json({ error: 'Failed to ingest news', details: error.message });
  }
});

// Stats endpoint: how many documents are loaded
router.get('/api/stats', (req, res) => {
  const count = (ragPipeline.documents || []).length;
  res.json({ documents: count });
});

// Health check endpoint
router.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'News RAG Chatbot API'
  });
});

module.exports = router;
