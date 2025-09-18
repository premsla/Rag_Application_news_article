const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// Initialize Google Gemini for text generation
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Using the correct model name for Gemini API
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

// Embeddings + Vector DB configuration
const JINA_API_KEY = process.env.JINA_API_KEY || process.env.JINA_EMBEDDINGS_API_KEY;
const JINA_MODEL = process.env.JINA_MODEL || 'jina-embeddings-v2-base-en';
const CHROMA_URL = (process.env.CHROMA_DB_URL || '').replace(/\/$/, '');
const CHROMA_COLLECTION = process.env.CHROMA_COLLECTION || 'news_articles';
// Optional: Chroma Cloud authentication
const CHROMA_API_KEY = process.env.CHROMA_API_KEY || process.env.CHROMA_CLOUD_API_KEY;
const CHROMA_TENANT = process.env.CHROMA_TENANT;
const CHROMA_DATABASE = process.env.CHROMA_DATABASE;

function chromaHeaders() {
  const headers = {};
  if (CHROMA_API_KEY) headers['Authorization'] = `Bearer ${CHROMA_API_KEY}`;
  if (CHROMA_TENANT) headers['x-chroma-tenant'] = CHROMA_TENANT;
  if (CHROMA_DATABASE) headers['x-chroma-database'] = CHROMA_DATABASE;
  return headers;
}

// Simple text processing utilities
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Remove punctuation
    .split(/\s+/)
    .filter(word => word.length > 2); // Remove short tokens
}

function getWordFreq(tokens) {
  return tokens.reduce((freq, word) => {
    freq[word] = (freq[word] || 0) + 1;
    return freq;
  }, {});
}

