const path = require('path');
const fs = require('fs');
const os = require('os');

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const TMP_DIR = path.join(GEMINI_DIR, 'tmp');
const PROJECTS_JSON = path.join(GEMINI_DIR, 'projects.json');

// ============================================================
// Adapter interface
// ============================================================

const name = 'gemini-cli';

/**
 * Load project path mapping from ~/.gemini/projects.json
 * Format: { "projects": { "/Users/dev/Code/myapp": "myapp" } }
 * Returns Map<projectName, folderPath>
 */
function loadProjectMap() {
  const map = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8'));
    if (data.projects) {
      for (const [folderPath, projName] of Object.entries(data.projects)) {
        map.set(projName, folderPath);
      }
    }
  } catch {}
  return map;
}

function getChats() {
  const chats = [];
  if (!fs.existsSync(TMP_DIR)) return chats;

  const projectMap = loadProjectMap();

  // Each subdirectory under tmp/ is a project name (e.g. "codename-share")
  let projectDirs;
  try { projectDirs = fs.readdirSync(TMP_DIR); } catch { return chats; }

  for (const projName of projectDirs) {
    const projDir = path.join(TMP_DIR, projName);
    try { if (!fs.statSync(projDir).isDirectory()) continue; } catch { continue; }

    // Sessions are in <projDir>/chats/session-*.json
    const chatsDir = path.join(projDir, 'chats');
    if (!fs.existsSync(chatsDir)) continue;

    let files;
    try {
      files = fs.readdirSync(chatsDir).filter(f => (f.startsWith('session-') && (f.endsWith('.json') || f.endsWith('.jsonl'))));
    } catch { continue; }

    // Resolve folder from projects.json mapping
    const folder = projectMap.get(projName) || null;

    for (const file of files) {
      const fullPath = path.join(chatsDir, file);
      try {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        let record = null;
        let messages = [];

        if (file.endsWith('.jsonl')) {
          const lines = raw.split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.sessionId && !record) record = obj;
              if (obj.type && (obj.type === 'user' || obj.type === 'gemini')) messages.push(obj);
              if (obj.$set && obj.$set.lastUpdated && record) record.lastUpdated = obj.$set.lastUpdated;
            } catch {}
          }
        } else {
          record = JSON.parse(raw);
          messages = record.messages || [];
        }

        if (!record) continue;

        const sessionId = record.sessionId || file.replace(/\.jsonl?$/, '');
        const firstUser = messages.find(m => m.type === 'user');
        const firstPrompt = extractTextContent(firstUser?.content);

        chats.push({
          source: 'gemini-cli',
          composerId: sessionId,
          name: firstPrompt ? cleanPrompt(firstPrompt) : null,
          createdAt: record.startTime ? new Date(record.startTime).getTime() : null,
          lastUpdatedAt: record.lastUpdated ? new Date(record.lastUpdated).getTime() : null,
          mode: 'gemini',
          folder,
          encrypted: false,
          bubbleCount: messages.length,
          _fullPath: fullPath,
        });
      } catch { /* skip malformed files */ }
    }
  }

  return chats;
}

function cleanPrompt(text) {
  if (!text) return null;
  return text.replace(/\s+/g, ' ').trim().substring(0, 120) || null;
}

function extractTextContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  // Array of { text } parts (user messages)
  if (Array.isArray(content)) {
    return content
      .filter(p => p.text)
      .map(p => p.text)
      .join('\n') || '';
  }
  if (content.text) return content.text;
  return '';
}

function getMessages(chat) {
  const filePath = chat._fullPath;
  if (!filePath || !fs.existsSync(filePath)) return [];

  let messages = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (filePath.endsWith('.jsonl')) {
      const lines = raw.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type) messages.push(obj);
        } catch {}
      }
    } else {
      const record = JSON.parse(raw);
      messages = record.messages || [];
    }
  } catch { return []; }

  if (messages.length === 0) return [];

  const result = [];
  for (const msg of messages) {
    const type = msg.type;
    const text = extractTextContent(msg.content || msg.displayContent);

    if (type === 'user') {
      if (text) result.push({ role: 'user', content: text });
    } else if (type === 'gemini') {
      const parts = [];
      const toolCalls = [];

      // Thoughts have { subject, description, timestamp }
      if (msg.thoughts && Array.isArray(msg.thoughts)) {
        for (const t of msg.thoughts) {
          const thought = t.description || t.subject || '';
          if (thought) parts.push(`[thinking] ${thought}`);
        }
      }

      // Main text content (string for gemini messages)
      if (text) parts.push(text);

      // Tool calls
      if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const args = tc.args || {};
          const argKeys = typeof args === 'object' ? Object.keys(args).join(', ') : '';
          parts.push(`[tool-call: ${tc.name || 'unknown'}(${argKeys})]`);
          toolCalls.push({ name: tc.name || 'unknown', args });
        }
      }

      if (parts.length > 0) {
        const tokens = msg.tokens || {};
        result.push({
          role: 'assistant',
          content: parts.join('\n'),
          _model: msg.model,
          _inputTokens: tokens.input,
          _outputTokens: tokens.output,
          _cacheRead: tokens.cached,
          _toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      }
    } else if (type === 'info' || type === 'error' || type === 'warning') {
      if (text) result.push({ role: 'system', content: `[${type}] ${text}` });
    }
  }

  return result;
}

const labels = { 'gemini-cli': 'Gemini CLI' };

function getArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  return scanArtifacts(folder, {
    editor: 'gemini-cli',
    label: 'Gemini CLI',
    files: ['GEMINI.md'],
    dirs: [],
  });
}

function getMCPServers() {
  const { parseMcpConfigFile } = require('./base');
  // Global: ~/.gemini/settings.json (mcpServers key)
  const globalSettings = path.join(os.homedir(), '.gemini', 'settings.json');
  return [
    ...parseMcpConfigFile(globalSettings, { editor: 'gemini-cli', label: 'Gemini CLI', scope: 'global' }),
  ];
}

module.exports = { name, labels, getChats, getMessages, getArtifacts, getMCPServers };
