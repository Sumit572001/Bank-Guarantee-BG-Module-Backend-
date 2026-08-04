const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'db');

// Ensure db directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function getFilePath(collection) {
  return path.join(DB_DIR, `${collection}.json`);
}

function readData(collection) {
  const filePath = getFilePath(collection);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify([]));
    return [];
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    console.error(`Error reading ${collection} db:`, error);
    return [];
  }
}

function writeData(collection, data) {
  const filePath = getFilePath(collection);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error(`Error writing ${collection} db:`, error);
    return false;
  }
}

function generateId(collection, prefix) {
  const data = readData(collection);
  const year = new Date().getFullYear();
  let count = 1;
  
  if (data.length > 0) {
    // Find highest count for the current year
    const pattern = new RegExp(`^${prefix}-${year}-(\\d{4})$`);
    const yearsCounts = data
      .map(item => {
        const match = String(item.id || '').match(pattern);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter(val => val > 0);
      
    if (yearsCounts.length > 0) {
      count = Math.max(...yearsCounts) + 1;
    }
  }
  
  return `${prefix}-${year}-${String(count).padStart(4, '0')}`;
}

function saveAttachment(filename, base64Data) {
  try {
    // Remove data:image/...;base64, prefix if present
    const base64Content = base64Data.replace(/^data:.*;base64,/, '');
    const buffer = Buffer.from(base64Content, 'base64');
    
    // Create unique filename to prevent overwrite
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    const uniqueName = `${base}_${Date.now()}${ext}`;
    const filePath = path.join(UPLOADS_DIR, uniqueName);
    
    fs.writeFileSync(filePath, buffer);
    return {
      success: true,
      filename: uniqueName,
      originalName: filename,
      path: `/uploads/${uniqueName}`
    };
  } catch (error) {
    console.error('Error saving attachment:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  readData,
  writeData,
  generateId,
  saveAttachment,
  UPLOADS_DIR
};
