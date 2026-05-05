const path = require('path');
const fs = require('fs');
const os = require('os');

const name = 'kiro-cli';
const sources = ['kiro-cli'];

const KIRO_CLI_DIR = path.join(os.homedir(), '.kiro', 'sessions', 'cli');

function getChats() {
  const chats = [];
  if (!fs.existsSync(KIRO_CLI_DIR)) return chats;

  try {
    const files = fs.readdirSync(KIRO_CLI_DIR).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const fullPath = path.join(KIRO_CLI_DIR, file);
      try {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const data = JSON.parse(raw);

        if (!data.session_id) continue;

        chats.push({
          source: 'kiro-cli',
          composerId: data.session_id,
          name: data.title || null,
          createdAt: data.created_at ? new Date(data.created_at).getTime() : null,
          lastUpdatedAt: data.updated_at ? new Date(data.updated_at).getTime() : null,
          mode: 'kiro',
          folder: data.cwd || null,
          encrypted: false,
          bubbleCount: 0, // We'll estimate this or leave it 0
          _fullPath: fullPath,
          _logPath: fullPath.replace('.json', '.jsonl'),
        });
      } catch (err) {
        // Skip malformed files
      }
    }
  } catch (err) {
    // Skip if directory is unreadable
  }

  return chats;
}

function getMessages(chat) {
  const messages = [];
  if (!chat._logPath || !fs.existsSync(chat._logPath)) return messages;

  try {
    const raw = fs.readFileSync(chat._logPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const data = entry.data;
        if (!data) continue;

        let role = null;
        if (entry.kind === 'Prompt') role = 'user';
        else if (entry.kind === 'AssistantMessage') role = 'assistant';
        else if (entry.kind === 'ToolResults') role = 'tool';

        if (!role) continue;

        let content = '';
        const parts = data.content || [];
        
        for (const part of parts) {
          if (part.kind === 'text') {
            content += part.data;
          } else if (part.kind === 'toolUse') {
            const toolName = part.data.name;
            const toolInput = JSON.stringify(part.data.input || {});
            content += `\n[tool-call: ${toolName}(${toolInput})]\n`;
          } else if (part.kind === 'toolResult') {
            const resultData = part.data.content || [];
            for (const r of resultData) {
              if (r.kind === 'text') content += r.data;
              else if (r.kind === 'json') content += JSON.stringify(r.data, null, 2);
            }
          }
        }

        if (content.trim() || role === 'tool') {
          messages.push({
            role,
            content: content.trim(),
            _model: data.model_id || null,
          });
        }
      } catch (err) {
        // Skip malformed lines
      }
    }
  } catch (err) {
    // Skip if file is unreadable
  }

  return messages;
}

const labels = {
  'kiro-cli': 'Kiro CLI',
};

function getArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  return scanArtifacts(folder, {
    editor: 'kiro-cli',
    label: 'Kiro CLI',
    files: ['AGENTS.md'],
    dirs: ['.kiro/specs', '.kiro/steering'],
  });
}

module.exports = { name, sources, labels, getChats, getMessages, getArtifacts };
