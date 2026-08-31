const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const DB_DIR = path.join(__dirname, 'db');

// Ensure db directory exists (for local file system operations or legacy backups)
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// MongoDB configurations
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'bank_guarantee_db';

let dbInstance = null;
let clientInstance = null;

async function getDb() {
  if (dbInstance) return dbInstance;
  clientInstance = new MongoClient(MONGO_URI);
  await clientInstance.connect();
  dbInstance = clientInstance.db(DB_NAME);
  console.log('Connected to MongoDB successfully');
  return dbInstance;
}

async function initializeDb() {
  try {
    const db = await getDb();
    console.log('Checking database status for automatic migration & seeding...');

    // Seed default users if the MongoDB collection is empty
    const usersCount = await db.collection('users').countDocuments();
    if (usersCount === 0) {
      const defaultUsers = [
        {
          username: 'shubham_kothari',
          password: 'nyati#2026',
          name: 'Shubham Kothari',
          email: 'shubham.kothari@nyatigroup.com',
          role: 'Finance Manager'
        }
      ];
      await db.collection('users').insertMany(defaultUsers);
      console.log('Successfully seeded default user accounts into MongoDB.');
    } else {
      console.log(`MongoDB 'users' collection already contains ${usersCount} documents.`);
    }

    // Migrate requests if the MongoDB collection is empty
    const requestsCount = await db.collection('requests').countDocuments();
    if (requestsCount === 0) {
      const filePath = path.join(DB_DIR, 'requests.json');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content || '[]');
        if (data.length > 0) {
          await db.collection('requests').insertMany(data);
          console.log(`Successfully migrated ${data.length} requests from JSON file to MongoDB.`);
        }
      }
    } else {
      console.log(`MongoDB 'requests' collection already contains ${requestsCount} documents.`);
    }

    // Migrate register if the MongoDB collection is empty
    const registerCount = await db.collection('register').countDocuments();
    if (registerCount === 0) {
      const filePath = path.join(DB_DIR, 'register.json');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content || '[]');
        if (data.length > 0) {
          await db.collection('register').insertMany(data);
          console.log(`Successfully migrated ${data.length} register entries from JSON file to MongoDB.`);
        }
      }
    } else {
      console.log(`MongoDB 'register' collection already contains ${registerCount} documents.`);
    }

    console.log('Database initialization completed.');
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
}

function readJsonFile(collection) {
  const filePath = path.join(DB_DIR, `${collection}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data || '[]');
  } catch (e) {
    return [];
  }
}

function writeJsonFile(collection, data) {
  const filePath = path.join(DB_DIR, `${collection}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

async function readData(collection) {
  try {
    const db = await getDb();
    const result = await db.collection(collection).find({}, { projection: { _id: 0 } }).toArray();
    writeJsonFile(collection, result);
    return result;
  } catch (error) {
    console.error(`Error reading ${collection} from MongoDB, falling back to JSON:`, error.message);
    return readJsonFile(collection);
  }
}

async function findOne(collection, query) {
  try {
    const db = await getDb();
    return await db.collection(collection).findOne(query, { projection: { _id: 0 } });
  } catch (error) {
    console.error(`Error finding document in ${collection}:`, error.message);
    const data = readJsonFile(collection);
    return data.find(item => {
      for (const k in query) {
        if (query[k] && typeof query[k] === 'object' && query[k].$or) {
          return query[k].$or.some(sub => item[sub.username] === sub.username || item[sub.email] === sub.email);
        }
        if (item[k] !== query[k]) return false;
      }
      return true;
    }) || null;
  }
}

async function insertDocument(collection, document) {
  try {
    const db = await getDb();
    const docToInsert = { ...document };
    delete docToInsert._id;
    await db.collection(collection).insertOne(docToInsert);
  } catch (error) {
    console.error(`Error inserting document into ${collection} MongoDB:`, error.message);
  }
  const currentData = readJsonFile(collection);
  currentData.push(document);
  writeJsonFile(collection, currentData);
  return true;
}

async function updateDocument(collection, query, updatedFields) {
  try {
    const db = await getDb();
    const fieldsToUpdate = { ...updatedFields };
    delete fieldsToUpdate._id;
    await db.collection(collection).updateOne(query, { $set: fieldsToUpdate });
  } catch (error) {
    console.error(`Error updating document in ${collection} MongoDB:`, error.message);
  }
  const currentData = readJsonFile(collection);
  const updatedData = currentData.map(item => {
    let match = true;
    for (const k in query) {
      if (item[k] !== query[k]) match = false;
    }
    return match ? { ...item, ...updatedFields } : item;
  });
  writeJsonFile(collection, updatedData);
  return true;
}

async function deleteDocument(collection, query) {
  try {
    const db = await getDb();
    await db.collection(collection).deleteOne(query);
  } catch (error) {
    console.error(`Error deleting document from ${collection} MongoDB:`, error.message);
  }
  const currentData = readJsonFile(collection);
  const filtered = currentData.filter(item => {
    for (const k in query) {
      if (item[k] === query[k]) return false;
    }
    return true;
  });
  writeJsonFile(collection, filtered);
  return true;
}

async function generateId(collection, prefix) {
  try {
    const db = await getDb();
    const year = new Date().getFullYear();
    const pattern = new RegExp(`^${prefix}-${year}-(\\d{4})$`);

    // Only project the 'id' field for memory efficiency
    const docs = await db.collection(collection)
      .find({ id: { $regex: `^${prefix}-${year}-` } })
      .project({ id: 1, _id: 0 })
      .toArray();

    let count = 1;
    if (docs.length > 0) {
      const yearsCounts = docs
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
  } catch (error) {
    console.error(`Error generating ID for ${collection}:`, error);
    // Fallback to random count or local logic in case of DB failure
    const randomCount = Math.floor(Math.random() * 10000);
    return `${prefix}-${new Date().getFullYear()}-${String(randomCount).padStart(4, '0')}`;
  }
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
  initializeDb,
  readData,
  findOne,
  insertDocument,
  updateDocument,
  deleteDocument,
  generateId,
  saveAttachment,
  UPLOADS_DIR
};
