const express = require('express');
const path = require('path');
const os = require('os');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8080;

// Body Parsers (Support large payloads for base64 file attachments)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// URL Normalization Middleware (Strip IIS subpath /Bank_Guarantee_Module if present)

// CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Request Logging Middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

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

// --- API ROUTES ---

// GET /api/test - Check if backend is working
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'Backend is working successfully',
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const selectedCompanyRole = String(body.companyRole || body.roleOption || 'EPC').toUpperCase();

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username/Email and Password are required.' });
    }

    const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let user = await db.findOne('users', {
      $or: [
        { username: { $regex: new RegExp(`^${escapedUsername}$`, 'i') } },
        { email: { $regex: new RegExp(`^${escapedUsername}$`, 'i') } }
      ]
    });

    if (!user) {
      await db.initializeDb();
      user = await db.findOne('users', {
        $or: [
          { username: { $regex: new RegExp(`^${escapedUsername}$`, 'i') } },
          { email: { $regex: new RegExp(`^${escapedUsername}$`, 'i') } }
        ]
      });
    }

    if (!user || user.password !== password) {
      return res.status(401).json({ success: false, error: 'Invalid Username/Email or Password.' });
    }

    const rawCompanyRole = String(user.companyRole || 'ALL').toUpperCase();
    let sessionCompanyRole = selectedCompanyRole;

    if (rawCompanyRole !== 'ALL' && rawCompanyRole !== 'BOTH' && rawCompanyRole !== '*') {
      const allowedRoles = rawCompanyRole.split(/[,|\s]+/).map(r => r.trim());
      if (!allowedRoles.includes(selectedCompanyRole)) {
        return res.status(401).json({
          success: false,
          error: `Account role mismatch. This account belongs to '${user.companyRole}' division, but '${selectedCompanyRole}' was selected.`
        });
      }
    }

    return res.json({
      success: true,
      user: {
        username: user.username,
        name: user.name || user.username,
        email: user.email || '',
        role: user.role || 'Finance Manager',
        companyRole: sessionCompanyRole,
        isLoggedIn: true
      }
    });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// GET /api/dashboard - Aggregates
