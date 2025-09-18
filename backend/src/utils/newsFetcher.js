const Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const axios = require('axios');

const parser = new Parser();

class NewsFetcher {
  constructor() {
    this.sources = [
      {
        name: 'BBC News',
        url: 'http://feeds.bbci.co.uk/news/rss.xml',
        type: 'rss'
      },
      {
        name: 'Reuters',
        url: 'http://feeds.reuters.com/reuters/topNews',
        type: 'rss'
      },
      // Add more sources as needed
    ];
  }

  async fetchRSSFeed(url) {
    try {
      const feed = await parser.parseURL(url);
      return feed.items.map(item => ({
        title: item.title,
        url: item.link,
        publishedAt: item.pubDate || new Date().toISOString(),
        source: 'rss'
      }));
    } catch (error) {
      console.error(`Error fetching RSS feed ${url}:`, error.message);
      return [];
    }
  }

  async extractArticleContent(url) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      const dom = new JSDOM(response.data, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      
      return {
        text: article.textContent,
        title: article.title,
        excerpt: article.excerpt,
        length: article.length
      };
    } catch (error) {
      console.error(`Error extracting content from ${url}:`, error.message);
      return null;
    }
  }

  async fetchNews(limit = 50) {
    const allArticles = [];
    
    for (const source of this.sources) {
      if (allArticles.length >= limit) break;
      
      try {
        let articles = [];
        
        if (source.type === 'rss') {
          articles = await this.fetchRSSFeed(source.url);
        }
        
        // Process articles to get full content
        for (const article of articles) {
          if (allArticles.length >= limit) break;
          
          const content = await this.extractArticleContent(article.url);
          if (content) {
            allArticles.push({
              ...article,
              text: `${content.title}\n\n${content.text}`,
              contentLength: content.length
            });
          }
          
          // Add small delay to avoid being blocked
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error(`Error processing source ${source.name}:`, error.message);
      }
    }
    
    return allArticles;
  }
}

module.exports = new NewsFetcher();
