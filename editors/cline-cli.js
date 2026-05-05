const path = require('path');
const fs = require('fs');
const os = require('os');

const name = 'cline-cli';
const sources = ['cline-cli'];

function getClineDir() {
  const paths = [];
  if (process.platform === 'win32') {
    paths.push(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'cline'));
    paths.push(path.join(os.homedir(), '.cline'));
  } else if (process.platform === 'darwin') {
    paths.push(path.join(os.homedir(), 'Library', 'Application Support', 'cline'));
  } else {
    paths.push(path.join(os.homedir(), '.cline'));
  }

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return paths[0];
}

const CLINE_DIR = getClineDir();
const CLINE_DATA_DIR = path.join(CLINE_DIR, 'data');

function getSessionsDir() {
  const sessionsPath = path.join(CLINE_DATA_DIR, 'sessions');
  const tasksPath = path.join(CLINE_DATA_DIR, 'tasks');

  if (fs.existsSync(tasksPath)) return tasksPath;
  return sessionsPath;
}

const SESSIONS_DIR = getSessionsDir();

function getChats() {
  const chats = [];
  if (!fs.existsSync(SESSIONS_DIR)) return chats;

  try {
    const sessionDirs = fs.readdirSync(SESSIONS_DIR);
    for (const sessionDir of sessionDirs) {
      const sessionPath = path.join(SESSIONS_DIR, sessionDir);
      if (!fs.statSync(sessionPath).isDirectory()) continue;

      const uiMessagesPath = path.join(sessionPath, 'ui_messages.json');
      if (!fs.existsSync(uiMessagesPath)) continue;

      let messages = [];
      try {
        messages = JSON.parse(fs.readFileSync(uiMessagesPath, 'utf-8'));
      } catch { continue; }

      if (!Array.isArray(messages) || messages.length === 0) continue;

      // The first message is usually the task prompt
      const taskMessage = messages.find(m => m.type === 'say' && m.say === 'task');
      const prompt = taskMessage ? taskMessage.text : null;

      // Extract folder (CWD) from the first api_req_started message if possible
      let folder = null;
      const firstApiReq = messages.find(m => m.type === 'say' && m.say === 'api_req_started');
      if (firstApiReq && firstApiReq.text) {
        try {
          const data = JSON.parse(firstApiReq.text);
          const request = data.request || '';
          const cwdMatch = request.match(/Current Working Directory \((.*?)\) Files/);
          if (cwdMatch) {
            folder = cwdMatch[1].replace(/\\/g, '/');
          }
        } catch {}
      }

      const startedAt = messages[0].ts || null;
      const endedAt = messages[messages.length - 1].ts || startedAt;

      chats.push({
        source: 'cline-cli',
        composerId: sessionDir,
        name: prompt ? (prompt.length > 100 ? prompt.substring(0, 100) + '...' : prompt) : 'Untitled Task',
        createdAt: startedAt,
        lastUpdatedAt: endedAt,
        mode: 'cline-cli',
        folder,
        encrypted: false,
        bubbleCount: messages.length,
        _sessionId: sessionDir,
        _messagesPath: uiMessagesPath,
      });
    }
  } catch { }

  chats.sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
  return chats;
}

function getMessages(chat) {
  const messages = [];
  if (!chat._messagesPath || !fs.existsSync(chat._messagesPath)) return messages;

  try {
    const rawMessages = JSON.parse(fs.readFileSync(chat._messagesPath, 'utf-8'));

    for (const msg of rawMessages) {
      let role = null;
      let content = '';
      let toolCalls = null;

      if (msg.type === 'say') {
        if (msg.say === 'task') {
          role = 'user';
          content = msg.text || '';
        } else if (msg.say === 'api_req_started' && msg.text) {
          // This contains the assistant's request and thought process
          try {
            const data = JSON.parse(msg.text);
            role = 'assistant';
            content = data.request || '';
            // If it has usage data, extract it
            if (data.tokensIn || data.tokensOut) {
              msg._usage = { input: data.tokensIn, output: data.tokensOut };
            }
          } catch { }
        } else if (msg.say === 'user_feedback') {
          role = 'user';
          content = msg.text || '';
        } else if (msg.say === 'reasoning') {
          role = 'assistant';
          content = msg.text || '';
        } else if (msg.say === 'tool_use' && msg.text) {
          role = 'assistant';
          content = `[tool-call: ${msg.say}] ${msg.text}`;
        }
      } else if (msg.type === 'ask') {
        if (msg.ask === 'followup' && msg.text) {
          try {
            const data = JSON.parse(msg.text);
            role = 'assistant';
            content = data.question || '';
          } catch { }
        } else if (msg.ask === 'command' && msg.text) {
          role = 'assistant';
          content = `[command] ${msg.text}`;
        }
      }

      if (role && content) {
        const m = { role, content };
        if (msg.modelInfo?.modelId) m._model = msg.modelInfo.modelId;
        if (msg._usage) {
          m._inputTokens = msg._usage.input;
          m._outputTokens = msg._usage.output;
        }
        messages.push(m);
      }
    }
  } catch { }

  return messages;
}

function resetCache() { }

function getMCPServers() {
  const { parseMcpConfigFile } = require('./base');
  const configPath = path.join(CLINE_DATA_DIR, 'settings', 'cline_mcp_settings.json');
  return parseMcpConfigFile(configPath, { editor: 'cline-cli', label: 'Cline CLI', scope: 'global' });
}

const labels = {
  'cline-cli': 'Cline CLI',
};

module.exports = { name, sources, labels, getChats, getMessages, resetCache, getMCPServers };