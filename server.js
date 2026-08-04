const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db');

const PORT = 8080;
const FRONTEND_DIR = path.join(__dirname, '..', 'Frontend');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
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
  const parsedUrl = url.parse(req.url, true);
  const reqPath = parsedUrl.pathname;
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
      // GET Dashboard Aggregates
      if (reqPath === '/api/dashboard' && method === 'GET') {
        const requests = db.readData('requests');
        const register = db.readData('register');
        
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
        const requests = db.readData('requests');
        sendJson(res, 200, requests);
        return;
      }
      
      // POST /api/requests
      if (reqPath === '/api/requests' && method === 'POST') {
        const body = await getJsonBody(req);
        const requests = db.readData('requests');
        
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
          id: db.generateId('requests', 'REQ'),
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
        
        requests.push(newRequest);
        db.writeData('requests', requests);
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
        
        const requests = db.readData('requests');
        const reqIndex = requests.findIndex(r => r.id === body.id);
        
        if (reqIndex === -1) {
          sendJson(res, 404, { success: false, error: 'Request not found' });
          return;
        }
        
        const oldStatus = requests[reqIndex].status;
        const newStatus = body.status;
        
        requests[reqIndex].status = newStatus;
        requests[reqIndex].approvedBy = body.approvedBy || 'Manager';
        requests[reqIndex].approvedOn = new Date().toISOString();
        
        db.writeData('requests', requests);
        
        // Workflow: If request is Approved, automatically generate register changes
        if (newStatus === 'Approved' && oldStatus !== 'Approved') {
          const register = db.readData('register');
          const request = requests[reqIndex];
          
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
              currentBg.expiryDate = request.dueDate;
              const alertDates = calculateAlertDates(request.dueDate);
              currentBg.renewalAlertDate = alertDates.alertDate;
              currentBg.renewalInitiationDate = alertDates.initiationDate;
              currentBg.remarks = `Renewed on ${newAmendment.date}: Extended to ${newAmendment.revisedExpiryDate}.\n` + (currentBg.remarks || '');
              currentBg.lastUpdatedBy = request.approvedBy;
              currentBg.lastUpdatedOn = new Date().toISOString();
              
              db.writeData('register', register);
            }
          } else {
            // NEW BG WORKFLOW: Generate new BG register entry
            const newBg = {
              id: db.generateId('register', 'BG'),
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
            
            register.push(newBg);
            db.writeData('register', register);
          }
        }
        
        sendJson(res, 200, { success: true, request: requests[reqIndex] });
        return;
      }
      
      // GET /api/register
      if (reqPath === '/api/register' && method === 'GET') {
        const register = db.readData('register');
        sendJson(res, 200, register);
        return;
      }
      
      // POST /api/register (Manual Entry)
      if (reqPath === '/api/register' && method === 'POST') {
        const body = await getJsonBody(req);
        const register = db.readData('register');
        
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
          id: db.generateId('register', 'BG'),
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
        
        register.push(newBg);
        db.writeData('register', register);
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
        
        const register = db.readData('register');
        const bgIndex = register.findIndex(b => b.id === body.id);
        
        if (bgIndex === -1) {
          sendJson(res, 404, { success: false, error: 'BG entry not found' });
          return;
        }
        
        // Handle new attachments to append at root level
        const processedAttachments = [...(register[bgIndex].attachments || [])];
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
        const incomingAmendments = body.amendments || register[bgIndex].amendments || [];
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
        
        register[bgIndex] = {
          ...register[bgIndex],
          bgNumber: body.bgNumber !== undefined ? body.bgNumber : register[bgIndex].bgNumber,
          bgType: body.bgType || register[bgIndex].bgType,
          beneficiary: body.beneficiary || register[bgIndex].beneficiary,
          siteName: body.siteName || register[bgIndex].siteName,
          clientName: body.clientName || register[bgIndex].clientName,
          issuingBank: body.issuingBank || register[bgIndex].issuingBank,
          issueDate: body.issueDate !== undefined ? body.issueDate : register[bgIndex].issueDate,
          effectiveDate: body.effectiveDate !== undefined ? body.effectiveDate : register[bgIndex].effectiveDate,
          expiryDate: body.expiryDate !== undefined ? body.expiryDate : register[bgIndex].expiryDate,
          claimExpiryDate: body.claimExpiryDate !== undefined ? body.claimExpiryDate : register[bgIndex].claimExpiryDate,
          bgAmount: body.bgAmount !== undefined ? parseFloat(body.bgAmount) : register[bgIndex].bgAmount,
          bgCommission: body.bgCommission !== undefined ? parseFloat(body.bgCommission) : register[bgIndex].bgCommission,
          autoRenewal: body.autoRenewal !== undefined ? !!body.autoRenewal : register[bgIndex].autoRenewal,
          status: body.status || register[bgIndex].status,
          renewalAlertDate: alertDates.alertDate,
          renewalInitiationDate: alertDates.initiationDate,
          releasedDate: body.releasedDate !== undefined ? body.releasedDate : register[bgIndex].releasedDate,
          remarks: body.remarks !== undefined ? body.remarks : register[bgIndex].remarks,
          attachments: processedAttachments,
          marginMoney: body.marginMoney !== undefined ? parseFloat(body.marginMoney) : register[bgIndex].marginMoney,
          fdrNo: body.fdrNo !== undefined ? body.fdrNo : register[bgIndex].fdrNo,
          costCenter: body.costCenter !== undefined ? body.costCenter : register[bgIndex].costCenter,
          amendments: processedAmendments,
          lastUpdatedBy: body.lastUpdatedBy || 'Authorized User',
          lastUpdatedOn: new Date().toISOString()
        };
        
        db.writeData('register', register);
        sendJson(res, 200, { success: true, bg: register[bgIndex] });
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

  // --- STATIC FILE SERVING ---
  let filePath = path.join(FRONTEND_DIR, reqPath === '/' ? 'index.html' : reqPath);
  
  // Serve uploads from Backend directory
  if (reqPath.startsWith('/uploads/')) {
    filePath = path.join(__dirname, reqPath);
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // If static file not found, fall back to index.html for client-side routing
      const indexPath = path.join(FRONTEND_DIR, 'index.html');
      fs.readFile(indexPath, (err2, content) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(content);
        }
      });
      return;
    }

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  });
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