function cosineSimilarity(vecA, vecB) {
  const words = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const word of words) {
    const a = vecA[word] || 0;
    const b = vecB[word] || 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  return normA === 0 || normB === 0
    ? 0
    : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

class RAGPipeline {
  constructor() {
    this.documents = [];
    this.documentVectors = [];
    this.initialized = false;
    // Track seen URLs to avoid duplicates across multiple ingestions
    this.urlSet = new Set();
    // Chroma state
    this.collectionId = null; // will store resolved collection id
  }

  async initialize() {
    if (this.initialized) return true;

    this.initialized = true;
    console.log('Initialized in-memory RAG pipeline');
    return true;
  }

  clear() {
    this.documents = [];
    this.documentVectors = [];
    this.urlSet = new Set();
    console.log('RAG in-memory store cleared');
  }

  // --- Embeddings + Chroma helpers ---
  async embedTexts(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    if (!JINA_API_KEY) {
      console.warn('Jina API key not set; skipping embeddings and using in-memory fallback');
      return [];
    }
    try {
      const resp = await axios.post(
        'https://api.jina.ai/v1/embeddings',
        { model: JINA_MODEL, input: texts },
        { headers: { Authorization: `Bearer ${JINA_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      const vectors = (resp.data?.data || []).map(d => d.embedding);
      return vectors;
    } catch (e) {
      console.error('Failed to fetch embeddings from Jina:', e.response?.data || e.message);
      return [];
    }
  }

  async ensureChromaCollection() {
    if (!CHROMA_URL) return null;
    try {
      // Try to get or create collection
      // 1) list collections by name (if supported)
      try {
        const q = await axios.get(`${CHROMA_URL}/api/v1/collections`, { timeout: 15000, headers: chromaHeaders() });
        const found = (q.data?.collections || []).find(c => c.name === CHROMA_COLLECTION);
        if (found) {
          this.collectionId = found.id;
          return this.collectionId;
        }
      } catch (_) {
        // ignore, will try create below
      }
      // 2) create
      const resp = await axios.post(
        `${CHROMA_URL}/api/v1/collections`,
        { name: CHROMA_COLLECTION, metadata: { description: 'News articles for RAG' } },
        { timeout: 15000, headers: chromaHeaders() }
      );
      this.collectionId = resp.data?.id || resp.data?.collection?.id || null;
      return this.collectionId;
    } catch (e) {
      console.error('Failed to ensure Chroma collection:', e.response?.data || e.message);
      return null;
    }
  }

  async chromaAdd(ids, documents, metadatas, embeddings) {
    if (!this.collectionId) return false;
    try {
      await axios.post(
        `${CHROMA_URL}/api/v1/collections/${this.collectionId}/add`,
        { ids, documents, metadatas, embeddings },
        { timeout: 60000, headers: chromaHeaders() }
      );
      return true;
    } catch (e) {
      console.error('Chroma add error:', e.response?.data || e.message);
      return false;
    }
  }

  async chromaQuery(queryEmb, k) {
    if (!this.collectionId) return null;
    try {
      const resp = await axios.post(
        `${CHROMA_URL}/api/v1/collections/${this.collectionId}/query`,
        { query_embeddings: [queryEmb], n_results: k },
        { timeout: 30000, headers: chromaHeaders() }
      );
      return resp.data; // expects { ids, distances, documents, metadatas }
    } catch (e) {
      console.error('Chroma query error:', e.response?.data || e.message);
      return null;
    }
  }

  async addDocuments(documents) {
    await this.initialize();

    // Store documents with metadata
    const newDocs = documents.map(doc => ({
      text: doc.text,
      metadata: {
        title: doc.title || '',
        url: doc.url || '',
        publishedAt: doc.publishedAt || new Date().toISOString(),
        source: 'news_feed'
      }
    }));

    // Deduplicate by URL first
    const toIndex = [];
    for (const doc of newDocs) {
      const urlKey = (doc.metadata.url || '').trim();
      if (urlKey && this.urlSet.has(urlKey)) continue;
      toIndex.push(doc);
      if (urlKey) this.urlSet.add(urlKey);
    }

    // Try vector store path first (Jina + Chroma)
    let vectored = false;
    if (JINA_API_KEY && CHROMA_URL) {
      const collectionId = await this.ensureChromaCollection();
      if (collectionId && toIndex.length) {
        const docsTexts = toIndex.map(d => d.text);
        const embeddings = await this.embedTexts(docsTexts);
        if (embeddings.length === toIndex.length) {
          const ids = toIndex.map((d, i) => `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`);
          const metadatas = toIndex.map(d => d.metadata);
          const ok = await this.chromaAdd(ids, docsTexts, metadatas, embeddings);
          if (ok) {
            console.log(`Indexed ${toIndex.length} documents into Chroma collection '${CHROMA_COLLECTION}'`);
            vectored = true;
          }
        } else {
          console.warn('Embeddings count mismatch; falling back to in-memory store');
        }
      }
    }

    // Always keep a minimal in-memory fallback corpus for safety
    let added = 0;
    for (const doc of toIndex) {
      const tokens = tokenize(doc.text);
      const vector = getWordFreq(tokens);
      this.documents.push(doc);
      this.documentVectors.push(vector);
      added++;
    }
    console.log(`Added ${added} docs to in-memory fallback${vectored ? ' (also stored in Chroma)' : ''}`);
  }

  async query(queryText, k = 3, useFallback = false) {
    try {
      console.log('=== Starting RAG Query ===');
      console.log('Query:', queryText);

      if (!this.initialized) {
        console.log('Initializing RAG pipeline...');
        await this.initialize();
      }

      // If Chroma is available, prefer vector retrieval
      let sourceDocs = null;
      let usedVectorStore = false;
      if (JINA_API_KEY && CHROMA_URL) {
        const collectionId = await this.ensureChromaCollection();
        if (collectionId) {
          const [queryEmb] = await this.embedTexts([queryText]);
          if (queryEmb && Array.isArray(queryEmb)) {
            const qr = await this.chromaQuery(queryEmb, k);
            if (qr && Array.isArray(qr.documents) && qr.documents[0]) {
              const docs = qr.documents[0];
              const metas = (qr.metadatas && qr.metadatas[0]) || [];
              sourceDocs = docs.map((content, i) => ({ content, metadata: metas[i] || {} }));
              usedVectorStore = true;
            }
          }
        }
      }

      // Fallback to in-memory matching when vector store not available
      if (!sourceDocs) {
        if (!this.documents || this.documents.length === 0) {
          const errorMsg = 'No documents found in the pipeline. Please add documents first.';
          console.error(errorMsg);
          return { answer: "I'm sorry, but I don't have any articles to search through yet.", sources: [] };
        }
        console.log(`Processing query with ${this.documents.length} documents (in-memory fallback)`);

        // Tokenize and create query vector
        const queryTokens = tokenize(queryText);
        if (!queryTokens.length) {
          return { answer: "I couldn't understand your query. Could you please rephrase it?", sources: [] };
        }
        const queryVector = getWordFreq(queryTokens);
        const scores = [];
        for (let i = 0; i < this.documentVectors.length; i++) {
          try {
            const score = cosineSimilarity(queryVector, this.documentVectors[i]);
            scores.push({ index: i, score });
          } catch (err) {
            scores.push({ index: i, score: 0 });
          }
        }
        const topK = scores.sort((a, b) => b.score - a.score).slice(0, k).filter(item => item.score > 0);
        if (topK.length === 0) {
          return { answer: "I couldn't find any relevant information to answer your question.", sources: [] };
        }
        sourceDocs = topK.map(item => ({ content: this.documents[item.index].text, metadata: this.documents[item.index].metadata }));
      }

      // Format context for the LLM
      const context = sourceDocs
        .map((doc, i) => (
          `Title: ${doc.metadata?.title || ''}\n` +
          `Source: ${doc.metadata?.url || ''}\n` +
          `Content: ${doc.content.substring(0, 500)}...`
        ))
        .join('\n\n');

      // If fallback is enabled
      if (useFallback) {
        console.log('Using fallback response generation (Gemini API not available)');
        const topDoc = sourceDocs[0];
        const fallbackResponse =
          `Based on the article "${topDoc.metadata.title}": ` +
          `${topDoc.content.substring(0, 150)}... ` +
          `[Read more: ${topDoc.metadata.url || 'No URL provided'}]`;

        return {
          answer: fallbackResponse,
          sources: sourceDocs,
          _debug: {
            usedFallback: true,
            context: context
          }
        };
      }

      // Try to use Gemini API
      try {
        console.log('Sending request to Gemini...');
        const prompt = [
          'You are a helpful news assistant. Answer the question based on the provided news articles.',
          'If the answer cannot be found in the articles, say "I don\'t have enough information to answer that."',
          'Use the following articles as context:',
          context,
          `\nQuestion: ${queryText}\nAnswer:`
        ].join('\n\n');

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        return {
          answer: text,
          sources: sourceDocs,
          _debug: {
            usedFallback: false,
            usedVectorStore,
            context: context
          }
        };
      } catch (apiError) {
        console.error('Error calling Gemini API:', apiError);
        if (useFallback) {
          // If we're already using fallback, rethrow
          throw apiError;
        }
        // Otherwise, retry with fallback enabled
        return this.query(queryText, k, true);
      }
    } catch (error) {
      console.error('Error in RAG query:', error);
      return {
        answer: "I'm sorry, I encountered an error while processing your request.",
        sources: []
      };
    }
  }
}

module.exports = new RAGPipeline();
