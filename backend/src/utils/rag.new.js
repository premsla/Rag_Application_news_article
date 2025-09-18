const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Google Gemini for text generation
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

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

  return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

class RAGPipeline {
  constructor() {
    this.documents = [];
    this.documentVectors = [];
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return true;
    console.log('Initializing RAG pipeline...');
    this.initialized = true;
    return true;
  }

  async addDocuments(documents) {
    await this.initialize();
    
    for (const doc of documents) {
      // Ensure document has required fields
      if (!doc.text || !doc.title) {
        console.warn('Skipping document missing required fields:', doc);
        continue;
      }
      
      // Store document with metadata
      const document = {
        text: doc.text,
        metadata: {
          title: doc.title,
          url: doc.url || '',
          publishedAt: doc.publishedAt || new Date().toISOString(),
          source: doc.source || 'unknown'
        }
      };
      
      // Create vector representation
      const tokens = tokenize(document.text);
      const vector = getWordFreq(tokens);
      
      // Store document and its vector
      this.documents.push(document);
      this.documentVectors.push(vector);
    }
    
    console.log(`Added ${documents.length} documents to the pipeline`);
    return true;
  }

  async query(queryText, k = 3, useFallback = true) {
    if (!this.initialized) await this.initialize();
    
    try {
      console.log('=== Starting RAG Query ===');
      console.log('Query:', queryText);
      
      if (this.documents.length === 0) {
        console.warn('No documents in the pipeline');
        return {
          answer: "I don't have any articles to search through yet.",
          sources: []
        };
      }
      
      // Process query
      console.log(`Processing query with ${this.documents.length} documents`);
      const queryTokens = tokenize(queryText);
      console.log('Query tokens:', queryTokens);
      
      if (queryTokens.length === 0) {
        return {
          answer: "I couldn't understand your query. Could you please rephrase it?",
          sources: []
        };
      }
      
      const queryVector = getWordFreq(queryTokens);
      console.log('Query vector created with', Object.keys(queryVector).length, 'unique terms');
      
      // Calculate similarity scores
      const scores = [];
      for (let i = 0; i < this.documentVectors.length; i++) {
        const score = cosineSimilarity(queryVector, this.documentVectors[i]);
        console.log(`Document ${i} score:`, score);
        scores.push({ index: i, score });
      }
      
      // Get top k results
      const topK = scores
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .filter(item => item.score > 0);
      
      console.log('Top K results:', JSON.stringify(topK, null, 2));
      
      if (topK.length === 0) {
        return {
          answer: "I couldn't find any relevant information to answer your question.",
          sources: []
        };
      }
      
      // Get the source documents
      const sourceDocs = topK.map(item => ({
        content: this.documents[item.index].text,
        metadata: this.documents[item.index].metadata
      }));
      
      // Format context for the LLM
      const context = topK.map((item, i) => {
        const doc = this.documents[item.index];
        console.log(`Including document: ${doc.metadata.title} (score: ${item.score})`);
        return (
          `Title: ${doc.metadata.title}\n` +
          `Relevance: ${(item.score * 100).toFixed(1)}%\n` +
          `Content: ${doc.text.substring(0, 200)}...`
        );
      }).join('\n\n');
      
      // If fallback is enabled and we have sources, use them to generate a basic response
      if (useFallback) {
        console.log('Using fallback response generation (Gemini API not available)');
        const topDoc = sourceDocs[0];
        const fallbackResponse = `Based on the article "${topDoc.metadata.title}": ` +
          `${topDoc.content.substring(0, 150)}... `;
        
        if (topDoc.metadata.url) {
          fallbackResponse += `[Read more: ${topDoc.metadata.url}]`;
        }
        
        return {
          answer: fallbackResponse,
          sources: sourceDocs,
          _debug: {
            usedFallback: true,
            context: context
          }
        };
      }
      
      // Try to use Gemini API if fallback is disabled
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
            context: context
          }
        };
        
      } catch (apiError) {
        console.error('Error calling Gemini API:', apiError);
        if (!useFallback) {
          // If fallback is not already enabled, retry with fallback
          return this.query(queryText, k, true);
        }
        throw apiError; // Re-throw if we're already using fallback
      }
      
    } catch (error) {
      console.error('Error in RAG query:', error);
      return {
        answer: "I'm sorry, I encountered an error while processing your request. " +
               (error.message ? `The error was: ${error.message}` : ''),
        sources: [],
        _debug: {
          error: error.message,
          stack: error.stack
        }
      };
    }
  }
}

module.exports = new RAGPipeline();
