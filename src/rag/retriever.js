/**
 * Local Knowledge Retriever for RAGBot
 *
 * Reads config.json, knowledge.json, HTML documentation, and plain text
 * files from data/ragbot/. Allows easily changing the company name, bot name,
 * age, persona, and knowledge base documents.
 *
 * Provides tiered resolution:
 * 1. Checks local structured Q&A / HTML / text knowledge base.
 * 2. If matched above threshold, returns answer directly.
 * 3. If unmatched, returns fallback indicator to allow querying the connected LLM (Anthropic).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data/ragbot');

/** Stop words filtered during keyword extraction */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'i', 'me', 'my', 'you', 'your', 'we', 'our', 'what', 'which',
  'where', 'when', 'how', 'can', 'do', 'does', 'did', 'tell', 'about', 'please'
]);

/**
 * Tokenizes text into lowercase word tokens, omitting punctuation and stop words.
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * Strips HTML tags and extracts sections as clean text documents
 */
function parseHtmlSections(htmlContent) {
  const sections = [];
  const sectionRegex = /<section[^>]*>([\s\S]*?)<\/section>/gi;
  let match;
  while ((match = sectionRegex.exec(htmlContent)) !== null) {
    const rawSection = match[1];
    const titleMatch = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(rawSection);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'General Policy';
    const cleanContent = rawSection
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    sections.push({
      id: `html_${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      title,
      content: cleanContent,
    });
  }

  // If no <section> tags found, strip entire HTML
  if (sections.length === 0) {
    const cleanContent = htmlContent
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleanContent) {
      sections.push({ id: 'html_doc', title: 'HTML Document', content: cleanContent });
    }
  }

  return sections;
}

/**
 * Parses plain text / markdown into paragraphs or header sections
 */
function parseTextSections(textContent, filename) {
  const sections = [];
  const parts = textContent.split(/\n\s*#{1,3}\s+/);
  parts.forEach((part, index) => {
    const lines = part.trim().split('\n');
    const title = lines[0].replace(/^#+\s*/, '').trim();
    const content = lines.slice(1).join('\n').replace(/\s+/g, ' ').trim();
    if (content) {
      sections.push({
        id: `txt_${path.basename(filename, path.extname(filename))}_${index}`,
        title: title || `Doc ${index}`,
        content: `${title ? title + ': ' : ''}${content}`,
      });
    }
  });
  return sections;
}

export class RagKnowledgeBase {
  constructor(dataDir = DATA_DIR) {
    this.dataDir = dataDir;
    this.config = null;
    this.qaItems = [];
    this.docSections = [];
    this.reload();
  }

  /**
   * Reload configuration and all knowledge documents from disk
   */
  reload() {
    // 1. Load config
    const configPath = path.join(this.dataDir, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        this.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (err) {
        console.error('[RAG] Error reading config.json:', err.message);
      }
    }

    if (!this.config) {
      this.config = {
        company: { name: 'StarTelecom', supportPhone: '1-800-STAR-TEL' },
        agent: { name: 'Nova', age: '2 years', role: 'Support Agent' },
        retrieval: { matchThreshold: 0.35, fallbackToLLM: true }
      };
    }

    // 2. Load structured Q&A
    const qaPath = path.join(this.dataDir, 'knowledge.json');
    this.qaItems = [];
    if (fs.existsSync(qaPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(qaPath, 'utf-8'));
        this.qaItems = (Array.isArray(raw) ? raw : []).map(item => ({
          ...item,
          tokens: tokenize(`${item.keywords?.join(' ') || ''} ${item.answer || ''}`),
        }));
      } catch (err) {
        console.error('[RAG] Error reading knowledge.json:', err.message);
      }
    }

    // 3. Load HTML and TXT files
    this.docSections = [];
    if (fs.existsSync(this.dataDir)) {
      const files = fs.readdirSync(this.dataDir);
      for (const file of files) {
        const fullPath = path.join(this.dataDir, file);
        if (file.endsWith('.html') || file.endsWith('.htm')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const sections = parseHtmlSections(content);
          sections.forEach(s => {
            s.tokens = tokenize(`${s.title} ${s.content}`);
            this.docSections.push(s);
          });
        } else if (file.endsWith('.txt') || file.endsWith('.md')) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const sections = parseTextSections(content, file);
          sections.forEach(s => {
            s.tokens = tokenize(`${s.title} ${s.content}`);
            this.docSections.push(s);
          });
        }
      }
    }
  }

  /**
   * Interpolate {agent.name}, {agent.age}, {company.name}, etc.
   */
  interpolate(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/\{agent\.name\}/g, this.config.agent?.name || 'Nova')
      .replace(/\{agent\.age\}/g, this.config.agent?.age || '2 years')
      .replace(/\{agent\.role\}/g, this.config.agent?.role || 'Customer Support Specialist')
      .replace(/\{company\.name\}/g, this.config.company?.name || 'StarTelecom')
      .replace(/\{company\.supportPhone\}/g, this.config.company?.supportPhone || '1-800-STAR-TEL')
      .replace(/\{company\.website\}/g, this.config.company?.website || 'https://www.startelecom-fake.com')
      .replace(/\{company\.tagline\}/g, this.config.company?.tagline || 'Connecting you anywhere');
  }

  /**
   * Query local knowledge base. Returns { matched: boolean, answer?: string, score?: number }
   */
  query(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') {
      return { matched: false };
    }

    const queryClean = userMessage.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const queryTokens = tokenize(userMessage);
    const queryLower = userMessage.toLowerCase().trim();

    // 1. Direct Q&A phrase or exact keyword match
    let bestQa = null;
    let bestQaScore = 0;
    let bestKeywordMatch = null;
    let bestKeywordLength = 0;

    for (const item of this.qaItems) {
      if (Array.isArray(item.keywords)) {
        for (const kw of item.keywords) {
          const kwLower = kw.toLowerCase().trim();
          const kwClean = kwLower.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
          // Check for exact match or normalized punctuation match
          if (queryLower === kwLower || queryClean === kwClean) {
            return {
              matched: true,
              source: 'knowledge.json',
              id: item.id,
              score: 1.0,
              answer: `[${this.config.agent.name} @ ${this.config.company.name}] ${this.interpolate(item.answer)}`,
            };
          }
          // Substring match:
          // 1. If user query contains multi-word keyword phrase (e.g. "tell me about roaming pass")
          // 2. Or if keyword is a full single word and matches as a whole word in query (e.g. \broaming\b)
          const isWordBoundaryMatch = new RegExp(`\\b${kwLower.replace(/[^a-z0-9]/g, '\\$&')}\\b`).test(queryLower);
          if (queryLower.includes(kwLower) && (kwLower.includes(' ') || isWordBoundaryMatch)) {
            // Pick the most specific keyword match (longest keyword string)
            if (kwLower.length > bestKeywordLength) {
              bestKeywordLength = kwLower.length;
              bestKeywordMatch = item;
            }
          }
        }
      }

      // Token overlap score: Jaccard-like ratio against query
      if (queryTokens.length > 0) {
        const shared = queryTokens.filter(t => item.tokens.includes(t));
        const score = shared.length / Math.max(queryTokens.length, item.tokens.length * 0.4);
        if (score > bestQaScore) {
          bestQaScore = score;
          bestQa = item;
        }
      }
    }

    if (bestKeywordMatch) {
      return {
        matched: true,
        source: 'knowledge.json',
        id: bestKeywordMatch.id,
        score: 0.95,
        answer: `[${this.config.agent.name} @ ${this.config.company.name}] ${this.interpolate(bestKeywordMatch.answer)}`,
      };
    }

    const threshold = this.config.retrieval?.matchThreshold ?? 0.45;

    if (bestQa && bestQaScore >= threshold) {
      return {
        matched: true,
        source: 'knowledge.json',
        id: bestQa.id,
        score: bestQaScore,
        answer: `[${this.config.agent.name} @ ${this.config.company.name}] ${this.interpolate(bestQa.answer)}`,
      };
    }

    // 2. Search document sections (HTML & TXT)
    let bestDoc = null;
    let bestDocScore = 0;

    for (const section of this.docSections) {
      const shared = queryTokens.filter(t => section.tokens.includes(t));
      const score = shared.length / Math.max(queryTokens.length, 1);
      if (score > bestDocScore) {
        bestDocScore = score;
        bestDoc = section;
      }
    }

    if (bestDoc && bestDocScore >= threshold) {
      return {
        matched: true,
        source: bestDoc.id,
        title: bestDoc.title,
        score: bestDocScore,
        answer: `[${this.config.agent.name} @ ${this.config.company.name}]\n\n📖 **From ${this.config.company.name} Documentation (${bestDoc.title}):**\n\n${this.interpolate(bestDoc.content)}`,
      };
    }

    // No confident match in local files
    return {
      matched: false,
      bestScore: Math.max(bestQaScore, bestDocScore),
      config: this.config,
    };
  }
}

// Singleton instance
export const ragKnowledgeBase = new RagKnowledgeBase();
