const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const IP_WHITELIST = process.env.IP_WHITELIST.split(",") || [];
const AUTH_TOKENS = process.env.API_AUTHTOKEN.split(",") || [];

app.set('trust proxy', 1); /* number of proxies between user and server */

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false // Disable for development
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

app.use(function(req, res, next) {
  //console.log("REQUEST_URL", req.method, req.url, req.headers, req.body, req.query, req.params);
  const REQ_URI = req.url.split("?")[0];
  const MY_IP = req.headers['x-forwarded-for']?req.headers['x-forwarded-for']:(req.headers['x-real-ip']?req.headers['x-real-ip']:"-");
  
  if(req.headers.authorization==null && req.headers['apikey']!=null) {
    req.headers.authorization = `Bearer ${req.headers['apikey']}`;
  }

  //ByPass
  if(["/cron"].indexOf(REQ_URI)>=0) {
    return next();
  }

  //Header Authorization
  if(["/addNote"].indexOf(REQ_URI)>=0) {
    if(req.headers.authorization==null || req.headers.authorization.length<=0) {
      res.status(403).send("Unauthorised");
      return;
    }

    var authToken = req.headers.authorization.split(" ");
    if(authToken[1]==null) authToken[1] = "";

    if(AUTH_TOKENS.indexOf(authToken[1])>=0) {
      return next();
    }

    res.status(403).send("Unauthorised");
    return;
  }

  if(IP_WHITELIST.length>0 && IP_WHITELIST[0].length>0) {
    if(IP_WHITELIST.indexOf(MY_IP)<0) {
      console.error("IP WHITELIST FAILURE", MY_IP);

      res.status(403).send("Unauthorised");
      return;
    }
  }
  
  return next();
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'app_notebook',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// Database connection
let db;

async function initializeDatabase() {
  try {
    // Create connection
    db = await mysql.createPool(dbConfig);
    console.log('Database connected successfully');
    
    // Create tables if they don't exist
    await createTables();
  } catch (error) {
    console.error('Database initialization error:', error);
    process.exit(1);
  }
}

async function createTables() {
  // Create tables
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title varchar(255),
        content longtext,
        is_favorite tinyint NOT NULL DEFAULT '0',
        is_archived tinyint NOT NULL DEFAULT '0',
        is_processed tinyint NOT NULL DEFAULT '0',
        blocked varchar(10),
        author varchar(155),
        shared_with varchar(500),
        created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    

  

    await db.execute(`
      CREATE TABLE IF NOT EXISTS tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        color VARCHAR(7) DEFAULT '#007bff',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS note_tags (
        note_id INT,
        tag_id INT,
        author varchar(155),
        PRIMARY KEY (note_id, tag_id),
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('Database tables created successfully');
  } catch (error) {
    console.error('Error creating tables:', error);
  }
}

// Helper function to generate title from content
function generateTitle(content) {
  // Remove hashtags and extra whitespace
  const cleanContent = content.replace(/#\w+/g, '').trim();
  
  // Take first 50 characters and find last complete word
  let title = cleanContent.split("\n")[0].substring(0, 50);
  const lastSpace = title.lastIndexOf(' ');
  
  if (lastSpace > 20 && cleanContent.length > 50) {
    title = title.substring(0, lastSpace) + '...';
  }
  
  return title || 'Untitled Note';
}

// Helper function to extract hashtags
function extractHashtags(content) {
  const hashtagRegex = /#(\w+)/g;
  const hashtags = [];
  let match;
  
  while ((match = hashtagRegex.exec(content)) !== null) {
    hashtags.push(match[1].toLowerCase());
  }
  
  return [...new Set(hashtags)]; // Remove duplicates
}

// Helper function to generate random color
function generateRandomColor(tagName) {
  const tagColors = [
    "#5737D7", "#D63F9A", "#F95959", "#5E7DFA", "#27CA69",
    "#43B79F", "#A100C9", "#BE02BE", "#C1AA4B", "#5ED276",
    "#3DA5BF", "#2BFCFC", "#37C015", "#92EF07", "#0808F6",
    "#1FDD91", "#B75E47", "#5E1DBF", "#EF0C67", "#9EFB61",
    "#E6E60D", "#206FE6", "#9C0EFB", "#B44C06", "#C6F609",
    "#5CDA5C", "#B47A24", "#4794C7", "#E24766", "#E318BA"
  ];
  
  if(tagName==null) return tagColors[Math.floor(Math.random() * tagColors.length)];
  else {
    const hash = hashCode(tagName);
    return tagColors[Math.abs(hash) % tagColors.length];
  }
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash;
}

// Routes

// Get all notes with tags
app.post('/api/notes', async (req, res) => {
  try {
    const { tag, search, author } = req.body;
    let query = `
      SELECT DISTINCT n.*, GROUP_CONCAT(t.name) as tags
      FROM notes n
      LEFT JOIN note_tags nt ON n.id = nt.note_id
      LEFT JOIN tags t ON nt.tag_id = t.id
    `;
    
    const conditions = ["1=1 AND n.author=?"];
    const params = [author];
    
    if (tag) {
      conditions.push('t.name = ?');
      params.push(tag);
    }
    
    if (search) {
      conditions.push('(n.title LIKE ? OR n.content LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    
    if (conditions.length > 0) {
      query += ' WHERE n.blocked="false" AND ' + conditions.join(' AND ');
    }
    
    query += ' GROUP BY n.id ORDER BY n.updated_at DESC';
    
    const [rows] = await db.execute(query, params);
    
    const notes = rows.map(note => ({
      ...note,
      tags: note.tags ? note.tags.split(',') : []
    }));
    
    res.json(notes);
  } catch (error) {
    console.error('Error fetching notes:', error);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// Get all tags
app.post('/api/tags', async (req, res) => {
  try {
    const { author } = req.body;

    const [rows] = await db.execute(`
      SELECT t.*, COUNT(nt.note_id) as note_count
      FROM tags t
      LEFT JOIN note_tags nt ON t.id = nt.tag_id
      WHERE nt.author=?
      GROUP BY t.id
      ORDER BY note_count DESC, t.name ASC
    `, [author]);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// Create a new note
app.post('/api/notes/create', async (req, res) => {
  try {
    var { content, author } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }
    
    if (!author || !author.trim()) {
      author = "";
    }

    const title = generateTitle(content);
    const hashtags = extractHashtags(content);
    
    // Insert note
    const [noteResult] = await db.execute(
      'INSERT INTO notes (title, content, author) VALUES (?, ?, ?)',
      [title, content, author]
    );
    
    const noteId = noteResult.insertId;
    
    // Process hashtags
    for (const tagName of hashtags) {
      // Insert tag if it doesn't exist
      await db.execute(
        'INSERT IGNORE INTO tags (name, color) VALUES (?, ?)',
        [tagName, generateRandomColor(tagName)]
      );
      
      // Get tag ID
      const [tagRows] = await db.execute(
        'SELECT id FROM tags WHERE name = ?',
        [tagName]
      );
      
      const tagId = tagRows[0].id;
      
      // Link note to tag
      await db.execute(
        'INSERT INTO note_tags (note_id, tag_id, author) VALUES (?, ?, ?)',
        [noteId, tagId, author]
      );
    }
    
    res.status(201).json({ 
      id: noteId, 
      title, 
      content, 
      tags: hashtags 
    });
  } catch (error) {
    console.error('Error creating note:', error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// Update a note
app.put('/api/notes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { content, author } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }
    
    const title = generateTitle(content);
    const hashtags = extractHashtags(content);
    
    // Update note
    await db.execute(
      'UPDATE notes SET title = ?, content = ? WHERE id = ?',
      [title, content, id]
    );
    
    // Remove existing tag associations
    await db.execute('DELETE FROM note_tags WHERE note_id = ?', [id]);
    
    // Process new hashtags
    for (const tagName of hashtags) {
      await db.execute(
        'INSERT IGNORE INTO tags (name, color) VALUES (?, ?)',
        [tagName, generateRandomColor(tagName)]
      );
      
      const [tagRows] = await db.execute(
        'SELECT id FROM tags WHERE name = ?',
        [tagName]
      );
      
      const tagId = tagRows[0].id;
      
      await db.execute(
        'INSERT INTO note_tags (note_id, tag_id, author) VALUES (?, ?, ?)',
        [id, tagId, author]
      );
    }
    
    res.json({ id, title, content, tags: hashtags });
  } catch (error) {
    console.error('Error updating note:', error);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

// Delete a note
app.delete('/api/notes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    //await db.execute('DELETE FROM notes WHERE id = ?', [id]);
    await db.execute('UPDATE notes SET blocked="true" WHERE id = ?', [id]);
    res.json({ message: 'Note deleted successfully' });
  } catch (error) {
    console.error('Error deleting note:', error);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

//Cron Job to process unprocessed notes
app.get('/cron', async (req, res) => {
  res.send("okay");
  return next();
})

// Add URL via various remote methods
app.get('/addNote', async (req, res) => {
  try {
    var { note, author } = req.query;
    
    if (!note || !note.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }

    if (!author || !author.trim()) {
      author = "";
    }
    
    const title = generateTitle(note);
    const hashtags = extractHashtags(note);
    
    // Insert note
    const [noteResult] = await db.execute(
      'INSERT INTO notes (title, content, author) VALUES (?, ?, ?)',
      [title, note, author]
    );
    
    const noteId = noteResult.insertId;
    
    // Process hashtags
    for (const tagName of hashtags) {
      // Insert tag if it doesn't exist
      await db.execute(
        'INSERT IGNORE INTO tags (name, color) VALUES (?, ?)',
        [tagName, generateRandomColor(tagName)]
      );
      
      // Get tag ID
      const [tagRows] = await db.execute(
        'SELECT id FROM tags WHERE name = ?',
        [tagName]
      );
      
      const tagId = tagRows[0].id;
      
      // Link note to tag
      await db.execute(
        'INSERT INTO note_tags (note_id, tag_id, author) VALUES (?, ?, ?)',
        [noteId, tagId, author]
      );
    }
    
    res.status(200).json({ 
      id: noteId, 
      title, 
      note, 
      tags: hashtags 
    });
  } catch (error) {
    console.error('Error creating note:', error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

app.post('/addNote', async (req, res) => {
  try {
    var { note, author } = req.body;
    
    if (!note || !note.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }

    if (!author || !author.trim()) {
      author = "";
    }
    
    const title = generateTitle(note);
    const hashtags = extractHashtags(note);
    
    // Insert note
    const [noteResult] = await db.execute(
      'INSERT INTO notes (title, content, author) VALUES (?, ?, ?)',
      [title, note, author]
    );
    
    const noteId = noteResult.insertId;
    
    // Process hashtags
    for (const tagName of hashtags) {
      // Insert tag if it doesn't exist
      await db.execute(
        'INSERT IGNORE INTO tags (name, color) VALUES (?, ?)',
        [tagName, generateRandomColor(tagName)]
      );
      
      // Get tag ID
      const [tagRows] = await db.execute(
        'SELECT id FROM tags WHERE name = ?',
        [tagName]
      );
      
      const tagId = tagRows[0].id;
      
      // Link note to tag
      await db.execute(
        'INSERT INTO note_tags (note_id, tag_id, author) VALUES (?, ?, ?)',
        [noteId, tagId, author]
      );
    }
    
    res.status(200).json({ 
      id: noteId, 
      title, 
      note, 
      tags: hashtags 
    });
  } catch (error) {
    console.error('Error creating note:', error);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize database and start server
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});

module.exports = app;
