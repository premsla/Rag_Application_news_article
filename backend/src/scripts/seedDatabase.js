require('dotenv').config();
const ragPipeline = require('../utils/rag');

// Mock news articles for testing
const mockArticles = [
  {
    title: 'AI Breakthrough in Natural Language Understanding',
    text: 'Researchers have made a significant breakthrough in AI that allows machines to better understand and generate human-like text. The new model shows improved performance on various language tasks.',
    url: 'https://example.com/ai-breakthrough',
    publishedAt: new Date().toISOString(),
    source: 'mock'
  },
  {
    title: 'Global Tech Conference Announces New Innovations',
    text: 'The annual tech conference unveiled several groundbreaking technologies, including advancements in quantum computing and renewable energy solutions.',
    url: 'https://example.com/tech-conference',
    publishedAt: new Date().toISOString(),
    source: 'mock'
  },
  {
    title: 'New Study Shows Benefits of Remote Work',
    text: 'A comprehensive study reveals that remote work has led to increased productivity and job satisfaction for many employees, though challenges in team collaboration remain.',
    url: 'https://example.com/remote-work-study',
    publishedAt: new Date().toISOString(),
    source: 'mock'
  },
  {
    title: 'Tech Giant Launches New Smartphone with Advanced Features',
    text: 'The latest smartphone from a leading tech company features an improved camera system, longer battery life, and enhanced security features.',
    url: 'https://example.com/new-smartphone',
    publishedAt: new Date().toISOString(),
    source: 'mock'
  },
  {
    title: 'Cybersecurity Threats on the Rise in 2025',
    text: 'A new report highlights the increasing sophistication of cyber attacks and the need for stronger security measures across all industries.',
    url: 'https://example.com/cybersecurity-report',
    publishedAt: new Date().toISOString(),
    source: 'mock'
  }
];

async function seedDatabase() {
  try {
    console.log('=== Starting database seeding with mock data ===');
    
    try {
      // Initialize RAG pipeline
      console.log('\n1. Initializing RAG pipeline...');
      await ragPipeline.initialize();
      console.log('✓ RAG pipeline initialized successfully');
    } catch (initError) {
      console.error('❌ Failed to initialize RAG pipeline:', initError);
      throw initError;
    }
    
    try {
      // Add mock articles to the pipeline
      console.log('\n2. Adding mock articles to the pipeline...');
      await ragPipeline.addDocuments(mockArticles);
      console.log('✓ Added 5 mock articles to the pipeline');
    } catch (addDocsError) {
      console.error('❌ Failed to add documents to pipeline:', addDocsError);
      throw addDocsError;
    }
    
    console.log('\n=== Database seeding completed successfully! ===');
    console.log('You can now test the RAG pipeline with queries.');
    
    try {
      // Test the pipeline with a sample query
      console.log('\n=== Testing the pipeline with a sample query ===');
      const testQuery = 'What are the latest AI breakthroughs?';
      console.log('\nQuery:', testQuery);
      
      console.log('\nProcessing query...');
      const result = await ragPipeline.query(testQuery);
      
      console.log('\n=== Test query results ===');
      console.log('\nAnswer:');
      console.log(result.answer);
      console.log('\nSources found:', result.sources.length);
      if (result.sources.length > 0) {
        console.log('\nSource titles:');
        result.sources.forEach((source, i) => {
          console.log(`${i + 1}. ${source.metadata.title}`);
        });
      }
      
    } catch (queryError) {
      console.error('❌ Query test failed:', queryError);
      throw queryError;
    }
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error in seed process:', error.message);
    if (error.response) {
      console.error('Error details:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

seedDatabase();
