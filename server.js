const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db');

const PORT = process.env.PORT || 8080;

const MIME_TYPES = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

// Helper to parse JSON request body
function getJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', err => {
      reject(err);
    });
  });
}

// Helper to send JSON response
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Helper to auto-calculate alert dates based on expiry
function calculateAlertDates(expiryDateStr) {
  if (!expiryDateStr) return { alertDate: '', initiationDate: '' };

  const expiry = new Date(expiryDateStr);
  if (isNaN(expiry.getTime())) return { alertDate: '', initiationDate: '' };

  // Renewal Alert: 30 days before expiry
  const alert = new Date(expiry);
  alert.setDate(expiry.getDate() - 30);

  // Renewal Initiation: 15 days before expiry
  const initiation = new Date(expiry);
  initiation.setDate(expiry.getDate() - 15);

  return {
    alertDate: alert.toISOString().split('T')[0],
    initiationDate: initiation.toISOString().split('T')[0]
  };
}

const server = http.createServer(async (req, res) => {
  const cleanUrl = req.url.replace(/^\/Bank_Guarantee_Module/i, '') || '/';
  const parsedUrl = url.parse(cleanUrl, true);
  const reqPath = parsedUrl.pathname || '/';
  const method = req.method;

  console.log(`${method} ${reqPath}`);

  // CORS Headers for development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // --- API ROUTES ---
  if (reqPath.startsWith('/api/')) {
    try {
      // GET /api/test - Check if backend is working
      if (reqPath === '/api/test' && method === 'GET') {
        sendJson(res, 200, {
          success: true,
          message: 'Backend is working successfully',
          status: 'healthy',
          timestamp: new Date().toISOString()
        });
        return;
      }

      // POST /api/auth/login
      if (reqPath === '/api/auth/login' && method === 'POST') {
        const body = await getJsonBody(req);
        const username = String(body.username || '').trim().toLowerCase();
        const password = String(body.password || '');

        if (!username || !password) {
          sendJson(res, 400, { success: false, error: 'Username/Email and Password are required.' });
          return;
        }

        const user = await db.findOne('users', {
          $or: [
            { username: username },
            { email: username }
          ]
        });

        if (!user || user.password !== password) {
          sendJson(res, 401, { success: false, error: 'Invalid Username/Email or Password.' });
          return;
        }

        sendJson(res, 200, {
          success: true,
          user: {
            username: user.username,
            name: user.name,
            email: user.email,
            role: user.role,
            isLoggedIn: true
          }
        });
        return;
      }

      // GET Dashboard Aggregates
      if (reqPath === '/api/dashboard' && method === 'GET') {
        const requests = await db.readData('requests');
        const register = await db.readData('register');

        const now = new Date();
        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(now.getDate() + 30);

        let outstandingCount = 0;
        let totalAmount = 0;
        let totalMarginMoney = 0;
        let activeCount = 0;
        let releasedCount = 0;
        let cancelledCount = 0;
        let expiredCount = 0;
        let urgentCount = 0;

        register.forEach(bg => {
          const bgAmount = parseFloat(bg.bgAmount) || 0;
          const bgMargin = parseFloat(bg.marginMoney) || 0;

          if (bg.status === 'Active') {
            activeCount++;
            outstandingCount++;
            totalAmount += bgAmount;
            totalMarginMoney += bgMargin;

            // Check if expiring within 30 days
            if (bg.expiryDate) {
              const expDate = new Date(bg.expiryDate);
              if (expDate <= thirtyDaysFromNow && expDate >= now) {
                urgentCount++;
              } else if (expDate < now) {
                // Technically active status but already past expiry date
                urgentCount++;
              }
            }
          } else if (bg.status === 'Expired') {
            expiredCount++;
            outstandingCount++;
            totalAmount += bgAmount;
            totalMarginMoney += bgMargin;
            urgentCount++; // Already expired is always urgent
          } else if (bg.status === 'Released') {
            releasedCount++;
          } else if (bg.status === 'Cancelled') {
            cancelledCount++;
          }
        });

        const pendingRequestsCount = requests.filter(r => r.status === 'Pending').length;

        // Return summary and recent 5 registered BGs
        const recentBgs = [...register]
          .sort((a, b) => new Date(b.lastUpdatedOn || 0) - new Date(a.lastUpdatedOn || 0))
          .slice(0, 5);

        sendJson(res, 200, {
          outstandingCount,
          totalAmount,
          totalMarginMoney,
          activeCount,
          releasedCount,
          cancelledCount,
          expiredCount,
          pendingRequestsCount,
          urgentCount,
          recentBgs
        });
        return;
      }

      // GET /api/requests
      if (reqPath === '/api/requests' && method === 'GET') {
        const requests = await db.readData('requests');
        sendJson(res, 200, requests);
        return;
      }

      // POST /api/requests
      if (reqPath === '/api/requests' && method === 'POST') {
        const body = await getJsonBody(req);

        // Handle attachments if any (Base64 file structures)
        const processedAttachments = [];
        if (body.attachments && Array.isArray(body.attachments)) {
          for (const file of body.attachments) {
            if (file.name && file.data) {
              const saved = db.saveAttachment(file.name, file.data);
              if (saved.success) {
                processedAttachments.push({
                  originalName: saved.originalName,
                  filename: saved.filename,
                  path: saved.path,
                  category: file.category || 'General'
                });
              }
            }
          }
        }

        const newRequest = {
          id: await db.generateId('requests', 'REQ'),
          requestType: body.requestType || 'New',
          bgNumberToRenew: body.bgNumberToRenew || '',
          registerIdToRenew: body.registerIdToRenew || '',
          projectRef: body.projectRef || 'General',
          bgType: body.bgType || 'EMD',
          costCenter: body.costCenter || '',
          amount: parseFloat(body.amount) || 0,
          dueDate: body.dueDate || '',
          beneficiaryName: body.beneficiaryName || '',
          beneficiaryAddress: body.beneficiaryAddress || '',
          beneficiaryBankName: body.beneficiaryBankName || '',
          beneficiaryBankAccount: body.beneficiaryBankAccount || '',
          beneficiaryBankIfsc: body.beneficiaryBankIfsc || '',
          duration: body.duration || '',
          requestedBy: body.requestedBy || 'Unknown User',
          approvalsNeeded: body.approvalsNeeded || 'Finance',
          remarks: body.remarks || '',
          status: 'Pending',
          createdAt: new Date().toISOString(),
          attachments: processedAttachments
        };

        await db.insertDocument('requests', newRequest);
        sendJson(res, 201, { success: true, request: newRequest });
        return;
      }

      // PUT /api/requests (Approvals / Status Updates)
      if (reqPath === '/api/requests' && method === 'PUT') {
        const body = await getJsonBody(req);
        if (!body.id) {
          sendJson(res, 400, { success: false, error: 'Request ID is required' });
          return;
        }

        const requests = await db.readData('requests');
        const request = requests.find(r => r.id === body.id);

        if (!request) {
          sendJson(res, 404, { success: false, error: 'Request not found' });
          return;
        }

        const oldStatus = request.status;
        const newStatus = body.status;

        const approvedBy = body.approvedBy || 'Manager';
        const approvedOn = new Date().toISOString();

        await db.updateDocument('requests', { id: body.id }, {
          status: newStatus,
          approvedBy: approvedBy,
          approvedOn: approvedOn
        });

        request.status = newStatus;
        request.approvedBy = approvedBy;
        request.approvedOn = approvedOn;

        // Workflow: If request is Approved, automatically generate register changes
        if (newStatus === 'Approved' && oldStatus !== 'Approved') {
          const register = await db.readData('register');

          if (request.requestType === 'Renewal') {
            // RENEWAL WORKFLOW: Add amendment history record to target BG instead of creating new BG entry
            const bgIndex = register.findIndex(b => b.id === request.registerIdToRenew || (request.bgNumberToRenew && b.bgNumber === request.bgNumberToRenew));
            if (bgIndex !== -1) {
              const currentBg = register[bgIndex];
              if (!currentBg.amendments) currentBg.amendments = [];

              const newAmendment = {
                id: `AMD-${Date.now()}`,
                date: new Date().toISOString().split('T')[0],
                description: `Renewal Approved via Req ${request.id}. Details: ${request.remarks || ''}. Duration: ${request.duration || ''}`,
                revisedAmount: currentBg.bgAmount,
                revisedExpiryDate: request.dueDate,
                revisedDuration: request.duration || '',
                attachments: request.attachments || [] // Copy attachments from renewal request
              };

              currentBg.amendments.push(newAmendment);

              // Update root properties of target BG
              const alertDates = calculateAlertDates(request.dueDate);
              const remarks = `Renewed on ${newAmendment.date}: Extended to ${newAmendment.revisedExpiryDate}.\n` + (currentBg.remarks || '');

              await db.updateDocument('register', { id: currentBg.id }, {
                amendments: currentBg.amendments,
                expiryDate: request.dueDate,
                renewalAlertDate: alertDates.alertDate,
                renewalInitiationDate: alertDates.initiationDate,
                remarks: remarks,
                lastUpdatedBy: request.approvedBy,
                lastUpdatedOn: new Date().toISOString()
              });
            }
          } else {
            // NEW BG WORKFLOW: Generate new BG register entry
            const newBg = {
              id: await db.generateId('register', 'BG'),
              requestId: request.id,
              bgNumber: '', // Issuing bank BG Number to be entered by Finance later
              bgType: request.bgType,
              beneficiary: request.beneficiaryName,
              siteName: request.projectRef,
              clientName: request.beneficiaryAddress, // beneficiaryAddress used as client/recipient address
              issuingBank: 'HDFC Bank', // Default select
              issueDate: '',
              effectiveDate: '',
              expiryDate: '',
              claimExpiryDate: '',
              bgAmount: request.amount,
              bgCommission: 0,
              autoRenewal: false,
              status: 'Active',
              releasedDate: '',
              remarks: `Automatically created from approved request ${request.id}. ${request.remarks}`,
              attachments: request.attachments || [], // Copy attachments
              marginMoney: 0,
              fdrNo: '',
              costCenter: request.costCenter || '',
              beneficiaryBankName: request.beneficiaryBankName || '',
              beneficiaryBankAccount: request.beneficiaryBankAccount || '',
              beneficiaryBankIfsc: request.beneficiaryBankIfsc || '',
              amendments: [],
              lastUpdatedBy: request.approvedBy,
              lastUpdatedOn: new Date().toISOString()
            };

            await db.insertDocument('register', newBg);
          }
        }

        sendJson(res, 200, { success: true, request: request });
        return;
      }

      // GET /api/register
      if (reqPath === '/api/register' && method === 'GET') {
        const register = await db.readData('register');
        sendJson(res, 200, register);
        return;
      }

      // POST /api/register (Manual Entry)
      if (reqPath === '/api/register' && method === 'POST') {
        const body = await getJsonBody(req);

        // Handle attachments if any
        const processedAttachments = [];
        if (body.attachments && Array.isArray(body.attachments)) {
          for (const file of body.attachments) {
            if (file.name && file.data) {
              const saved = db.saveAttachment(file.name, file.data);
              if (saved.success) {
                processedAttachments.push({
                  originalName: saved.originalName,
                  filename: saved.filename,
                  path: saved.path,
                  category: file.category || 'General'
                });
              }
            }
          }
        }

        const alertDates = calculateAlertDates(body.expiryDate);

        const newBg = {
          id: await db.generateId('register', 'BG'),
          requestId: body.requestId || '',
          bgNumber: body.bgNumber || '',
          bgType: body.bgType || 'EMD',
          beneficiary: body.beneficiary || '',
          siteName: body.siteName || '',
          clientName: body.clientName || '',
          issuingBank: body.issuingBank || '',
          issueDate: body.issueDate || '',
          effectiveDate: body.effectiveDate || '',
          expiryDate: body.expiryDate || '',
          claimExpiryDate: body.claimExpiryDate || '',
          bgAmount: parseFloat(body.bgAmount) || 0,
          bgCommission: parseFloat(body.bgCommission) || 0,
          autoRenewal: !!body.autoRenewal,
          status: body.status || 'Active',
          renewalAlertDate: alertDates.alertDate,
          renewalInitiationDate: alertDates.initiationDate,
          releasedDate: body.releasedDate || '',
          remarks: body.remarks || '',
          attachments: processedAttachments,
          marginMoney: parseFloat(body.marginMoney) || 0,
          fdrNo: body.fdrNo || '',
          costCenter: body.costCenter || '',
          amendments: [],
          lastUpdatedBy: body.lastUpdatedBy || 'Authorized User',
          lastUpdatedOn: new Date().toISOString()
        };

        await db.insertDocument('register', newBg);
        sendJson(res, 201, { success: true, bg: newBg });
        return;
      }

      // PUT /api/register (Update BG)
      if (reqPath === '/api/register' && method === 'PUT') {
        const body = await getJsonBody(req);
        if (!body.id) {
          sendJson(res, 400, { success: false, error: 'Register Entry ID is required' });
          return;
        }

        const register = await db.readData('register');
        const bgEntry = register.find(b => b.id === body.id);

        if (!bgEntry) {
          sendJson(res, 404, { success: false, error: 'BG entry not found' });
          return;
        }

        // Handle new attachments to append at root level
        const processedAttachments = [...(bgEntry.attachments || [])];
        if (body.newAttachments && Array.isArray(body.newAttachments)) {
          for (const file of body.newAttachments) {
            if (file.name && file.data) {
              const saved = db.saveAttachment(file.name, file.data);
              if (saved.success) {
                processedAttachments.push({
                  originalName: saved.originalName,
                  filename: saved.filename,
                  path: saved.path,
                  category: file.category || 'General'
                });
              }
            }
          }
        }

        // Handle processing of new base64 files within incoming amendments history
        const processedAmendments = [];
        const incomingAmendments = body.amendments || bgEntry.amendments || [];
        if (Array.isArray(incomingAmendments)) {
          for (const amd of incomingAmendments) {
            const amdAttachments = [];
            if (amd.attachments && Array.isArray(amd.attachments)) {
              for (const file of amd.attachments) {
                if (file.path) {
                  amdAttachments.push(file);
                } else if (file.name && file.data) {
                  const saved = db.saveAttachment(file.name, file.data);
                  if (saved.success) {
                    amdAttachments.push({
                      originalName: saved.originalName,
                      filename: saved.filename,
                      path: saved.path,
                      category: 'Amendment'
                    });
                  }
                }
              }
            }
            processedAmendments.push({
              ...amd,
              attachments: amdAttachments
            });
          }
        }

        const alertDates = calculateAlertDates(body.expiryDate);

        const updatedBg = {
          bgNumber: body.bgNumber !== undefined ? body.bgNumber : bgEntry.bgNumber,
          bgType: body.bgType || bgEntry.bgType,
          beneficiary: body.beneficiary || bgEntry.beneficiary,
          siteName: body.siteName || bgEntry.siteName,
          clientName: body.clientName || bgEntry.clientName,
          issuingBank: body.issuingBank || bgEntry.issuingBank,
          issueDate: body.issueDate !== undefined ? body.issueDate : bgEntry.issueDate,
          effectiveDate: body.effectiveDate !== undefined ? body.effectiveDate : bgEntry.effectiveDate,
          expiryDate: body.expiryDate !== undefined ? body.expiryDate : bgEntry.expiryDate,
          claimExpiryDate: body.claimExpiryDate !== undefined ? body.claimExpiryDate : bgEntry.claimExpiryDate,
          bgAmount: body.bgAmount !== undefined ? parseFloat(body.bgAmount) : bgEntry.bgAmount,
          bgCommission: body.bgCommission !== undefined ? parseFloat(body.bgCommission) : bgEntry.bgCommission,
          autoRenewal: body.autoRenewal !== undefined ? !!body.autoRenewal : bgEntry.autoRenewal,
          status: body.status || bgEntry.status,
          renewalAlertDate: alertDates.alertDate,
          renewalInitiationDate: alertDates.initiationDate,
          releasedDate: body.releasedDate !== undefined ? body.releasedDate : bgEntry.releasedDate,
          remarks: body.remarks !== undefined ? body.remarks : bgEntry.remarks,
          attachments: processedAttachments,
          marginMoney: body.marginMoney !== undefined ? parseFloat(body.marginMoney) : bgEntry.marginMoney,
          fdrNo: body.fdrNo !== undefined ? body.fdrNo : bgEntry.fdrNo,
          costCenter: body.costCenter !== undefined ? body.costCenter : bgEntry.costCenter,
          amendments: processedAmendments,
          lastUpdatedBy: body.lastUpdatedBy || 'Authorized User',
          lastUpdatedOn: new Date().toISOString()
        };

        await db.updateDocument('register', { id: body.id }, updatedBg);
        sendJson(res, 200, { success: true, bg: { ...bgEntry, ...updatedBg } });
        return;
      }

      // Fallback API route
      sendJson(res, 404, { error: 'API Endpoint not found' });
      return;
    } catch (error) {
      console.error('API Error:', error);
      sendJson(res, 500, { error: 'Internal Server Error', message: error.message });
      return;
    }
  }

  // --- STATIC FILE SERVING (Uploads Only) ---
  if (reqPath.startsWith('/uploads/')) {
    const filePath = path.join(__dirname, reqPath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        sendJson(res, 404, { error: 'File not found' });
        return;
      }

      fs.readFile(filePath, (err, content) => {
        if (err) {
          sendJson(res, 500, { error: 'Internal Server Error', message: 'Could not read file' });
        } else {
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
        }
      });
    });
    return;
  }

  // Any other route that reaches here is not found
  sendJson(res, 404, { error: 'Not Found' });
});

const os = require('os');
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// Wrap server startup to connect and initialize database first
async function startServer() {
  try {
    // Connect to database and run automatic migration of JSON data if required
    await db.initializeDb();

    // Start listening on port
    server.listen(PORT, '0.0.0.0', () => {
      const localIp = getLocalIpAddress();
      console.log(`=======================================================`);
      console.log(`  Bank Guarantee Module Server started successfully!   `);
      console.log(`=======================================================`);
      console.log(`Local URL:         http://localhost:${PORT}/`);
      if (localIp) {
        console.log(`Local Network URL: http://${localIp}:${PORT}/`);
      }
      console.log(`=======================================================`);
    });
  } catch (error) {
    console.error('Failed to initialize database. Server cannot start.', error);
    process.exit(1);
  }
}

startServer();