app.get('/api/dashboard', async (req, res) => {
  try {
    const companyRole = String(req.query.companyRole || 'EPC').toUpperCase();
    const requests = await db.readData('requests', { companyRole: companyRole });
    const register = await db.readData('register', { companyRole: companyRole });

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
            urgentCount++;
          }
        }
      } else if (bg.status === 'Expired') {
        expiredCount++;
        outstandingCount++;
        totalAmount += bgAmount;
        totalMarginMoney += bgMargin;
        urgentCount++;
      } else if (bg.status === 'Released') {
        releasedCount++;
      } else if (bg.status === 'Cancelled') {
        cancelledCount++;
      }
    });

    const pendingRequestsCount = requests.filter(r => r.status === 'Pending').length;

    const recentBgs = [...register]
      .sort((a, b) => new Date(b.lastUpdatedOn || 0) - new Date(a.lastUpdatedOn || 0))
      .slice(0, 5);

    return res.json({
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
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// GET /api/requests
app.get('/api/requests', async (req, res) => {
  try {
    const companyRole = String(req.query.companyRole || 'EPC').toUpperCase();
    const requests = await db.readData('requests', { companyRole: companyRole });
    return res.json(requests);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// POST /api/requests
app.post('/api/requests', async (req, res) => {
  try {
    const body = req.body || {};

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
      companyRole: String(body.companyRole || 'EPC').toUpperCase(),
      companyName: body.companyName || '',
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
    return res.status(201).json({ success: true, request: newRequest });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// PUT /api/requests
app.put('/api/requests', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.id) {
      return res.status(400).json({ success: false, error: 'Request ID is required' });
    }

    const requests = await db.readData('requests');
    const request = requests.find(r => r.id === body.id);

    if (!request) {
      return res.status(404).json({ success: false, error: 'Request not found' });
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
            attachments: request.attachments || []
          };

          currentBg.amendments.push(newAmendment);

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
        const newBg = {
          id: await db.generateId('register', 'BG'),
          companyRole: request.companyRole || 'EPC',
          companyName: request.companyName || '',
          requestId: request.id,
          bgNumber: '',
          bgType: request.bgType,
          beneficiary: request.beneficiaryName,
          siteName: request.projectRef,
          clientName: request.beneficiaryAddress,
          issuingBank: 'HDFC Bank',
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
          attachments: request.attachments || [],
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

    return res.json({ success: true, request: request });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// GET /api/register
app.get('/api/register', async (req, res) => {
  try {
    const companyRole = String(req.query.companyRole || 'EPC').toUpperCase();
    const register = await db.readData('register', { companyRole: companyRole });
    return res.json(register);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// POST /api/register
app.post('/api/register', async (req, res) => {
  try {
    const body = req.body || {};

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
      companyRole: String(body.companyRole || 'EPC').toUpperCase(),
      companyName: body.companyName || '',
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
    return res.status(201).json({ success: true, bg: newBg });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// PUT /api/register
app.put('/api/register', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.id) {
      return res.status(400).json({ success: false, error: 'Register Entry ID is required' });
    }

    const register = await db.readData('register');
    const bgEntry = register.find(b => b.id === body.id);

    if (!bgEntry) {
      return res.status(404).json({ success: false, error: 'BG entry not found' });
    }

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
      companyName: body.companyName !== undefined ? body.companyName : (bgEntry.companyName || ''),
      marginMoney: body.marginMoney !== undefined ? parseFloat(body.marginMoney) : bgEntry.marginMoney,
      fdrNo: body.fdrNo !== undefined ? body.fdrNo : bgEntry.fdrNo,
      costCenter: body.costCenter !== undefined ? body.costCenter : bgEntry.costCenter,
      amendments: processedAmendments,
      lastUpdatedBy: body.lastUpdatedBy || 'Authorized User',
      lastUpdatedOn: new Date().toISOString()
    };

    await db.updateDocument('register', { id: body.id }, updatedBg);
    return res.json({ success: true, bg: { ...bgEntry, ...updatedBg } });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

const DEFAULT_COST_CENTERS = [
  'ATS-Byculla Mumbai',
  'Bitsom Pilani - Kalyan, Mumbai',
  'BMC - Dahisar Hub',
  'Gera Imperium Gateway',
  'Havmor Ice Cream Pvt Ltd - Talegaon',
  'IICT Campus - Goregaon',
  'IMCCPLTD- Ghansoli',
  'Incubation Cent-Kalamboli',
  'Medical College - Bhojpur',
  'Medical College - Jalgaon',
  'Medical College - Satara',
  'Medical College- Munger',
  'Metro Bhavan & Staff Quarters (MMRCL) - Mumbai',
  'NHAI- DMIA',
  'Phoenix Mall - Mohali',
  'Police Housing - Kandivali',
  'Police Housing Goregaon',
  'Ratnagiri Air Terminal',
  'Ratnagiri Rly. Platform Beautification',
  'Redevelopment Of Ravi Shankar Shukla Market Bhopal',
  'Saibaba Edu. Complex (Shirdi)',
  'Smart City 1 and 2 - Ratnagiri',
  'SSChandrpur',
  'Symbiosis 1320 Hostel Lavale',
  'Symbiosis Nagpur Hostel',
  'Symbiosis SIBM Extension Lavale Campus',
  'Symbiosis World School',
  'Udaipur Air Terminal'
];

// GET /api/cost-centers
app.get('/api/cost-centers', async (req, res) => {
  try {
    let list = await db.readData('cost_centers');
    if (!list || list.length === 0) {
      for (const name of DEFAULT_COST_CENTERS) {
        await db.insertDocument('cost_centers', { name });
      }
      list = DEFAULT_COST_CENTERS.map(name => ({ name }));
    }
    return res.json(list);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// POST /api/cost-centers
app.post('/api/cost-centers', async (req, res) => {
  try {
    const { name } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).json({ success: false, error: 'Cost Center name is required.' });
    }

    const existing = await db.findOne('cost_centers', { name: cleanName });
    if (existing) {
      return res.status(400).json({ success: false, error: 'Cost Center already exists.' });
    }

    await db.insertDocument('cost_centers', { name: cleanName, createdAt: new Date().toISOString() });
    return res.status(201).json({ success: true, name: cleanName });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// PUT /api/cost-centers
app.put('/api/cost-centers', async (req, res) => {
  try {
    const { oldName, newName } = req.body || {};
    const cleanOld = String(oldName || '').trim();
    const cleanNew = String(newName || '').trim();

    if (!cleanOld || !cleanNew) {
      return res.status(400).json({ success: false, error: 'Both oldName and newName are required.' });
    }

    await db.updateDocument('cost_centers', { name: cleanOld }, { name: cleanNew });

    // Update in requests
    const requests = await db.readData('requests');
    for (const reqDoc of requests) {
      if (reqDoc.costCenter === cleanOld) {
        await db.updateDocument('requests', { id: reqDoc.id }, { costCenter: cleanNew });
      }
    }

    // Update in register
    const register = await db.readData('register');
    for (const bgDoc of register) {
      if (bgDoc.costCenter === cleanOld) {
        await db.updateDocument('register', { id: bgDoc.id }, { costCenter: cleanNew });
      }
    }

    return res.json({ success: true, oldName: cleanOld, newName: cleanNew });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// DELETE /api/cost-centers
app.delete('/api/cost-centers', async (req, res) => {
  try {
    const { name } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      return res.status(400).json({ success: false, error: 'Cost Center name is required.' });
    }

    await db.deleteDocument('cost_centers', { name: cleanName });
    return res.json({ success: true, name: cleanName });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// --- STATIC FILE SERVING ---
const frontendPath = path.join(__dirname, '../BG-Frontend');

// Serve static assets from BG-Frontend directory (index.html, css, js, etc.)
app.use(express.static(frontendPath));
app.use('/Bank_Guarantee_Module', express.static(frontendPath));

// Serve uploads from both backend and frontend directories
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads', express.static(path.join(frontendPath, 'uploads')));
app.use('/Bank_Guarantee_Module/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/Bank_Guarantee_Module/uploads', express.static(path.join(frontendPath, 'uploads')));

// Fallback for non-API requests (Serve index.html for frontend views)
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.sendFile(path.join(frontendPath, 'index.html'), (err) => {
    if (err) {
      res.status(404).json({ error: 'Not Found' });
    }
  });
});

// Helper for local IP
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

// Server Startup
async function startServer() {
  try {
    await db.initializeDb();

    app.listen(PORT, '0.0.0.0', () => {
      const localIp = getLocalIpAddress();
      console.log(`=======================================================`);
      console.log(`  Bank Guarantee Module Server started successfully!   `);
      console.log(`  (Backend API & Frontend served together automatically) `);
      console.log(`=======================================================`);
      console.log(`Local URL (Frontend & API): http://localhost:${PORT}/`);
      if (localIp) {
        console.log(`Local Network URL:         http://${localIp}:${PORT}/`);
      }
      console.log(`=======================================================`);

      // Automatically open frontend in browser window
      const startCmd = process.platform === 'win32' ? `start http://localhost:${PORT}/` :
                       process.platform === 'darwin' ? `open http://localhost:${PORT}/` :
                       `xdg-open http://localhost:${PORT}/`;
      const { exec } = require('child_process');
      exec(startCmd, (err) => {
        if (err) {
          console.log(`Notice: Frontend available at http://localhost:${PORT}/`);
        }
      });
    });
  } catch (error) {
    console.error('Failed to initialize database. Server cannot start.', error);
    process.exit(1);
  }
}

startServer();
