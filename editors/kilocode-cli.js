const path = require('path');
const fs = require('fs');
const os = require('os');

const name = 'kilocode-cli';
const sources = ['kilocode-cli'];

function getKiloDbPath() {
  const paths = [];

  if (process.platform === 'win32') {
    paths.push(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'kilo', 'kilo.db'));
    // Fallback for Windows systems using Linux-style XDG paths
    paths.push(path.join(os.homedir(), '.local', 'share', 'kilo', 'kilo.db'));
  } else if (process.platform === 'darwin') {
    paths.push(path.join(os.homedir(), 'Library', 'Application Support', 'kilo', 'kilo.db'));
  } else {
    paths.push(path.join(os.homedir(), '.local', 'share', 'kilo', 'kilo.db'));
  }

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }

  return paths[0]; // Return default if none found
}

const KILO_DB_PATH = getKiloDbPath();

function getChats() {
  const chats = [];
  if (!fs.existsSync(KILO_DB_PATH)) return chats;

  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(KILO_DB_PATH, { readonly: true });
  } catch { return chats; }

  try {
    const sessions = db.prepare(`
      SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,
             (SELECT count(*) FROM message m WHERE m.session_id = s.id) as msg_count
      FROM session s
      ORDER BY s.time_updated DESC
    `).all();

    for (const session of sessions) {
      // Aggregate tokens for the session (optional but helpful for cost)
      let totalInput = 0;
      let totalOutput = 0;
      try {
        const msgs = db.prepare('SELECT data FROM message WHERE session_id = ?').all(session.id);
        for (const m of msgs) {
          const d = JSON.parse(m.data);
          if (d.tokens) {
            totalInput += (d.tokens.input || 0);
            totalOutput += (d.tokens.output || 0);
          }
        }
      } catch {}

      chats.push({
        source: 'kilocode-cli',
        composerId: session.id,
        name: session.title || null,
        createdAt: session.time_created || null,
        lastUpdatedAt: session.time_updated || null,
        mode: 'kilocode',
        folder: session.directory || null,
        encrypted: false,
        bubbleCount: session.msg_count || 0,
        _sessionId: session.id,
        _inputTokens: totalInput || undefined,
        _outputTokens: totalOutput || undefined,
      });
    }
  } catch {}

  try { db.close(); } catch {}
  return chats;
}

function getMessages(chat) {
  const messages = [];
  if (!chat._sessionId) return messages;

  if (!fs.existsSync(KILO_DB_PATH)) return messages;

  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(KILO_DB_PATH, { readonly: true });
  } catch { return messages; }

  try {
    const messagesData = db.prepare(`
      SELECT id, data, time_created, 'message' as _type
      FROM message
      WHERE session_id = ?
    `).all(chat._sessionId);

    const partsData = db.prepare(`
      SELECT id, data, time_created, 'part' as _type
      FROM part
      WHERE session_id = ?
    `).all(chat._sessionId);

    // Combine and sort by time_created to interleave messages and their parts
    const timeline = [...messagesData, ...partsData].sort((a, b) => a.time_created - b.time_created);

    let currentMsg = null;

    for (const item of timeline) {
      const data = JSON.parse(item.data);

      if (item._type === 'message') {
        // If we have a pending message, push it
        if (currentMsg && (currentMsg.content || currentMsg._toolCalls)) {
          messages.push(currentMsg);
        }

        // Start a new message
        const role = data.role === 'assistant' ? 'assistant' : 'user';
        currentMsg = {
          role,
          content: data.content || '',
          _model: data.model?.providerID && data.model?.modelID
            ? `${data.model.providerID}/${data.model.modelID}`
            : data.model?.modelID || null,
        };
        
        if (data.tokens) {
          if (data.tokens.input) currentMsg._inputTokens = data.tokens.input;
          if (data.tokens.output) currentMsg._outputTokens = data.tokens.output;
        }
      } else if (item._type === 'part' && currentMsg) {
        if (data.type === 'text' && data.text) {
          currentMsg.content += (currentMsg.content ? '\n\n' : '') + data.text;
        } else if (data.type === 'tool') {
          const toolName = data.tool || 'tool';
          const toolInput = data.state?.input || {};
          currentMsg.content += (currentMsg.content ? '\n\n' : '') + `[tool-call: ${toolName}]`;
          
          if (!currentMsg._toolCalls) currentMsg._toolCalls = [];
          currentMsg._toolCalls.push({ name: toolName, args: toolInput });

          if (data.state?.output && !data.state.error) {
            currentMsg.content += `\n[tool-result]\n${data.state.output}`;
          }
        } else if (data.type === 'file') {
          currentMsg.content += (currentMsg.content ? '\n\n' : '') + `[file: ${data.filename || data.url}]`;
        } else if (data.type === 'step-finish' && data.tokens) {
          if (data.tokens.input) currentMsg._inputTokens = data.tokens.input;
          if (data.tokens.output) currentMsg._outputTokens = data.tokens.output;
        }
      }
    }

    // Push the last message
    if (currentMsg && (currentMsg.content || currentMsg._toolCalls)) {
      messages.push(currentMsg);
    }
  } catch (err) {
    console.error('Kilo Code parse error:', err);
  }

  try { db.close(); } catch {}
  return messages;
}

function resetCache() {}

const labels = {
  'kilocode-cli': 'Kilo Code CLI',
};

module.exports = { name, sources, labels, getChats, getMessages, resetCache };