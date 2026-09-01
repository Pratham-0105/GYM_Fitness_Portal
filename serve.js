const http = require('http');
const fs = require('fs');
const path = require('path');

// Load environment variables from functions/.env using functions node_modules or manual parser
const envPath = path.join(__dirname, 'functions', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [k, ...v] = trimmed.split('=');
      process.env[k.trim()] = v.join('=').trim();
    }
  });
}

// Ensure Node resolution finds modules inside functions/node_modules
module.paths.push(path.join(__dirname, 'functions', 'node_modules'));

const { sendTwilioSMS } = require('./functions/services/twilioProvider');
const { sendPaymentSuccessSMS, sendExpiringSoonSMS, sendExpiredSMS } = require('./functions/services/smsService');

const PORT = process.env.PORT || 5000;
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // --- API ROUTE: /api/send-sms ---
  if (req.url === '/api/send-sms' && req.method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const { member, smsType } = data;

      if (!member || !member.phone) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Member and Phone are required' }));
      }

      console.log(`\n[Twilio API] Sending ${smsType || 'SMS'} to ${member.name} (+91 ${member.phone})...`);

      let result;
      if (smsType === 'EXPIRING_SOON') {
        result = await sendExpiringSoonSMS(member, null);
      } else if (smsType === 'EXPIRED') {
        result = await sendExpiredSMS(member, null);
      } else {
        const tx = { id: Date.now(), amount: member.amount || 1000, method: member.method || 'UPI / Online' };
        result = await sendPaymentSuccessSMS(member, tx, null);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: result.success, result }));
    } catch (err) {
      console.error('[API Error /send-sms]:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // --- API ROUTE: /api/test-sms ---
  if (req.url === '/api/test-sms' && req.method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const { phone, smsType } = data;

      console.log(`\n[Twilio API] Sending Test SMS to ${phone} (Type: ${smsType})...`);

      const now = new Date();
      const testMember = {
        id: `TEST_${Date.now()}`,
        name: "Valued Member",
        phone: phone,
        planMonths: 1,
        joiningDate: `${now.getDate()}-${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][now.getMonth()]}-${now.getFullYear()}`,
        expiryDate: `${now.getDate() + 2}-${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][now.getMonth()]}-${now.getFullYear()}`,
        amount: 1000,
        method: "UPI / Online",
      };

      let result;
      if (smsType === 'EXPIRING_SOON') {
        result = await sendExpiringSoonSMS(testMember, null);
      } else if (smsType === 'EXPIRED') {
        result = await sendExpiredSMS(testMember, null);
      } else {
        const tx = { id: Date.now(), amount: 1000, method: 'UPI / Online' };
        result = await sendPaymentSuccessSMS(testMember, tx, null);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: result.success, result }));
    } catch (err) {
      console.error('[API Error /test-sms]:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // --- API ROUTE: /api/scan-sms ---
  if (req.url === '/api/scan-sms' && req.method === 'POST') {
    try {
      const data = await parseJsonBody(req);
      const members = data.members || [];
      console.log(`\n[Twilio API] Scanning ${members.length} members for expiry alerts...`);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let expiringSoonSent = 0;
      let expiredSent = 0;

      for (const m of members) {
        if (!m.phone || !m.expiryDate) continue;
        
        const parts = m.expiryDate.split('-');
        let expDate;
        if (parts.length === 3) {
          const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const mIdx = MONTHS.indexOf(parts[1]);
          expDate = mIdx !== -1 ? new Date(parts[2], mIdx, parts[0]) : new Date(parts[2], parts[1]-1, parts[0]);
        } else {
          expDate = new Date(m.expiryDate);
        }
        expDate.setHours(0, 0, 0, 0);

        const diffDays = Math.round((expDate - today) / (1000 * 60 * 60 * 24));

        if (diffDays >= 0 && diffDays <= 5) {
          const r = await sendExpiringSoonSMS(m, null);
          if (r && r.success) expiringSoonSent++;
        } else if (diffDays < 0) {
          const r = await sendExpiredSMS(m, null);
          if (r && r.success) expiredSent++;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        scanned: members.length,
        expiringSoonSent,
        expiredSent
      }));
    } catch (err) {
      console.error('[API Error /scan-sms]:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: err.message }));
    }
  }

  // --- STATIC FILE SERVING ---
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Access Denied');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        return res.end('Server Error');
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🏋️  ARYA FITNESS PORTAL is RUNNING LOCALLY!`);
  console.log(`🌐  Open in browser: http://localhost:${PORT}`);
  console.log(`🔑  Login ID: admin (Password: 123 or arya123)`);
  console.log(`⚡  Live Twilio API: Active on /api/send-sms`);
  console.log(`======================================================\n`);
});
