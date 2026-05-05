const path = require('path');
const fs = require('fs');
const os = require('os');

const name = 'hermes';
const sources = ['hermes'];

/**
 * Locate the Hermes Agent directory.
 * Supports Windows (WSL) and native Linux/Mac.
 */
function getHermesDir() {
  const paths = [];
  
  if (process.platform === 'win32') {
    // Investigation revealed user 'lucky' on 'kali-linux' distribution
    // We prioritize this specific path but include defaults
    paths.push('\\\\wsl$\\kali-linux\\home\\lucky\\.hermes');
    paths.push(path.join(os.homedir(), '.hermes'));
  } else {
    paths.push(path.join(os.homedir(), '.hermes'));
  }

  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  
  return paths[0];
}

/**
 * Resolve WSL paths to Windows UNC paths if on Windows.
 */
function resolveFolder(workdir) {
  if (!workdir || process.platform !== 'win32') return workdir;

  // 1. Handle Windows drives mounted in WSL: /mnt/c/... -> C:\...
  const mntMatch = workdir.match(/^\/mnt\/([a-z])\/(.*)/);
  if (mntMatch) {
    const drive = mntMatch[1].toUpperCase();
    const rest = mntMatch[2].replace(/\//g, '\\');
    return `${drive}:\\${rest}`;
  }

  // 2. Handle WSL-native paths: /home/lucky/... -> \\wsl$\kali-linux\home\lucky\...
  if (workdir.startsWith('/')) {
    // We reuse the distribution info from getHermesDir logic
    return path.join('\\\\wsl$\\kali-linux', workdir.replace(/\//g, '\\'));
  }

  return workdir;
}

const HERMES_DIR = getHermesDir();
const SESSIONS_DIR = path.join(HERMES_DIR, 'sessions');

/**
 * List all sessions from the Hermes directory.
 */
function getChats() {
  const chats = [];
  if (!fs.existsSync(SESSIONS_DIR)) return chats;

  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      
      const filePath = path.join(SESSIONS_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) continue;

        const content = fs.readFileSync(filePath, 'utf-8');
        const session = JSON.parse(content);
        
        // Hermes sessions use an array of messages
        const messages = session.messages || [];
        
        // Extract a title from the first user message
        let title = session.session_id || file.replace('.json', '');
        const firstUserMsg = messages.find(m => m.role === 'user');
        if (firstUserMsg && firstUserMsg.content) {
          title = firstUserMsg.content.substring(0, 100).trim();
          if (firstUserMsg.content.length > 100) title += '...';
        }

        // Handle timestamps (Hermes uses ISO strings with microseconds)
        const parseTs = (ts) => ts ? new Date(ts.split('.')[0]).getTime() : null;

        // Try to find the folder/workdir if not directly available
        let extractedWorkdir = session.workdir || null;
        if (!extractedWorkdir) {
          for (const msg of messages) {
            if (!msg || !msg.content) continue;
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            try {
              const parsed = JSON.parse(content);
              if (parsed.output && typeof parsed.output === 'string') {
                const out = parsed.output.trim().split('\n')[0].trim();
                if (out.includes('/') || out.includes('\\')) {
                  const cleaned = out.replace(/[\`"',\)\};\\.]+$/, '');
                  const resolved = resolveFolder(cleaned);
                  if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                    extractedWorkdir = cleaned;
                    break;
                  }
                  if (!/\.(txt|md|js|ts|json|py|java|c|cpp|cs|go|rs|rb|php|html|css|sh|xml|yml|yaml|docx)$/i.test(cleaned)) {
                    extractedWorkdir = cleaned;
                    break;
                  }
                }
              }
            } catch {}

            const regex = /(?:(?:\/mnt\/[a-z]\/|\/home\/[a-zA-Z0-9_-]+\/|C:\\Users\\)[^\s"']+)/gi;
            const matches = content.match(regex);
            if (matches) {
              for (const m of matches) {
                const cleaned = m.replace(/[\`"',\)\};\\.]+$/, '');
                const resolved = resolveFolder(cleaned);
                if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                  extractedWorkdir = cleaned;
                  break;
                }
                if (!/\.(txt|md|js|ts|json|py|java|c|cpp|cs|go|rs|rb|php|html|css|sh|xml|yml|yaml|docx)$/i.test(cleaned)) {
                  extractedWorkdir = cleaned;
                  break;
                }
              }
            }
            if (extractedWorkdir) break;
          }
        }

        chats.push({
          source: 'hermes',
          composerId: session.session_id,
          name: title,
          createdAt: parseTs(session.session_start) || stats.birthtimeMs,
          lastUpdatedAt: parseTs(session.last_updated) || stats.mtimeMs,
          mode: 'hermes',
          folder: resolveFolder(extractedWorkdir) || null,
          bubbleCount: messages.length,
          _sessionId: session.session_id,
          _filePath: filePath,
          _model: session.model,
        });
      } catch (err) {
        // Skip malformed files
      }
    }
  } catch (err) {
    console.error('Hermes adapter error:', err);
  }

  // Sort by most recent
  chats.sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
  return chats;
}

/**
 * Get messages for a specific session.
 */
function getMessages(chat) {
  const messages = [];
  if (!chat._filePath || !fs.existsSync(chat._filePath)) return messages;

  try {
    const session = JSON.parse(fs.readFileSync(chat._filePath, 'utf-8'));
    if (!session.messages) return messages;

    for (const msg of session.messages) {
      const m = {
        role: msg.role,
        content: msg.content || '',
      };
      
      // Hermes stores "reasoning" or "reasoning_content" for assistant thoughts
      const reasoning = msg.reasoning || msg.reasoning_content;
      if (reasoning) {
        m._thoughts = reasoning;
      }
      
      // Model info per message if available, otherwise session level
      m._model = msg.model || session.model;
      
      messages.push(m);
    }
  } catch (err) {
    console.error('Hermes message parse error:', err);
  }

  return messages;
}

/**
 * Get artifacts for a project folder.
 */
function getArtifacts(folder) {
  const { scanArtifacts } = require('./base');
  return scanArtifacts(folder, {
    editor: 'hermes',
    label: 'Hermes Agent',
    files: ['AGENTS.md'],
    dirs: ['.hermes/plans', '.hermes/skills'],
  });
}

function resetCache() {}

const labels = {
  'hermes': 'Hermes Agent',
};

module.exports = { name, sources, labels, getChats, getMessages, getArtifacts, resetCache };

