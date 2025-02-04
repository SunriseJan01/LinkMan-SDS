const express = require("express");
const crypto = require("crypto");
const cors = require("cors");
const fs = require("node:fs/promises");
const axios = require('axios');


// Initialize Express app
const app = express();
app.use(express.json());
app.use(cors());
const host = 'localhost:3000';
const webhost = '127.0.0.1:3000';


const STORAGE_PATHS = {
    links: './data/links.json',
    logs: './data/logs.json',
    binds: './data/binds.json'
};

// Storage functions
async function loadStorage(path) {
    try {
        const data = await fs.readFile(path, 'utf8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

async function saveStorage(path, data) {
    await fs.mkdir('./data', { recursive: true });
    await fs.writeFile(path, JSON.stringify(data, null, 2));
}

// Core functions with file-based storage
async function generateLinkManID(programID, accountLogin) {
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    return crypto.createHash('sha256')
        .update(`${programID}-${accountLogin}-${timestamp}-${random}`)
        .digest('hex');
}

async function LinkMan(originalLink, programID, expiryTimeInMins, maxLinkUse, accountLogin) {
    const linkManID = await generateLinkManID(programID, accountLogin);
    const links = await loadStorage(STORAGE_PATHS.links);
    
    links[linkManID] = {
        originalLink,
        programID,
        accountLogin,
        created: Date.now(),
        expiry: Date.now() + (expiryTimeInMins * 60 * 1000),
        maxUses: maxLinkUse,
        currentUses: 0,
        active: true
    };

    await saveStorage(STORAGE_PATHS.links, links);
    return `http://${webhost}/${programID}/${accountLogin}/${linkManID}`;
}

async function bindProgram(programID, accountLogin, days, isDemo) {
    const binds = await loadStorage(STORAGE_PATHS.binds);
    const bindKey = `${programID}-${accountLogin}`;
    
    binds[bindKey] = {
        bindDate: Date.now(),
        expiryDate: Date.now() + (days * 24 * 60 * 60 * 1000),
        isDemo
    };
    
    await saveStorage(STORAGE_PATHS.binds, binds);
    return true;
}

async function addLog(programID, accountLogin, linkManID, logData) {
    const logs = await loadStorage(STORAGE_PATHS.logs);
    const logKey = `${programID}-${accountLogin}-${linkManID}`;
    
    if (!logs[logKey]) {
        logs[logKey] = [];
    }
    
    logs[logKey].push({
        ...logData,
        timestamp: Date.now()
    });
    
    await saveStorage(STORAGE_PATHS.logs, logs);
}

// API Routes
app.post('/create', async (req, res) => {
    const { originalLink, programID, expiryTimeInMins, maxLinkUse, accountLogin } = req.body;
    
    // Input validation
    if (!originalLink || !programID || !expiryTimeInMins || !maxLinkUse || !accountLogin) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const secureLink = await LinkMan(
        originalLink,
        programID,
        expiryTimeInMins,
        maxLinkUse,
        accountLogin
    );
    
    res.json({ secureLink });
});

app.post('/bind', async (req, res) => {
    const { programID, accountLogin, days, isDemo } = req.body;
    
    // Input validation
    if (!programID || !accountLogin || !days) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const result = await bindProgram(programID, accountLogin, days, isDemo);
    res.json({ success: result });
});

app.get('/logs/:programID/:accountLogin/:linkManID', async (req, res) => {
    const { programID, accountLogin, linkManID } = req.params;
    const logs = await loadStorage(STORAGE_PATHS.logs);
    const logKey = `${programID}-${accountLogin}-${linkManID}`;
    res.json({ logs: logs[logKey] || [] });
});
// MQL5 specific endpoint
app.post('/mql5/verify', async (req, res) => {
    const { programID, accountLogin } = req.body;
    const binds = await loadStorage(STORAGE_PATHS.binds);
    const bindKey = `${programID}-${accountLogin}`;
    const bindData = binds[bindKey];
    
    if (!bindData) {
        return res.json({ valid: false });
    }
    
    const isValid = Date.now() < bindData.expiryDate;
    res.json({ 
        valid: isValid,
        isDemo: bindData.isDemo,
        expiryDate: bindData.expiryDate
    });
});
// Download route with security checks
// Download route with security checks
app.get('/:programID/:accountLogin/:linkManID', async (req, res) => {
    const { programID, accountLogin, linkManID } = req.params;
    const links = await loadStorage(STORAGE_PATHS.links);
    const linkData = links[linkManID];
    
    if (!linkData) {
        return res.status(404).json({ error: 'Link not found' });
    }
    
    if (Date.now() > linkData.expiry) {
        // Clean up expired link
        delete links[linkManID];
        await saveStorage(STORAGE_PATHS.links, links);
        return res.status(403).json({ error: 'Link expired' });
    }
    
    if (linkData.currentUses >= linkData.maxUses) {
        // Clean up maxed out link
        delete links[linkManID];
        await saveStorage(STORAGE_PATHS.links, links);
        return res.status(403).json({ error: 'Maximum uses exceeded' });
    }
    
    try {
        // Stream the content
        const response = await axios({
            method: 'get',
            url: linkData.originalLink,
            responseType: 'stream'
        });

        // Update usage count
        linkData.currentUses++;
        await saveStorage(STORAGE_PATHS.links, links);
        
        // Log the access
        await addLog(programID, accountLogin, linkManID, {
            ip: req.ip,
            userAgent: req.headers['user-agent']
        });

        // Set response headers
        res.setHeader('Content-Type', response.headers['content-type']);
        res.setHeader('Content-Disposition', 'attachment');
        
        // Stream the file directly to client
        response.data.pipe(res);
    } catch (error) {
        res.status(500).json({ error: 'Download failed' });
    }
});



async function cleanupExpiredLinks() {
    const links = await loadStorage(STORAGE_PATHS.links);
    let modified = false;

    for (const [linkID, data] of Object.entries(links)) {
        if (Date.now() > data.expiry || data.currentUses >= data.maxUses) {
            delete links[linkID];
            modified = true;
        }
    }

    if (modified) {
        await saveStorage(STORAGE_PATHS.links, links);
    }
}

// Run cleanup every minute
setInterval(cleanupExpiredLinks, 60000);
// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal server error' });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Storage path: ${STORAGE_PATHS.links}`);
});
